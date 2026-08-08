import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, get, child, remove, push, onChildAdded, onValue, onDisconnect, serverTimestamp, query, limitToLast, orderByChild, endAt, update } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged, setPersistence, indexedDBLocalPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
// NOTE: App Check is NOT enforced. The imports were dead weight (imported,
// never initialized) and have been removed. If abuse ever becomes a problem,
// wire initializeAppCheck + ReCaptchaV3Provider here AND enable enforcement in
// the Firebase console — API-key restrictions do NOT restrict RTDB access;
// only security rules and App Check do.

import { firebaseConfig } from "../firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

// --- Anonymous auth with failure tracking -----------------------------------
// Previously a failed sign-in was swallowed into a resolved promise, so every
// method proceeded as if authenticated and then failed with permission errors
// (often silently). We now record the failure and let callers retry instead of
// running unauthenticated.
let authError = null;

// Firebase Auth state is shared across the whole origin, so this module and the
// main app's firebase-game-backend.js are looking at the same session. This used
// to call signInAnonymously() unconditionally, which meant that opening the
// Score Sheet — a menu item on every screen, including the Dashboard's —
// replaced a signed-in admin's session with a fresh anonymous user and logged
// them out. Adopt whatever session already exists; anonymous is only the
// fallback, and an email-authenticated admin satisfies every rule an anonymous
// player does.
async function ensureAuth() {
    try {
        await pinPersistence();
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

// Match the main app: pin the most durable store rather than letting a missing
// IndexedDB silently downgrade the session to tab lifetime.
async function pinPersistence() {
    for (const p of [indexedDBLocalPersistence, browserLocalPersistence]) {
        try {
            await setPersistence(auth, p);
            return;
        } catch (e) { /* try the next one */ }
    }
}

let authPromise = ensureAuth();

// Await auth and, if it failed, retry exactly once. Returns true when
// authenticated, false otherwise, so callers can bail instead of proceeding.
async function requireAuth() {
    await authPromise;
    if (authError) {
        authPromise = ensureAuth();
        await authPromise;
    }
    if (window.firebaseBackend) window.firebaseBackend.authError = authError;
    return !authError;
}

// Presence heartbeat window: a client refreshes its `lastSeen` every ~30s, and any
// entry not seen within this window is treated as gone. Kept comfortably larger than
// the heartbeat interval so a live-but-slightly-late client is never wrongly pruned.
const PRESENCE_STALE_MS = 90000;

// Read the client<->server clock offset. The .info path is synthetic and must be
// read with a listener (onValue), not a one-time get(), which rejects it as an
// "Invalid token in path". Falls back to 0 after 3s so it never blocks joining.
function getServerTimeOffset() {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
        try {
            onValue(ref(db, '.info/serverTimeOffset'), (snap) => finish(snap.val() || 0), { onlyOnce: true });
        } catch (e) {
            finish(0);
        }
        setTimeout(() => finish(0), 3000);
    });
}

// Generation guard for initEvents. It awaits auth, a lastEntered write,
// cleanup, and the server-time offset before subscribing; two overlapping calls
// in that window used to BOTH attach listeners, with the second overwriting
// currentUnsubscribe and orphaning the first set for the whole session (every
// event processed twice). Newest call wins; older calls abort at their next
// checkpoint. stopWebSocket() bumps the generation to cancel an in-flight init.
let initEventsGeneration = 0;

// Safely extract a sheet's dLastUpdate (its "last real change" timestamp) from a
// stored score, which may be a JSON string or an already-parsed object. Returns 0
// when absent/unparseable so a blank or malformed sheet never wins newest-wins.
function parseUpdateTs(score) {
    try {
        const obj = typeof score === "string" ? JSON.parse(score) : score;
        const ts = obj && obj.dLastUpdate;
        return typeof ts === "number" ? ts : 0;
    } catch (e) {
        return 0;
    }
}

window.firebaseBackend = {
    isConnected: false,
    authError: null,

    // Ref to our own presence node, so we can remove it on an explicit leave.
    _presenceRef: null,

    setScore: async (room, player_id, scoreJson) => {
        if (!(await requireAuth())) throw new Error("Not authenticated");

        // Newest-wins guard. Multiple tabs in the same browser share one PlayerID
        // and therefore write to this same node. Without this check, a tab that
        // just opened (and whose sheet is blank or stale) could overwrite an
        // in-progress sheet, and the live onValue listener would then mirror the
        // wipe back to every tab. We compare dLastUpdate and skip the write when
        // the server already holds a newer sheet.
        const incomingTs = parseUpdateTs(scoreJson);
        try {
            const existingSnap = await get(ref(db, `rooms/${room}/scores/${player_id}`));
            if (existingSnap.exists()) {
                const existingTs = parseUpdateTs(existingSnap.val().score);
                // Strictly newer on the server -> keep it, don't clobber.
                if (existingTs > incomingTs) {
                    await set(ref(db, `rooms/${room}/lastEntered`), serverTimestamp());
                    return;
                }
            }
        } catch (e) {
            // If the pre-read fails, fall through to a normal write rather than
            // blocking the player from saving.
            console.error("setScore pre-read failed, writing anyway:", e);
        }

        await set(ref(db, `rooms/${room}/scores/${player_id}`), {
            room: room,
            player_id: player_id,
            score: scoreJson,
            lastdataset: Date.now()
        });
        // Awaited so a failure surfaces instead of becoming an unhandled rejection.
        await set(ref(db, `rooms/${room}/lastEntered`), serverTimestamp());
    },

    getRoomData: async (room) => {
        if (!(await requireAuth())) return JSON.stringify([]);
        const snapshot = await get(ref(db, `rooms/${room}/scores`));
        const arr = [];
        if (snapshot.exists()) {
            const data = snapshot.val();
            for (let pid in data) {
                arr.push(data[pid]);
            }
        }
        return JSON.stringify(arr);
    },

    // getAllRooms() was removed on 2026-08-08 with the "Get Room List" menu item.
    // It read the whole /rooms node and handed every room id and player name to
    // any anonymous visitor, who could then join any of them. Listing rooms is
    // now the admin Dashboard's job. The 48h sweep does not depend on it — it
    // also runs on every room join, below.

    clearRoom: async (room) => {
        if (!(await requireAuth())) return;
        await remove(ref(db, `rooms/${room}/scores`));
    },

    clearTable: async () => {
        if (!(await requireAuth())) return;
        // Delete room-by-room instead of removing the whole `rooms` node: the
        // security rules no longer grant a single write at the tree root (that
        // rule let any anonymous visitor wipe the entire database).
        const snapshot = await get(ref(db, 'rooms'));
        if (!snapshot.exists()) return;
        const updates = {};
        for (let roomId in snapshot.val()) updates[roomId] = null;
        await update(ref(db, 'rooms'), updates);
    },
    currentUnsubscribe: null,

    cleanupOldRooms: async () => {
        if (!(await requireAuth())) return;
        // Judge staleness against the SERVER clock. lastEntered is a
        // serverTimestamp(), and a device whose local clock ran months ahead
        // used to compute a future cutoff and delete every room in the
        // database, active ones included.
        const serverNow = Date.now() + (await getServerTimeOffset());
        const cutoff = serverNow - (48 * 60 * 60 * 1000);
        const roomsRef = ref(db, 'rooms');
        try {
            // Fetch only the stale slice (rooms whose lastEntered <= cutoff,
            // plus rooms with no lastEntered — null sorts first) instead of
            // downloading every room's full scores/presence on every join.
            const staleQuery = query(roomsRef, orderByChild('lastEntered'), endAt(cutoff));
            const snapshot = await get(staleQuery);
            if (snapshot.exists()) {
                const rooms = snapshot.val();
                const updates = {};
                for (let roomId in rooms) {
                    const val = rooms[roomId];
                    if (!val) { updates[roomId] = null; continue; }
                    // A room with people currently connected is never old — no
                    // matter how long ago the last score was entered. (This
                    // guard used to apply only to rooms missing lastEntered, so
                    // an active-but-quiet room could be deleted out from under
                    // its players, permanently blanking their sheets.)
                    if (val.presence && Object.keys(val.presence).length > 0) continue;
                    let isOld = true;
                    if (val.scores) {
                        for (let pid in val.scores) {
                            if (val.scores[pid].lastdataset && val.scores[pid].lastdataset > cutoff) {
                                isOld = false;
                                break;
                            }
                        }
                    }
                    if (isOld) updates[roomId] = null;
                }
                if (Object.keys(updates).length > 0) {
                    await update(roomsRef, updates);
                    console.log("Cleaned up old 48h rooms:", Object.keys(updates));
                }
            }
        } catch (e) {
            console.error("Failed to cleanup old rooms:", e);
        }
    },

    // Cancel any initEvents still in flight (called by stopWebSocket so a
    // half-set-up subscription for the old room can never complete late).
    cancelPendingInit: () => {
        initEventsGeneration++;
    },

    initEvents: async (room, onMessageCallback, selfPresence) => {
        // Newest-call-wins: any older initEvents still awaiting setup aborts at
        // its next checkpoint instead of attaching a duplicate listener set.
        const myGen = ++initEventsGeneration;
        const stale = () => myGen !== initEventsGeneration;

        if (!(await requireAuth())) {
            // Don't pretend we're connected if we couldn't authenticate; the
            // client's CheckConnection() will retry initEvents later.
            window.firebaseBackend.isConnected = false;
            console.error("initEvents aborted: not authenticated.");
            return;
        }
        if (!room || stale()) return;
        window.firebaseBackend.isConnected = true;

        // Mark this room active BEFORE cleanup runs, otherwise the room we just
        // joined (which has no scores yet) can be swept as "old" by cleanupOldRooms().
        try {
            await set(ref(db, `rooms/${room}/lastEntered`), serverTimestamp());
        } catch (e) {
            console.error("Failed to set lastEntered:", e);
        }

        // Clean up any stale rooms (>48h inactive). Awaited so it runs strictly
        // after the lastEntered write above.
        await window.firebaseBackend.cleanupOldRooms();
        if (stale()) return;

        if (window.firebaseBackend.currentUnsubscribe) {
            window.firebaseBackend.currentUnsubscribe();
            window.firebaseBackend.currentUnsubscribe = null;
        }

        const eventsRef = ref(db, `rooms/${room}/events`);
        const scoresRef = ref(db, `rooms/${room}/scores`);
        const presenceRef = ref(db, `rooms/${room}/presence`);

        // Event timestamps are written with serverTimestamp() (server clock), so we must
        // filter against the SERVER's notion of "now", not the local device clock (which
        // may be skewed).
        let serverTimeOffset = 0;
        try {
            serverTimeOffset = await getServerTimeOffset();
        } catch (e) {
            console.error("Failed to read serverTimeOffset, falling back to local clock:", e);
        }
        if (stale()) return;
        const serverStartTime = Date.now() + serverTimeOffset;

        // Only listen to the last 20 events to save bandwidth and ignore deep history
        const q = query(eventsRef, limitToLast(20));
        let unsubEvents = onChildAdded(q, (snapshot) => {
            const val = snapshot.val();
            // Ignore events older than 10 seconds before we joined the room
            if (val && (!val.timestamp || val.timestamp > serverStartTime - 10000)) {
                onMessageCallback(val.jsonData);
            }
        });

        let unsubScores = onValue(scoresRef, (snapshot) => {
            if (snapshot.exists()) {
                const data = snapshot.val();
                const arr = Object.values(data);

                let evt = {
                    Type: "Score",
                    Message: "BCast2Game",
                    Event: "UpdateLeaderBoard",
                    GameID: room,
                    LeaderBoard: JSON.stringify(arr)
                };
                onMessageCallback(JSON.stringify(evt));
            } else {
                let evt = {
                    Type: "Score",
                    Message: "BCast2Game",
                    Event: "UpdateLeaderBoard",
                    GameID: room,
                    LeaderBoard: "[]"
                };
                onMessageCallback(JSON.stringify(evt));
            }
        });

        // Presence: a live view of who is actually connected to the room. This is
        // separate from the scoreboard so that a player who leaves stops being
        // counted as "here" without deleting the scores they entered.
        //
        // Presence is normally removed by onDisconnect(), but that safety net can
        // fail — e.g. a tab whose identity changed (site-data cleared, new
        // PlayerID) orphans its old node, and a hard crash or lost socket may not
        // fire the handler. To keep "who's here" honest we run a heartbeat: each
        // client refreshes its own `lastSeen` periodically.
        //
        // Staleness is judged CLOCK-INDEPENDENTLY: we compare each entry's lastSeen
        // against the NEWEST lastSeen in the room (all server timestamps, compared to
        // each other) rather than against the local clock. This matters because the
        // local clock / serverTimeOffset can be wrong, and an earlier version that
        // compared to Date.now() pruned everyone — including the viewer themselves —
        // whenever the machine clock ran ahead of the server. Since our own heartbeat
        // keeps us the freshest entry, we can never prune ourselves; only entries
        // that have fallen more than PRESENCE_STALE_MS behind the newest are dropped.
        let unsubPresence = onValue(presenceRef, (snapshot) => {
            const raw = snapshot.exists() ? snapshot.val() : {};
            let newestSeen = 0;
            for (let pid in raw) {
                if (!raw[pid]) continue;
                const s = raw[pid].lastSeen || raw[pid].since || 0;
                if (s > newestSeen) newestSeen = s;
            }
            const arr = [];
            for (let pid in raw) {
                const entry = raw[pid];
                if (!entry) continue;
                const seen = entry.lastSeen || entry.since || 0;
                if (newestSeen && seen && (newestSeen - seen) > PRESENCE_STALE_MS) {
                    // Fell too far behind the freshest client: a real ghost. Drop it
                    // from the live list and best-effort delete the dead node.
                    remove(ref(db, `rooms/${room}/presence/${pid}`)).catch(() => {});
                    continue;
                }
                arr.push(entry);
            }
            let evt = {
                Type: "Score",
                Message: "BCast2Game",
                Event: "UpdatePresence",
                GameID: room,
                Presence: JSON.stringify(arr)
            };
            onMessageCallback(JSON.stringify(evt));
        });

        // Publish the unsubscribe handle NOW, before the presence awaits below:
        // if a newer initEvents supersedes this one mid-await, it must be able
        // to tear these listeners down (assigning at the end let a stale call
        // overwrite the newer call's handle and orphan its listeners).
        window.firebaseBackend.currentUnsubscribe = () => {
            if (unsubEvents) unsubEvents();
            if (unsubScores) unsubScores();
            if (unsubPresence) unsubPresence();
        };

        // Register our own presence, and arm automatic removal if we disconnect
        // (tab close, crash, network drop) so stale players never linger.
        if (selfPresence && selfPresence.PlayerID) {
            const selfRef = ref(db, `rooms/${room}/presence/${selfPresence.PlayerID}`);
            window.firebaseBackend._presenceRef = selfRef;
            // Remember what we need to re-assert our presence in the heartbeat.
            window.firebaseBackend._selfPresence = selfPresence;
            window.firebaseBackend._room = room;
            try {
                // Arm the disconnect handler FIRST so a disconnect right after the
                // write is still covered.
                await onDisconnect(selfRef).remove();
                await set(selfRef, {
                    id: (selfPresence.id !== undefined && selfPresence.id !== null) ? selfPresence.id : null,
                    PlayerID: selfPresence.PlayerID,
                    Name: selfPresence.Name || "",
                    Color: selfPresence.Color || "",
                    // `since` = when we joined (set once). `lastSeen` = freshness,
                    // refreshed by the heartbeat. Both fields must be declared in the
                    // database security rules or the whole write is permission_denied.
                    since: serverTimestamp(),
                    lastSeen: serverTimestamp()
                });
            } catch (e) {
                console.error("Failed to register presence:", e);
            }
        }
    },

    // Explicitly remove our presence node on a graceful leave (e.g. pagehide).
    // onDisconnect still covers ungraceful exits.
    leavePresence: async (room, playerId) => {
        if (!room || !playerId) return;
        if (!(await requireAuth())) return;
        const selfRef = ref(db, `rooms/${room}/presence/${playerId}`);
        try {
            // Best-effort immediate removal. We intentionally do NOT cancel the armed
            // onDisconnect() handler: if this explicit remove doesn't finish (e.g. the
            // tab is being torn down on close), onDisconnect() still removes the node
            // when the socket closes. Cancelling here was disarming that safety net and
            // leaving stale presence behind.
            await remove(selfRef);
        } catch (e) {
            console.error("Failed to leave presence:", e);
        }
    },

    // Heartbeat: refresh our presence node so other clients keep counting us as
    // "here". We re-arm onDisconnect each time as cheap insurance.
    //
    // The full identity payload is (re)written, not just lastSeen: our node CAN
    // be missing here — the heartbeat pauses while the tab is hidden, so after
    // ~90s peers prune us as a ghost, and a lastSeen-only update would then
    // recreate a skeleton node with no Name/PlayerID ("3 users" with 2 names).
    // `since` is preserved when the node still exists (update semantics) and
    // reseeded when it doesn't.
    touchPresence: async (room, playerId) => {
        room = room || window.firebaseBackend._room;
        const selfPresence = window.firebaseBackend._selfPresence;
        if (!room || !playerId || !selfPresence || selfPresence.PlayerID !== playerId) return;
        if (!(await requireAuth())) return;
        const selfRef = ref(db, `rooms/${room}/presence/${playerId}`);
        try {
            await onDisconnect(selfRef).remove();
            const snap = await get(selfRef);
            if (snap.exists()) {
                await update(selfRef, { lastSeen: serverTimestamp() });
            } else {
                await set(selfRef, {
                    id: (selfPresence.id !== undefined && selfPresence.id !== null) ? selfPresence.id : null,
                    PlayerID: selfPresence.PlayerID,
                    Name: selfPresence.Name || "",
                    Color: selfPresence.Color || "",
                    since: serverTimestamp(),
                    lastSeen: serverTimestamp()
                });
            }
        } catch (e) {
            console.error("Failed to heartbeat presence:", e);
        }
    },

    sendEvent: async (room, jsonData) => {
        if (!(await requireAuth())) return;
        if (!room) return;
        const eventsRef = ref(db, `rooms/${room}/events`);
        const newEventRef = push(eventsRef);
        await set(newEventRef, {
            jsonData: jsonData,
            timestamp: serverTimestamp()
        });

        // Optional: cleanup old events
        // Not strictly necessary for a free tier unless rooms are long-lived and busy
    }
};
