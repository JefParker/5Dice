import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, get, child, remove, push, onChildAdded, onValue, onDisconnect, serverTimestamp, query, limitToLast, orderByChild, endAt, update } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";

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

    getAllRooms: async () => {
        if (!(await requireAuth())) return [];
        await window.firebaseBackend.cleanupOldRooms();
        const snapshot = await get(ref(db, 'rooms'));
        const roomList = [];
        if (snapshot.exists()) {
            const rooms = snapshot.val();
            for (let roomId in rooms) {
                const roomData = rooms[roomId];
                let playerNames = [];
                if (roomData && roomData.scores) {
                    for (let pid in roomData.scores) {
                        const p = roomData.scores[pid];
                        if (p.score) {
                            try {
                                const parsedScore = typeof p.score === 'string' ? JSON.parse(p.score) : p.score;
                                if (parsedScore.Name) playerNames.push(parsedScore.Name);
                            } catch(e) {}
                        }
                    }
                }
                roomList.push({
                    id: roomId,
                    players: playerNames,
                    lastEntered: roomData.lastEntered || 0
                });
            }
        }
        return roomList;
    },

    clearRoom: async (room) => {
        if (!(await requireAuth())) return;
        await remove(ref(db, `rooms/${room}/scores`));
    },

    clearTable: async () => {
        if (!(await requireAuth())) return;
        await remove(ref(db, `rooms`));
    },
    currentUnsubscribe: null,

    cleanupOldRooms: async () => {
        if (!(await requireAuth())) return;
        // 48 hours in milliseconds
        const cutoff = Date.now() - (48 * 60 * 60 * 1000);
        const roomsRef = ref(db, 'rooms');
        try {
            const snapshot = await get(roomsRef);
            if (snapshot.exists()) {
                const rooms = snapshot.val();
                const updates = {};
                for (let roomId in rooms) {
                    const val = rooms[roomId];
                    let shouldDelete = false;
                    if (val && val.lastEntered && val.lastEntered < cutoff) {
                        shouldDelete = true;
                    } else if (val && !val.lastEntered) {
                        let isOld = true;
                        if (val.scores) {
                            for (let pid in val.scores) {
                                if (val.scores[pid].lastdataset && val.scores[pid].lastdataset > cutoff) {
                                    isOld = false;
                                    break;
                                }
                            }
                        }
                        // A room with people currently present is never old.
                        if (val.presence && Object.keys(val.presence).length > 0) {
                            isOld = false;
                        }
                        if (isOld) shouldDelete = true;
                    }
                    if (shouldDelete) {
                        updates[roomId] = null;
                    }
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

    initEvents: async (room, onMessageCallback, selfPresence) => {
        if (!(await requireAuth())) {
            // Don't pretend we're connected if we couldn't authenticate; the
            // client's CheckConnection() will retry initEvents later.
            window.firebaseBackend.isConnected = false;
            console.error("initEvents aborted: not authenticated.");
            return;
        }
        if (!room) return;
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

        if (window.firebaseBackend.currentUnsubscribe) {
            window.firebaseBackend.currentUnsubscribe();
            window.firebaseBackend.currentUnsubscribe = null;
        }

        const eventsRef = ref(db, `rooms/${room}/events`);
        const scoresRef = ref(db, `rooms/${room}/scores`);
        const presenceRef = ref(db, `rooms/${room}/presence`);

        // Event timestamps are written with serverTimestamp() (server clock), so we must
        // filter against the SERVER's notion of "now", not the local device clock (which
        // may be skewed). Firebase exposes the client<->server offset at /.info/serverTimeOffset.
        // NOTE: .info is a synthetic client-side path — it must be read with a listener
        // (onValue), not a one-time get(), which rejects it as an "Invalid token in path".
        let serverTimeOffset = 0;
        try {
            serverTimeOffset = await new Promise((resolve) => {
                let settled = false;
                const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
                try {
                    onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
                        finish(snap.val() || 0);
                    }, { onlyOnce: true });
                } catch (e) {
                    finish(0);
                }
                // Never let this hold up joining the room.
                setTimeout(() => finish(0), 3000);
            });
        } catch (e) {
            console.error("Failed to read serverTimeOffset, falling back to local clock:", e);
        }
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
        // client refreshes its own `lastSeen` periodically, and here we treat any
        // entry not seen within PRESENCE_STALE_MS as gone — filtering it out of the
        // list AND best-effort deleting the dead node so ghosts self-clean.
        let unsubPresence = onValue(presenceRef, (snapshot) => {
            const raw = snapshot.exists() ? snapshot.val() : {};
            const serverNow = Date.now() + serverTimeOffset;
            const arr = [];
            for (let pid in raw) {
                const entry = raw[pid];
                if (!entry) continue;
                const seen = entry.lastSeen || entry.since || 0;
                if (seen && (serverNow - seen) > PRESENCE_STALE_MS) {
                    // Stale ghost: drop it from the live list and remove the node.
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
                    since: serverTimestamp(),
                    lastSeen: serverTimestamp()
                });
            } catch (e) {
                console.error("Failed to register presence:", e);
            }
        }

        window.firebaseBackend.currentUnsubscribe = () => {
            if (unsubEvents) unsubEvents();
            if (unsubScores) unsubScores();
            if (unsubPresence) unsubPresence();
        };
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

    // Heartbeat: refresh our presence node's lastSeen so other clients keep counting
    // us as "here". We re-set the whole node (not just lastSeen) so it self-heals if
    // it was pruned/removed, and we re-arm onDisconnect each time. Called on an
    // interval by the client while connected and visible.
    touchPresence: async (room, playerId) => {
        room = room || window.firebaseBackend._room;
        const selfPresence = window.firebaseBackend._selfPresence;
        if (!room || !playerId || !selfPresence || selfPresence.PlayerID !== playerId) return;
        if (!(await requireAuth())) return;
        const selfRef = ref(db, `rooms/${room}/presence/${playerId}`);
        try {
            await onDisconnect(selfRef).remove();
            await set(selfRef, {
                id: (selfPresence.id !== undefined && selfPresence.id !== null) ? selfPresence.id : null,
                PlayerID: selfPresence.PlayerID,
                Name: selfPresence.Name || "",
                Color: selfPresence.Color || "",
                since: selfPresence.since || serverTimestamp(),
                lastSeen: serverTimestamp()
            });
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
