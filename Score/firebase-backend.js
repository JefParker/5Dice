import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, get, child, remove, push, onChildAdded, onDisconnect, serverTimestamp, query, limitToLast } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";

const firebaseConfig = {
  apiKey: "AIzaSyDEJodiD_HX1XtwmwMYFTUll60prxoe2Ic",
  authDomain: "dice-score.firebaseapp.com",
  databaseURL: "https://dice-score-default-rtdb.firebaseio.com",
  projectId: "dice-score",
  storageBucket: "dice-score.firebasestorage.app",
  messagingSenderId: "291526558646",
  appId: "1:291526558646:web:2f9cd5755f4fae1c503717",
  measurementId: "G-08RNMPNBHY"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

window.firebaseBackend = {
    isConnected: false,
    
    setScore: async (room, player_id, scoreJson) => {
        await set(ref(db, `rooms/${room}/scores/${player_id}`), {
            room: room,
            player_id: player_id,
            score: scoreJson,
            lastdataset: Date.now()
        });
    },
    
    getRoomData: async (room) => {
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
    
    clearRoom: async (room) => {
        await remove(ref(db, `rooms/${room}/scores`));
    },
    
    clearTable: async () => {
        await remove(ref(db, `rooms`));
    },
    currentUnsubscribe: null,
    initEvents: (room, onMessageCallback) => {
        if (!room) return;
        window.firebaseBackend.isConnected = true;
        
        if (window.firebaseBackend.currentUnsubscribe) {
            window.firebaseBackend.currentUnsubscribe();
            window.firebaseBackend.currentUnsubscribe = null;
        }

        const eventsRef = ref(db, `rooms/${room}/events`);
        
        // Fetch server time offset to handle clock skew accurately
        const offsetRef = ref(db, ".info/serverTimeOffset");
        get(offsetRef).then((snap) => {
            const offset = snap.val() || 0;
            const serverStartTime = Date.now() + offset;
            
            // Only listen to the last 20 events to save bandwidth and ignore deep history
            const q = query(eventsRef, limitToLast(20));
            const unsubscribe = onChildAdded(q, (snapshot) => {
                const val = snapshot.val();
                // Ignore events older than 10 seconds before we joined the room
                if (val && (!val.timestamp || val.timestamp > serverStartTime - 10000)) {
                    onMessageCallback(val.jsonData);
                }
            });
            window.firebaseBackend.currentUnsubscribe = unsubscribe;
        });
    },
    
    sendEvent: async (room, jsonData) => {
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
