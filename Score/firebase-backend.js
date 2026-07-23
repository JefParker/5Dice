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

window.firebaseBackend = {
    isConnected: false,
    authError: null,

    // Ref to our own presence node, so we can remove it on an explicit leave.
    _presenceRef: null,

    setScore: async (room, player_id, scoreJson) => {
        if (!(await requireAuth())) throw new Error("Not authenticated");
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
        let serverTimeOffset = 0;
        try {
            const offsetSnap = await get(ref(db, '.info/serverTimeOffset'));
            serverTimeOffset = offsetSnap.val() || 0;
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
        let unsubPresence = onValue(presenceRef, (snapshot) => {
            const arr = snapshot.exists() ? Object.values(snapshot.val()) : [];
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
            try {
                // Arm the disconnect handler FIRST so a disconnect right after the
                // write is still covered.
                await onDisconnect(selfRef).remove();
                await set(selfRef, {
                    id: (selfPresence.id !== undefined && selfPresence.id !== null) ? selfPresence.id : null,
                    PlayerID: selfPresence.PlayerID,
                    Name: selfPresence.Name || "",
                    Color: selfPresence.Color || "",
                    since: serverTimestamp()
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
            await onDisconnect(selfRef).cancel();
            await remove(selfRef);
        } catch (e) {
            console.error("Failed to leave presence:", e);
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
