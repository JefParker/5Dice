import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, get, child, remove, push, onChildAdded, onValue, onDisconnect, serverTimestamp, query, limitToLast, orderByChild, endAt, update } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";

import { firebaseConfig } from "../firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

const authPromise = signInAnonymously(auth).catch((error) => {
    console.error("Anonymous auth failed:", error);
});

window.firebaseBackend = {
    isConnected: false,
    
    setScore: async (room, player_id, scoreJson) => {
        await authPromise;
        await set(ref(db, `rooms/${room}/scores/${player_id}`), {
            room: room,
            player_id: player_id,
            score: scoreJson,
            lastdataset: Date.now()
        });
        set(ref(db, `rooms/${room}/lastEntered`), serverTimestamp());
    },
    
    getRoomData: async (room) => {
        await authPromise;
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
        await authPromise;
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
        await authPromise;
        await remove(ref(db, `rooms/${room}/scores`));
    },
    
    clearTable: async () => {
        await authPromise;
        await remove(ref(db, `rooms`));
    },
    currentUnsubscribe: null,
    
    cleanupOldRooms: async () => {
        await authPromise;
        // 48 hours in milliseconds
        const cutoff = Date.now() - (48 * 60 * 60 * 1000);
        const roomsRef = ref(db, 'rooms');
        const oldRoomsQuery = query(roomsRef, orderByChild('lastEntered'), endAt(cutoff));
        try {
            const snapshot = await get(oldRoomsQuery);
            if (snapshot.exists()) {
                const updates = {};
                snapshot.forEach((childSnapshot) => {
                    const val = childSnapshot.val();
                    let shouldDelete = false;
                    if (val && val.lastEntered && val.lastEntered < cutoff) {
                        shouldDelete = true;
                    } else if (val && !val.lastEntered) {
                        // For legacy rooms without lastEntered, check if they are old based on scores
                        let isOld = true;
                        if (val.scores) {
                            for (let pid in val.scores) {
                                if (val.scores[pid].lastdataset > cutoff) {
                                    isOld = false;
                                    break;
                                }
                            }
                        }
                        if (isOld) shouldDelete = true;
                    }
                    if (shouldDelete) {
                        updates[childSnapshot.key] = null;
                    }
                });
                if (Object.keys(updates).length > 0) {
                    await update(ref(db, 'rooms'), updates);
                    console.log("Cleaned up old rooms:", Object.keys(updates));
                }
            }
        } catch (e) {
            console.error("Failed to cleanup old rooms:", e);
        }
    },

    initEvents: async (room, onMessageCallback) => {
        await authPromise;
        if (!room) return;
        window.firebaseBackend.isConnected = true;
        
        set(ref(db, `rooms/${room}/lastEntered`), serverTimestamp());
        
        if (Math.random() < 0.1) {
            window.firebaseBackend.cleanupOldRooms();
        }
        
        if (window.firebaseBackend.currentUnsubscribe) {
            window.firebaseBackend.currentUnsubscribe();
            window.firebaseBackend.currentUnsubscribe = null;
        }

        const eventsRef = ref(db, `rooms/${room}/events`);
        const scoresRef = ref(db, `rooms/${room}/scores`);

        const serverStartTime = Date.now();
        
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
        
        window.firebaseBackend.currentUnsubscribe = () => {
            if (unsubEvents) unsubEvents();
            if (unsubScores) unsubScores();
        };
    },
    
    sendEvent: async (room, jsonData) => {
        await authPromise;
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
