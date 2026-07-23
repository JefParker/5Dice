import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, get, child, remove, push, onChildAdded, onValue, onDisconnect, serverTimestamp, query, limitToLast, update, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

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
    await signInAnonymously(auth);
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
let chatUnsubscribe = null;
let gameStateUnsubscribe = null;
let gameEventsUnsubscribe = null;

window.firebaseGameBackend = {
  isConnected: false,
  authPromise: authPromise,

  init: async (onStatusChange) => {
    if (!(await requireAuth())) return;
    const connectedRef = ref(db, ".info/connected");
    onValue(connectedRef, (snap) => {
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
    if (!(await requireAuth())) return;
    if (!room || !room.id) return;
    const roomRef = ref(db, `lobby/rooms/${room.id}`);
    await set(roomRef, {
      ...room,
      lastActive: Date.now()
    });

    // Cleanup old rooms (>48h idle). Awaited so a rejection can't become an
    // unhandled promise rejection; runs after the fresh lastActive write above.
    await window.firebaseGameBackend.cleanupOldRooms();
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
  },

  // Atomically add/refresh a player in a room. Uses a transaction so two people
  // joining the same room at once can't clobber each other (the old read-modify-write
  // of a cached array was last-writer-wins). Returns a result object describing the
  // outcome so the caller can distinguish full/gone/error from success.
  addPlayerToRoom: async (roomId, player, maxPlayers) => {
    if (!(await requireAuth())) return { ok: false, reason: 'auth' };
    if (!roomId || !player) return { ok: false, reason: 'error' };
    const roomRef = ref(db, `lobby/rooms/${roomId}`);
    try {
      let reason = null;
      const result = await runTransaction(roomRef, (room) => {
        if (!room) { reason = 'gone'; return room; }
        reason = null;
        const players = Array.isArray(room.players) ? room.players.slice() : [];
        const idx = players.findIndex(p => p && (p.uuid === player.uuid || p.peerId === player.peerId));
        if (idx >= 0) {
          players[idx] = player; // reconnect: refresh this player's entry
        } else {
          if (maxPlayers && players.length >= maxPlayers) { reason = 'full'; return; }
          players.push(player);
        }
        room.players = players;
        room.lastActive = Date.now();
        if (maxPlayers && players.length >= maxPlayers) room.status = 'in-progress';
        else if (!room.status) room.status = 'open';
        return room;
      });
      if (result && result.committed && result.snapshot && result.snapshot.exists()) {
        const val = result.snapshot.val();
        return { ok: true, players: val.players || [], status: val.status || 'open' };
      }
      return { ok: false, reason: reason || 'gone' };
    } catch (e) {
      console.error('addPlayerToRoom transaction failed:', e);
      return { ok: false, reason: 'error' };
    }
  },

  cleanupOldRooms: async () => {
    if (!(await requireAuth())) return;
    const cutoff = Date.now() - (48 * 60 * 60 * 1000);
    const roomsRef = ref(db, 'lobby/rooms');
    try {
      const snapshot = await get(roomsRef);
      if (snapshot.exists()) {
        const rooms = snapshot.val();
        const updates = {};
        for (let id in rooms) {
          if (rooms[id].lastActive && rooms[id].lastActive < cutoff) {
            updates[id] = null;
          }
        }
        if (Object.keys(updates).length > 0) {
          await update(roomsRef, updates);
        }
      }
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
    if (!(await requireAuth())) return;
    if (!roomId) return;
    const gameRef = ref(db, `games/${roomId}`);
    await set(gameRef, {
      ...initialGameData,
      lastUpdated: Date.now()
    });
  },

  updateGameState: async (roomId, stateUpdates) => {
    if (!(await requireAuth())) return;
    if (!roomId) return;
    const gameRef = ref(db, `games/${roomId}`);
    await update(gameRef, {
      ...stateUpdates,
      lastUpdated: Date.now()
    });
  },

  listenGameState: async (roomId, onStateCallback) => {
    if (!(await requireAuth())) return;
    if (gameStateUnsubscribe) gameStateUnsubscribe();
    if (!roomId) return;
    const gameRef = ref(db, `games/${roomId}`);
    gameStateUnsubscribe = onValue(gameRef, (snapshot) => {
      const gameData = snapshot.val();
      if (gameData) onStateCallback(gameData);
    });
    return gameStateUnsubscribe;
  },

  // --- REAL-TIME GAME EVENTS (Dice Roll, Hold, Score Actions) ---
  sendGameEvent: async (roomId, eventObj) => {
    if (!(await requireAuth())) return;
    if (!roomId) return;
    const eventsRef = ref(db, `games/${roomId}/events`);
    const newEvtRef = push(eventsRef);
    await set(newEvtRef, {
      ...eventObj,
      // Server clock, so the listener's freshness filter compares like-for-like
      // across devices instead of trusting the sender's (possibly skewed) clock.
      timestamp: serverTimestamp()
    });
  },

  listenGameEvents: async (roomId, onEventCallback) => {
    if (!(await requireAuth())) return;
    if (gameEventsUnsubscribe) gameEventsUnsubscribe();
    if (!roomId) return;
    const eventsRef = ref(db, `games/${roomId}/events`);

    // Events are stamped with serverTimestamp() (server clock). Compare against the
    // SERVER's "now" (Date.now() + offset), read from the synthetic .info path via a
    // listener (a one-time get() rejects that path as "Invalid token in path").
    let serverTimeOffset = 0;
    try {
      serverTimeOffset = await new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
        try {
          onValue(ref(db, '.info/serverTimeOffset'), (snap) => finish(snap.val() || 0), { onlyOnce: true });
        } catch (e) { finish(0); }
        setTimeout(() => finish(0), 3000);
      });
    } catch (e) {
      console.error("Failed to read serverTimeOffset, falling back to local clock:", e);
    }
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

  stopGameListeners: () => {
    if (gameStateUnsubscribe) {
      gameStateUnsubscribe();
      gameStateUnsubscribe = null;
    }
    if (gameEventsUnsubscribe) {
      gameEventsUnsubscribe();
      gameEventsUnsubscribe = null;
    }
  }
};

window.firebaseGameBackend.init();
window.dispatchEvent(new CustomEvent('firebaseGameReady'));
