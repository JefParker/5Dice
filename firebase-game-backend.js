import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, get, child, remove, push, onChildAdded, onValue, onDisconnect, serverTimestamp, query, limitToLast, update } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

const authPromise = signInAnonymously(auth).catch((error) => {
  console.error("Anonymous auth failed:", error);
});

let roomsUnsubscribe = null;
let chatUnsubscribe = null;
let gameStateUnsubscribe = null;
let gameEventsUnsubscribe = null;

window.firebaseGameBackend = {
  isConnected: false,
  authPromise: authPromise,

  init: async (onStatusChange) => {
    await authPromise;
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
    await authPromise;
    if (roomsUnsubscribe) roomsUnsubscribe();
    const roomsRef = ref(db, "lobby/rooms");
    roomsUnsubscribe = onValue(roomsRef, (snapshot) => {
      const rooms = snapshot.val() || {};
      onRoomsCallback(rooms);
    });
    return roomsUnsubscribe;
  },

  createRoom: async (room) => {
    await authPromise;
    if (!room || !room.id) return;
    const roomRef = ref(db, `lobby/rooms/${room.id}`);
    await set(roomRef, {
      ...room,
      lastActive: Date.now()
    });

    // Cleanup old rooms after 24h idle when creating rooms
    window.firebaseGameBackend.cleanupOldRooms();
  },

  updateRoom: async (roomId, updates) => {
    await authPromise;
    if (!roomId) return;
    const roomRef = ref(db, `lobby/rooms/${roomId}`);
    await update(roomRef, {
      ...updates,
      lastActive: Date.now()
    });
  },

  deleteRoom: async (roomId) => {
    await authPromise;
    if (!roomId) return;
    await remove(ref(db, `lobby/rooms/${roomId}`));
    await remove(ref(db, `games/${roomId}`));
  },

  cleanupOldRooms: async () => {
    await authPromise;
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
    await authPromise;
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
    await authPromise;
    const chatRef = ref(db, "lobby/chats");
    const newMsgRef = push(chatRef);
    await set(newMsgRef, chatMsg);
  },

  // --- GAME SESSION ---
  initGameSession: async (roomId, initialGameData) => {
    await authPromise;
    if (!roomId) return;
    const gameRef = ref(db, `games/${roomId}`);
    await set(gameRef, {
      ...initialGameData,
      lastUpdated: Date.now()
    });
  },

  updateGameState: async (roomId, stateUpdates) => {
    await authPromise;
    if (!roomId) return;
    const gameRef = ref(db, `games/${roomId}`);
    await update(gameRef, {
      ...stateUpdates,
      lastUpdated: Date.now()
    });
  },

  listenGameState: async (roomId, onStateCallback) => {
    await authPromise;
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
    await authPromise;
    if (!roomId) return;
    const eventsRef = ref(db, `games/${roomId}/events`);
    const newEvtRef = push(eventsRef);
    await set(newEvtRef, {
      ...eventObj,
      timestamp: Date.now()
    });
  },

  listenGameEvents: async (roomId, onEventCallback) => {
    await authPromise;
    if (gameEventsUnsubscribe) gameEventsUnsubscribe();
    if (!roomId) return;
    const eventsRef = ref(db, `games/${roomId}/events`);
    const startTime = Date.now();
    const q = query(eventsRef, limitToLast(10));
    gameEventsUnsubscribe = onChildAdded(q, (snapshot) => {
      const evt = snapshot.val();
      if (evt && evt.timestamp >= startTime - 5000) {
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
