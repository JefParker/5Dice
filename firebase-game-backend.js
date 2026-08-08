import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, get, child, remove, push, onChildAdded, onValue, onDisconnect, serverTimestamp, query, limitToLast, orderByChild, endAt, update, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, signInAnonymously, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

// Anonymous auth with failure tracking. A failed sign-in used to be swallowed
// into a resolved promise, so every method proceeded unauthenticated and then
// failed (often silently) on permission errors. Now we record the failure and
// let callers retry / bail.
let authError = null;

async function ensureAuth() {
  try {
    // Wait for a persisted session before minting an anonymous one. The admin
    // dashboard signs in with email/password, and Firebase restores that
    // session on reload — calling signInAnonymously() unconditionally would
    // replace it with a fresh anonymous user and silently sign the admin out
    // every time the page loaded.
    const existing = await new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, (u) => { unsub(); resolve(u); },
        () => resolve(null));
    });
    if (!existing) await signInAnonymously(auth);
    authError = null;
  } catch (err) {
    authError = err;
    console.error("Anonymous auth failed:", err);
  }
}

let authPromise = ensureAuth();

// Await auth and retry once if it failed. Returns true when authenticated.
async function requireAuth() {
  await authPromise;
  if (authError) {
    authPromise = ensureAuth();
    await authPromise;
  }
  if (window.firebaseGameBackend) window.firebaseGameBackend.authError = authError;
  return !authError;
}

let roomsUnsubscribe = null;
let connectedUnsubscribe = null;

// A lobby room nobody has entered for this long is deleted. There is no server
// cron, so clients sweep: on lobby start, on room creation, and periodically
// while the lobby is open. The throttle keeps several clients doing it at once
// from turning into a pile of redundant reads.
const ROOM_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const CLEANUP_THROTTLE_MS = 30 * 60 * 1000;
let lastCleanupAt = 0;
let chatUnsubscribe = null;
let gameStateUnsubscribe = null;
let gameEventsUnsubscribe = null;

// Generation counters for the game listeners. listenGameState/listenGameEvents
// await async work (auth, serverTimeOffset) before subscribing; if the user
// leaves the room during that window, stopGameListeners() has nothing to cancel
// yet and the late subscription would live forever. Every stop/start bumps the
// generation, and a pending listen that comes back to find a different
// generation simply doesn't subscribe. One counter per listener so starting
// one doesn't invalidate the other's in-flight start.
let gameStateGeneration = 0;
let gameEventsGeneration = 0;

// Voice signaling listener handles (same stale-start guard as the game
// listeners — one generation counter PER listener, or starting one would
// cancel the other's in-flight start).
let voiceMembersUnsubscribe = null;
let voiceSignalsUnsubscribe = null;
let voiceMembersGeneration = 0;
let voiceSignalsGeneration = 0;

// Read the client<->server clock offset once (the .info path is synthetic and
// must be read with a listener, not get()). Falls back to 0 after 3s.
function getServerTimeOffset() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      onValue(ref(db, '.info/serverTimeOffset'), (snap) => finish(snap.val() || 0), { onlyOnce: true });
    } catch (e) { finish(0); }
    setTimeout(() => finish(0), 3000);
  });
}

window.firebaseGameBackend = {
  isConnected: false,
  authPromise: authPromise,

  init: async (onStatusChange) => {
    if (!(await requireAuth())) return;
    // init() runs again every time the lobby restarts (e.g. leaving Settings);
    // drop the previous connection listener so they don't pile up.
    if (connectedUnsubscribe) connectedUnsubscribe();
    const connectedRef = ref(db, ".info/connected");
    connectedUnsubscribe = onValue(connectedRef, (snap) => {
      window.firebaseGameBackend.isConnected = snap.val() === true;
      if (typeof onStatusChange === 'function') {
        onStatusChange(window.firebaseGameBackend.isConnected);
      }
      if (typeof window.updateDiagnostics === 'function') {
        window.updateDiagnostics();
      }
    });
  },

  // --- LOBBY ROOMS ---
  listenRooms: async (onRoomsCallback) => {
    if (!(await requireAuth())) return;
    if (roomsUnsubscribe) roomsUnsubscribe();
    const roomsRef = ref(db, "lobby/rooms");
    roomsUnsubscribe = onValue(roomsRef, (snapshot) => {
      const rooms = snapshot.val() || {};
      onRoomsCallback(rooms);
    });
    return roomsUnsubscribe;
  },

  createRoom: async (room) => {
    // Throw instead of silently no-opping so the caller's try/catch can show an
    // error and dismiss the loading overlay instead of leaving a phantom room.
    if (!(await requireAuth())) throw (authError || new Error('Not authenticated'));
    if (!room || !room.id) throw new Error('Invalid room');
    const roomRef = ref(db, `lobby/rooms/${room.id}`);
    await set(roomRef, {
      ...room,
      lastActive: Date.now()
    });

    // Cleanup old rooms (>48h idle). Awaited so a rejection can't become an
    // unhandled promise rejection; runs after the fresh lastActive write above.
    await window.firebaseGameBackend.cleanupOldRooms().catch(() => {});
  },

  updateRoom: async (roomId, updates) => {
    if (!(await requireAuth())) return;
    if (!roomId) return;
    const roomRef = ref(db, `lobby/rooms/${roomId}`);
    await update(roomRef, {
      ...updates,
      lastActive: Date.now()
    });
  },

  deleteRoom: async (roomId) => {
    if (!(await requireAuth())) return;
    if (!roomId) return;
    await remove(ref(db, `lobby/rooms/${roomId}`));
    await remove(ref(db, `games/${roomId}`));
    await remove(ref(db, `gameEvents/${roomId}`)).catch(() => {});
    await remove(ref(db, `voice/${roomId}`)).catch(() => {});
  },

  // Atomically add/refresh a player in a room. Uses a transaction so two people
  // joining the same room at once can't clobber each other (the old read-modify-write
  // of a cached array was last-writer-wins). Returns a result object describing the
  // outcome so the caller can distinguish full/gone/error from success.
  addPlayerToRoom: async (roomId, player, maxPlayersHint) => {
    if (!(await requireAuth())) return { ok: false, reason: 'auth' };
    if (!roomId || !player) return { ok: false, reason: 'error' };
    const roomRef = ref(db, `lobby/rooms/${roomId}`);
    try {
      let reason = null;
      let oldPeerId = null;
      const result = await runTransaction(roomRef, (room) => {
        if (!room) { reason = 'gone'; return room; }
        reason = null; oldPeerId = null; // the callback can re-run; start clean
        // Trust the room the transaction just read, not the caller's cached
        // lobby snapshot: the host may have locked the roster ("Start now")
        // or changed maxPlayers since the caller last looked.
        const maxPlayers = room.maxPlayers || maxPlayersHint || 2;
        const players = Array.isArray(room.players) ? room.players.slice() : [];
        const idx = players.findIndex(p => p && (p.uuid === player.uuid || p.peerId === player.peerId));
        if (idx >= 0) {
          // Reconnect: refresh this player's entry. A different stored peerId
          // means the same person arriving on a new device (their uuid is
          // synced; peerIds are per-device) — remember the old id so the
          // caller can migrate peerId-keyed game state to the new one, and
          // keep the room's host field pointing at the person, not the
          // abandoned device.
          if (players[idx].peerId && players[idx].peerId !== player.peerId) {
            oldPeerId = players[idx].peerId;
            if (room.host === oldPeerId) room.host = player.peerId;
          }
          players[idx] = player;
        } else {
          // New joiner: rejected if the room is full or already underway.
          if (room.status === 'in-progress') { reason = 'full'; return; }
          if (players.length >= maxPlayers) { reason = 'full'; return; }
          players.push(player);
        }
        room.players = players;
        room.lastActive = Date.now();
        if (players.length >= maxPlayers) room.status = 'in-progress';
        else if (!room.status) room.status = 'open';
        return room;
      });
      if (result && result.committed && result.snapshot && result.snapshot.exists()) {
        const val = result.snapshot.val();
        return { ok: true, players: val.players || [], status: val.status || 'open', oldPeerId: oldPeerId };
      }
      return { ok: false, reason: reason || 'gone' };
    } catch (e) {
      console.error('addPlayerToRoom transaction failed:', e);
      return { ok: false, reason: 'error' };
    }
  },

  // Re-key games/{roomId} after a device switch. The player's uuid is stable
  // across devices, but everything inside the game node — host, whose turn it
  // is, the 5 Dice turn-order anchor and score columns, the win/tie tallies —
  // is keyed by peerId, which each device mints for itself. Without this, a
  // player who resumes on another device finds the turn pointing at a device
  // that no longer exists and their score column stranded under the old id.
  migrateGamePeerId: async (roomId, oldPeerId, newPeerId) => {
    if (!(await requireAuth())) return;
    if (!roomId || !oldPeerId || !newPeerId || oldPeerId === newPeerId) return;
    const swap = (v) => (v === oldPeerId ? newPeerId : v);
    const swapKey = (obj) => {
      if (!obj || typeof obj !== 'object' || !(oldPeerId in obj)) return obj;
      const moved = obj[oldPeerId];
      const out = {};
      for (const k in obj) { if (k !== oldPeerId) out[k] = obj[k]; }
      if (typeof moved === 'number' && typeof out[newPeerId] === 'number') {
        out[newPeerId] += moved; // win/tie tallies from both device ids combine
      } else {
        // Score columns: the migrated column is the real one — anything already
        // under the new id is at most a just-created empty sheet.
        out[newPeerId] = moved;
      }
      return out;
    };
    try {
      await runTransaction(ref(db, `games/${roomId}`), (game) => {
        if (!game) return game;
        // Touch only fields that exist: the RTDB rejects a transaction result
        // containing `undefined` anywhere (e.g. assigning back swapKey(missing)).
        if (game.host !== undefined) game.host = swap(game.host);
        if (game.currentTurnPlayerId !== undefined) game.currentTurnPlayerId = swap(game.currentTurnPlayerId);
        if (Array.isArray(game.players)) {
          for (const p of game.players) {
            if (p && p.peerId === oldPeerId) p.peerId = newPeerId;
          }
        }
        const fd = game.fiveDiceState;
        if (fd) {
          if (fd.firstTurn !== undefined) fd.firstTurn = swap(fd.firstTurn);
          if (fd.scores) fd.scores = swapKey(fd.scores);
        }
        if (game.wins) game.wins = swapKey(game.wins);
        if (game.ties) game.ties = swapKey(game.ties);
        return game;
      });
    } catch (e) {
      console.error('migrateGamePeerId transaction failed:', e);
    }
  },

  // Atomically remove a player from a lobby room, migrating the host (including
  // hostUuid) if the departing player was hosting, and deleting the room + game
  // when it empties. A transaction, so it works even when the caller's lobby
  // cache hasn't arrived, and it can never resurrect an already-deleted room.
  // Returns { ok, removed, players, deleted }.
  removePlayerFromRoom: async (roomId, player) => {
    if (!(await requireAuth())) return { ok: false, reason: 'auth' };
    if (!roomId || !player) return { ok: false, reason: 'error' };
    const roomRef = ref(db, `lobby/rooms/${roomId}`);
    try {
      const result = await runTransaction(roomRef, (room) => {
        if (!room) return room; // already gone — nothing to do, don't recreate
        const players = (Array.isArray(room.players) ? room.players : [])
          .filter(p => p && p.peerId !== player.peerId && p.uuid !== player.uuid);
        if (players.length === 0) return null; // last player out → delete the room
        room.players = players;
        room.lastActive = Date.now();
        if (room.host === player.peerId || room.hostUuid === player.uuid) {
          const newHost = players[0];
          room.host = newHost.peerId;
          room.hostUuid = newHost.uuid || null;
          room.hostName = newHost.name || '';
          room.hostColor = newHost.color || null;
        }
        return room;
      });
      const exists = result && result.snapshot && result.snapshot.exists();
      if (!exists) {
        // Room deleted (or never existed): drop the game state too.
        await remove(ref(db, `games/${roomId}`)).catch(() => {});
        await remove(ref(db, `gameEvents/${roomId}`)).catch(() => {});
        return { ok: true, removed: true, players: [], deleted: true };
      }
      const val = result.snapshot.val();
      return { ok: true, removed: true, players: val.players || [], deleted: false, host: val.host };
    } catch (e) {
      console.error('removePlayerFromRoom transaction failed:', e);
      return { ok: false, reason: 'error' };
    }
  },

  // Merge a player roster into games/{roomId}.players atomically. Joiners used
  // to mirror their own lobby snapshot with a plain last-writer-wins update, so
  // two people joining within a few hundred ms could erase each other from the
  // game roster. The union keeps everyone.
  // Returns { peerSwaps: [{oldPeerId, newPeerId}] } — one entry per roster slot
  // whose uuid matched an incoming player but whose stored peerId differed
  // (that person moved to a new device). The caller feeds these to
  // migrateGamePeerId; detecting it HERE as well as in addPlayerToRoom means a
  // migration that was lost mid-join (tab closed, network drop) heals on the
  // next join instead of orphaning the game state forever.
  syncGamePlayers: async (roomId, players) => {
    if (!(await requireAuth())) return { peerSwaps: [] };
    if (!roomId || !Array.isArray(players)) return { peerSwaps: [] };
    let peerSwaps = [];
    try {
      await runTransaction(ref(db, `games/${roomId}/players`), (cur) => {
        peerSwaps = []; // the callback can re-run; start clean
        const merged = Array.isArray(cur) ? cur.slice() : [];
        for (const p of players) {
          if (!p) continue;
          const idx = merged.findIndex(m => m && (m.uuid === p.uuid || m.peerId === p.peerId));
          if (idx >= 0) {
            if (merged[idx].peerId && p.peerId && merged[idx].uuid === p.uuid &&
                merged[idx].peerId !== p.peerId) {
              peerSwaps.push({ oldPeerId: merged[idx].peerId, newPeerId: p.peerId });
            }
            merged[idx] = p;
          }
          else merged.push(p);
        }
        return merged;
      });
    } catch (e) {
      console.error('syncGamePlayers transaction failed:', e);
    }
    return { peerSwaps };
  },

  // Overwrite games/{roomId}.players exactly (used when a player leaves and the
  // roster must shrink — the merge above only ever grows it).
  setGamePlayers: async (roomId, players) => {
    if (!(await requireAuth())) return;
    if (!roomId) return;
    await set(ref(db, `games/${roomId}/players`), players || []);
  },

  // Delete lobby rooms nobody has entered in 48 hours. lastActive is refreshed
  // whenever the room is created, updated, or someone joins, so it tracks
  // exactly "when did anyone last go in here".
  // Pass { force: true } to bypass the throttle.
  cleanupOldRooms: async ({ force = false } = {}) => {
    if (!(await requireAuth())) return;

    const now = Date.now();
    if (!force && (now - lastCleanupAt) < CLEANUP_THROTTLE_MS) return;
    lastCleanupAt = now;

    // Judge staleness against the SERVER clock, not the local device clock: a
    // device whose clock runs months ahead would otherwise compute a future
    // cutoff and delete every room in the lobby, active ones included.
    const serverNow = Date.now() + (await getServerTimeOffset());
    const cutoff = serverNow - ROOM_MAX_AGE_MS;
    const roomsRef = ref(db, 'lobby/rooms');
    try {
      // Query only the stale slice (plus rooms with no lastActive at all, which
      // sort before any number) instead of downloading the whole lobby.
      const staleQuery = query(roomsRef, orderByChild('lastActive'), endAt(cutoff));
      const snapshot = await get(staleQuery);
      if (!snapshot.exists()) return;

      const rooms = snapshot.val();
      const stale = Object.keys(rooms);
      if (stale.length === 0) return;

      const updates = {};
      stale.forEach(id => { updates[id] = null; });
      await update(roomsRef, updates);

      // Drop the matching game state too — deleteRoom removes both, and without
      // this the games/ node accumulates orphans forever.
      await Promise.all(
        stale.map(id => Promise.all([
          remove(ref(db, `games/${id}`)).catch(() => {}),
          remove(ref(db, `gameEvents/${id}`)).catch(() => {}),
          remove(ref(db, `voice/${id}`)).catch(() => {})
        ]))
      );

      console.log(`Cleaned up ${stale.length} stale room(s).`);
    } catch (e) {
      console.error("Error cleaning up old rooms:", e);
    }
  },

  // --- LOBBY CHAT ---
  listenLobbyChat: async (onChatCallback) => {
    if (!(await requireAuth())) return;
    if (chatUnsubscribe) chatUnsubscribe();
    const chatRef = ref(db, "lobby/chats");
    const q = query(chatRef, limitToLast(30));
    chatUnsubscribe = onChildAdded(q, (snapshot) => {
      const msg = snapshot.val();
      if (msg) onChatCallback(msg);
    });
    return chatUnsubscribe;
  },

  sendLobbyChat: async (chatMsg) => {
    if (!(await requireAuth())) return;
    const chatRef = ref(db, "lobby/chats");
    const newMsgRef = push(chatRef);
    await set(newMsgRef, chatMsg);
  },

  // --- GAME SESSION ---
  initGameSession: async (roomId, initialGameData) => {
    // Throws on auth failure so createRoom's caller can surface the error.
    if (!(await requireAuth())) throw (authError || new Error('Not authenticated'));
    if (!roomId) throw new Error('Invalid room');
    const gameRef = ref(db, `games/${roomId}`);
    await set(gameRef, {
      ...initialGameData,
      lastUpdated: Date.now()
    });
  },

  updateGameState: async (roomId, stateUpdates) => {
    if (!(await requireAuth())) throw (authError || new Error('Not authenticated'));
    if (!roomId) return;
    const gameRef = ref(db, `games/${roomId}`);
    await update(gameRef, {
      ...stateUpdates,
      lastUpdated: Date.now()
    });
  },

  listenGameState: async (roomId, onStateCallback) => {
    const myGeneration = ++gameStateGeneration;
    if (!(await requireAuth())) return;
    if (!roomId) return;
    if (myGeneration !== gameStateGeneration) return; // stopped/superseded while awaiting
    if (gameStateUnsubscribe) gameStateUnsubscribe();
    const gameRef = ref(db, `games/${roomId}`);
    gameStateUnsubscribe = onValue(gameRef, (snapshot) => {
      const gameData = snapshot.val();
      if (gameData) onStateCallback(gameData);
    });
    return gameStateUnsubscribe;
  },

  // --- REAL-TIME GAME EVENTS (Dice Roll, Hold, Score Actions) ---
  // Atomically bump a player's win/tie count for the room (persists across games).
  incrementWin: async (roomId, playerId) => {
    if (!(await requireAuth())) return;
    if (!roomId || !playerId) return;
    try {
      await runTransaction(ref(db, `games/${roomId}/wins/${playerId}`), (cur) => (typeof cur === 'number' ? cur : 0) + 1);
    } catch (e) {
      console.error('incrementWin failed:', e);
    }
  },
  incrementTie: async (roomId, playerId) => {
    if (!(await requireAuth())) return;
    if (!roomId || !playerId) return;
    try {
      await runTransaction(ref(db, `games/${roomId}/ties/${playerId}`), (cur) => (typeof cur === 'number' ? cur : 0) + 1);
    } catch (e) {
      console.error('incrementTie failed:', e);
    }
  },

  // Events live under gameEvents/{roomId}, NOT inside games/{roomId}: the state
  // listener sits on the whole games/{roomId} node, and when events lived under
  // it every pushed event re-delivered the entire game node (including the whole
  // event history) to every client — twice the downloads per action, growing
  // without bound over a long-lived room.
  sendGameEvent: async (roomId, eventObj) => {
    if (!(await requireAuth())) throw (authError || new Error('Not authenticated'));
    if (!roomId) return;
    const eventsRef = ref(db, `gameEvents/${roomId}`);
    const newEvtRef = push(eventsRef);
    await set(newEvtRef, {
      ...eventObj,
      // Server clock, so the listener's freshness filter compares like-for-like
      // across devices instead of trusting the sender's (possibly skewed) clock.
      timestamp: serverTimestamp()
    });
  },

  listenGameEvents: async (roomId, onEventCallback) => {
    const myGeneration = ++gameEventsGeneration;
    if (!(await requireAuth())) return;
    if (!roomId) return;
    const eventsRef = ref(db, `gameEvents/${roomId}`);

    // Events are stamped with serverTimestamp() (server clock). Compare against the
    // SERVER's "now" (Date.now() + offset).
    let serverTimeOffset = 0;
    try {
      serverTimeOffset = await getServerTimeOffset();
    } catch (e) {
      console.error("Failed to read serverTimeOffset, falling back to local clock:", e);
    }
    // If the user left the room (or joined another) while we were waiting on
    // auth/offset, do NOT subscribe — the old code registered anyway and the
    // orphaned listener fed this room's events to the client forever.
    if (myGeneration !== gameEventsGeneration) return;
    if (gameEventsUnsubscribe) gameEventsUnsubscribe();
    const startTime = Date.now() + serverTimeOffset;

    const q = query(eventsRef, limitToLast(10));
    gameEventsUnsubscribe = onChildAdded(q, (snapshot) => {
      const evt = snapshot.val();
      // Allow events with no timestamp yet (serverTimestamp resolves async) and
      // any event newer than ~5s before we joined.
      if (evt && (!evt.timestamp || evt.timestamp >= startTime - 5000)) {
        onEventCallback(evt);
      }
    });
    return gameEventsUnsubscribe;
  },

  // --- VOICE CHAT SIGNALING (WebRTC mesh) ---
  // Everything lives under voice/{roomId}: `members/{peerId}` advertises who is
  // in the voice mesh and their mic/speaker state (with onDisconnect cleanup),
  // and `signals/{peerId}` is each peer's inbox for SDP/ICE messages, which the
  // receiver deletes after processing.

  voiceJoin: async (roomId, peerId, state) => {
    if (!(await requireAuth())) throw (authError || new Error('Not authenticated'));
    if (!roomId || !peerId) return;
    const mRef = ref(db, `voice/${roomId}/members/${peerId}`);
    // Arm removal first so a crash right after the write is still cleaned up.
    await onDisconnect(mRef).remove();
    await onDisconnect(ref(db, `voice/${roomId}/signals/${peerId}`)).remove();
    await set(mRef, {
      peerId: peerId,
      name: state.name || '',
      mic: !!state.mic,
      speaker: !!state.speaker
    });
  },

  voiceUpdateState: async (roomId, peerId, state) => {
    if (!(await requireAuth())) return;
    if (!roomId || !peerId) return;
    await update(ref(db, `voice/${roomId}/members/${peerId}`), {
      mic: !!state.mic,
      speaker: !!state.speaker
    });
  },

  voiceLeave: async (roomId, peerId) => {
    if (!(await requireAuth())) return;
    if (!roomId || !peerId) return;
    await remove(ref(db, `voice/${roomId}/members/${peerId}`)).catch(() => {});
    await remove(ref(db, `voice/${roomId}/signals/${peerId}`)).catch(() => {});
  },

  listenVoiceMembers: async (roomId, onMembers) => {
    const myGeneration = ++voiceMembersGeneration;
    if (!(await requireAuth())) return;
    if (!roomId || myGeneration !== voiceMembersGeneration) return;
    if (voiceMembersUnsubscribe) voiceMembersUnsubscribe();
    voiceMembersUnsubscribe = onValue(ref(db, `voice/${roomId}/members`), (snap) => {
      onMembers(snap.val() || {});
    });
  },

  // Listen to my signal inbox. Each signal is handed to the callback and then
  // deleted, so nothing is replayed on reconnect.
  listenVoiceSignals: async (roomId, myPeerId, onSignal) => {
    const myGeneration = ++voiceSignalsGeneration;
    if (!(await requireAuth())) return;
    if (!roomId || !myPeerId || myGeneration !== voiceSignalsGeneration) return;
    if (voiceSignalsUnsubscribe) voiceSignalsUnsubscribe();
    const inboxRef = ref(db, `voice/${roomId}/signals/${myPeerId}`);
    voiceSignalsUnsubscribe = onChildAdded(inboxRef, (snap) => {
      const val = snap.val();
      remove(snap.ref).catch(() => {});
      if (val && val.from && val.data) onSignal(val);
    });
  },

  sendVoiceSignal: async (roomId, toPeerId, fromPeerId, dataStr) => {
    if (!(await requireAuth())) return;
    if (!roomId || !toPeerId) return;
    const inboxRef = ref(db, `voice/${roomId}/signals/${toPeerId}`);
    await set(push(inboxRef), { from: fromPeerId, data: dataStr });
  },

  stopVoiceListeners: () => {
    voiceMembersGeneration++;
    voiceSignalsGeneration++;
    if (voiceMembersUnsubscribe) { voiceMembersUnsubscribe(); voiceMembersUnsubscribe = null; }
    if (voiceSignalsUnsubscribe) { voiceSignalsUnsubscribe(); voiceSignalsUnsubscribe = null; }
  },

  stopGameListeners: () => {
    // Invalidate any listen calls still in flight (see the generation counters).
    gameStateGeneration++;
    gameEventsGeneration++;
    if (gameStateUnsubscribe) {
      gameStateUnsubscribe();
      gameStateUnsubscribe = null;
    }
    if (gameEventsUnsubscribe) {
      gameEventsUnsubscribe();
      gameEventsUnsubscribe = null;
    }
  },

  // -------------------------------------------------------------------------
  // Admin dashboard
  //
  // "Admin" means signed in with email/password. Players sign in anonymously
  // and their token carries no email, so `auth.token.email != null` in the
  // security rules distinguishes the two without hard-coding an address.
  // -------------------------------------------------------------------------

  // Resolves once the initial sign-in (restored session or fresh anonymous)
  // has settled, so callers can ask isAdmin() and get a real answer.
  whenAuthReady: async () => { await authPromise; },

  isAdmin: () => !!(auth.currentUser && auth.currentUser.email),

  adminEmail: () => (auth.currentUser && auth.currentUser.email) || null,

  adminSignIn: async (email, password) => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      authError = null;
      return { ok: true };
    } catch (err) {
      // Firebase returns distinct codes, but for a login box they all mean the
      // same thing to the user; only the network case is worth separating.
      const net = err && err.code === 'auth/network-request-failed';
      return { ok: false, reason: net ? 'network' : 'credentials', code: err && err.code };
    }
  },

  // Drop admin rights and go back to being an ordinary anonymous player, so
  // gameplay continues to work in the same tab.
  adminSignOut: async () => {
    try {
      await signOut(auth);
    } catch (e) {
      console.error('adminSignOut failed:', e);
    }
    authPromise = ensureAuth();
    await authPromise;
  },

  // Whole-tree read. Only succeeds for an email-authenticated admin: the root
  // read rule requires a token with an email claim.
  fetchAllData: async () => {
    if (!(await requireAuth())) return null;
    try {
      const snap = await get(ref(db, '/'));
      return snap.exists() ? snap.val() : {};
    } catch (e) {
      console.error('fetchAllData failed:', e);
      return null;
    }
  },

  // Delete one lobby room and everything hanging off it.
  deleteRoomCompletely: async (roomId) => {
    if (!(await requireAuth())) return { ok: false };
    if (!roomId) return { ok: false };
    try {
      await Promise.all([
        remove(ref(db, `lobby/rooms/${roomId}`)).catch(() => {}),
        remove(ref(db, `games/${roomId}`)).catch(() => {}),
        remove(ref(db, `gameEvents/${roomId}`)).catch(() => {})
      ]);
      await clearVoiceRoom(roomId);
      return { ok: true };
    } catch (e) {
      console.error('deleteRoomCompletely failed:', e);
      return { ok: false };
    }
  },

  // Delete a single Score Sheet room (the /rooms tree the Score app owns).
  deleteScoreRoom: async (roomId) => {
    if (!(await requireAuth())) return { ok: false };
    if (!roomId) return { ok: false };
    try {
      await remove(ref(db, `rooms/${roomId}`));
      return { ok: true };
    } catch (e) {
      console.error('deleteScoreRoom failed:', e);
      return { ok: false };
    }
  },

  // Wipe everything: game rooms, their events, the lobby and its chat, voice
  // signaling, and the Score Sheet's own /rooms tree.
  //
  // Deliberately child-by-child rather than remove('/'): the rules grant writes
  // per room and never at a node root, precisely so no single request can flatten
  // the database. That protection applies to the admin too, so this walks the
  // children it is allowed to delete.
  clearAllDatabases: async () => {
    if (!(await requireAuth())) return { ok: false, reason: 'auth' };
    const counts = { games: 0, gameEvents: 0, lobbyRooms: 0, chats: 0, scoreRooms: 0, voiceRooms: 0 };
    const failures = [];
    const childKeys = async (path) => {
      try {
        const snap = await get(ref(db, path));
        if (!snap.exists()) return [];
        const v = snap.val();
        return (v && typeof v === 'object') ? Object.keys(v) : [];
      } catch (e) {
        failures.push(path);
        return [];
      }
    };
    const wipe = async (basePath, countKey) => {
      const keys = await childKeys(basePath);
      for (const k of keys) {
        try {
          await remove(ref(db, `${basePath}/${k}`));
          counts[countKey]++;
        } catch (e) {
          failures.push(`${basePath}/${k}`);
        }
      }
    };

    await wipe('games', 'games');
    await wipe('gameEvents', 'gameEvents');
    await wipe('lobby/rooms', 'lobbyRooms');
    await wipe('lobby/chats', 'chats');
    await wipe('rooms', 'scoreRooms');

    // Voice grants writes only at members/$peerId and signals/$peerId, so the
    // room node itself can't be removed in one call — empty it instead and the
    // parent disappears with its last child.
    for (const roomId of await childKeys('voice')) {
      await clearVoiceRoom(roomId);
      counts.voiceRooms++;
    }

    return { ok: failures.length === 0, counts, failures };
  }
};

// Empty voice/{roomId} the only way the rules allow: one member and one signal
// inbox at a time.
async function clearVoiceRoom(roomId) {
  const kids = async (path) => {
    try {
      const snap = await get(ref(db, path));
      return snap.exists() && snap.val() && typeof snap.val() === 'object'
        ? Object.keys(snap.val()) : [];
    } catch (e) { return []; }
  };
  for (const peerId of await kids(`voice/${roomId}/members`)) {
    await remove(ref(db, `voice/${roomId}/members/${peerId}`)).catch(() => {});
  }
  for (const peerId of await kids(`voice/${roomId}/signals`)) {
    await remove(ref(db, `voice/${roomId}/signals/${peerId}`)).catch(() => {});
  }
}

window.firebaseGameBackend.init();
window.dispatchEvent(new CustomEvent('firebaseGameReady'));
