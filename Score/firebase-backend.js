import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, get, child, remove, push, onChildAdded, onDisconnect, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

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
    
    initEvents: (room, onMessageCallback) => {
        if (!room) return;
        window.firebaseBackend.isConnected = true;
        
        // Listen for new events in the room
        const eventsRef = ref(db, `rooms/${room}/events`);
        
        // We only want to listen to new events from now on, not old ones
        // But RTDB onChildAdded triggers for existing children. 
        // We can ignore events older than a few seconds.
        const startTime = Date.now();
        
        onChildAdded(eventsRef, (snapshot) => {
            const val = snapshot.val();
            if (val && val.timestamp > startTime - 10000) {
                onMessageCallback(val.jsonData);
            }
        });

        // Periodically clean up old events so the DB doesn't grow infinitely
        // We'll just have the client delete their own old messages occasionally
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
