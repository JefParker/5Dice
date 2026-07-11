const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') 
  ? 'http://127.0.0.1:8787' 
  : 'https://5dice-backend.jeffreyrobertparker.workers.dev';

// UI State Management
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(el => {
    if (el.id === screenId) {
      el.classList.remove('hidden');
      el.classList.add('active');
    } else {
      el.classList.remove('active');
      el.classList.add('hidden');
    }
  });
}

function showLoading(text) {
  document.getElementById('loading-text').innerText = text;
  document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

// iOS PWA Prompt Logic
function checkIOSPWA() {
  const isIos = () => {
    const userAgent = window.navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(userAgent);
  };
  const isStandalone = () => {
    return ('standalone' in window.navigator) && (window.navigator.standalone);
  };
  if (isIos() && !isStandalone()) {
    document.getElementById('ios-install-modal').classList.remove('hidden');
  }
}
document.getElementById('btn-close-ios-modal').addEventListener('click', () => {
  document.getElementById('ios-install-modal').classList.add('hidden');
});

// Register Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(registration => {
      console.log('SW registered: ', registration);
    }).catch(registrationError => {
      console.log('SW registration failed: ', registrationError);
    });
  });
}

// Global Application State
let currentRoomId = null;
let isHost = false;
let myName = localStorage.getItem('playerName') || 'Jeff';
let pollInterval = null;
let gameState = ['', '', '', '', '', '', '', '', ''];
let myTurn = false;

// Screen Wake Lock
let wakeLock = null;

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Wake Lock acquired');
    } catch (err) {
      console.error('Wake Lock error:', err);
    }
  }
}

function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release().then(() => {
      wakeLock = null;
      console.log('Wake Lock released');
    }).catch(e => console.error(e));
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentRoomId) {
    requestWakeLock();
  }
});

// WebRTC Configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};
let peerConnection;
let dataChannel;
let processedIceCandidates = new Set();
let lastHostSdpStr = null;
let lastGuestSdpStr = null;

// Setup UI Event Listeners
document.getElementById('btn-create-new').addEventListener('click', () => {
  showScreen('screen-setup');
});
document.getElementById('btn-cancel-setup').addEventListener('click', () => {
  showScreen('screen-lobby');
});
document.getElementById('btn-create-room').addEventListener('click', createRoom);
document.getElementById('btn-leave-game').addEventListener('click', leaveGame);

// Chat Logic
const chatInput = document.getElementById('chat-input');
const btnChatSend = document.getElementById('btn-chat-send');

// Auto-resize textarea
chatInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = (this.scrollHeight) + 'px';
});

async function handleChatSend() {
  if (chatInput.value.trim() !== '') {
    const text = chatInput.value.trim();
    chatInput.value = ''; // clear input immediately
    chatInput.style.height = 'auto'; // reset height
    
    if (myName === 'Jeff') {
      myName = prompt("Enter your chat name:", "Player") || "Anonymous";
      localStorage.setItem('playerName', myName);
    }
    
    try {
      await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: myName, text })
      });
      loadChat();
    } catch (err) { console.error("Chat error", err); }
  }
}

chatInput.addEventListener('keydown', (e) => {
  // Send on Enter (without shift key)
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault(); // Prevent adding a new line
    handleChatSend();
  }
});
btnChatSend.addEventListener('click', handleChatSend);

async function loadChat() {
  if(document.getElementById('screen-lobby').classList.contains('hidden')) return;
  try {
    const res = await fetch(`${API_BASE}/api/chat`);
    const chat = await res.json();
    const history = document.getElementById('chat-history');
    history.innerHTML = '';
    chat.forEach(msg => {
      const div = document.createElement('div');
      div.className = 'chat-msg';
      div.innerHTML = `<strong>${msg.author}:</strong> ${msg.text}`;
      history.appendChild(div);
    });
    history.scrollTop = history.scrollHeight;
  } catch(e) {}
}

// Fetch and display rooms
async function loadRooms() {
  if(document.getElementById('screen-lobby').classList.contains('hidden')) return;
  try {
    const res = await fetch(`${API_BASE}/api/rooms`);
    const rooms = await res.json();
    const grid = document.getElementById('room-list');
    grid.innerHTML = '';
    
    document.getElementById('game-count').innerText = `Games Found: ${rooms.length}`;
    
    rooms.forEach(room => {
      const card = document.createElement('div');
      card.className = 'room-card';
      card.innerHTML = `
        <div class="room-card-title">${room.name}</div>
        <div class="room-card-status">${room.players}/${room.max_players} Players • ${room.status.toUpperCase()}</div>
        <button class="capsule-button join-button" data-id="${room.id}">Join Game</button>
      `;
      grid.appendChild(card);
    });
    
    document.querySelectorAll('.join-button').forEach(btn => {
      btn.addEventListener('click', (e) => joinRoom(e.target.getAttribute('data-id')));
    });
  } catch (err) {
    console.error("Failed to load rooms", err);
  }
}

// Initial lobby load and polling
setInterval(() => {
  loadRooms();
  loadChat();
}, 5000);
loadRooms();
loadChat();
checkIOSPWA();

// Create Room & Host Signaling
async function createRoom() {
  const nameInput = document.getElementById('room-name-input').value || 'New Match';
  const playerInput = document.getElementById('player-1-input').value;
  if (playerInput) {
    myName = playerInput;
    localStorage.setItem('playerName', myName);
  }
  isHost = true;
  showLoading('Creating Room...');

  try {
    const res = await fetch(`${API_BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nameInput, host: myName })
    });
    const room = await res.json();
    currentRoomId = room.id;
    
    requestWakeLock();
    initWebRTC();
    showScreen('screen-game');
    document.getElementById('game-status').innerText = 'Waiting for opponent to join...';
    startPolling();
  } catch(e) {
    alert("Error creating room.");
  } finally {
    hideLoading();
  }
}

// Join Room & Guest Signaling
async function joinRoom(roomId) {
  isHost = false;
  currentRoomId = roomId;
  if (myName === 'Jeff') {
    myName = prompt("Enter your name:", "Player 2") || "Player 2";
    localStorage.setItem('playerName', myName);
  }
  showLoading('Joining Room...');

  try {
    const res = await fetch(`${API_BASE}/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest: myName })
    });
    
    if (!res.ok) {
      alert("Room is full or unavailable.");
      return;
    }
    
    requestWakeLock();
    initWebRTC();
    showScreen('screen-game');
    document.getElementById('game-status').innerText = 'Connecting to host...';
    startPolling();
  } catch (e) {
    alert("Error joining room.");
  } finally {
    hideLoading();
  }
}

// WebRTC Initialization
function initWebRTC() {
  peerConnection = new RTCPeerConnection(rtcConfig);
  processedIceCandidates.clear();

  // Handle ICE connection state changes for reconnects
  peerConnection.oniceconnectionstatechange = () => {
    console.log("ICE State:", peerConnection.iceConnectionState);
    if (peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'failed') {
      document.getElementById('reconnecting-overlay').classList.remove('hidden');
      document.getElementById('tic-tac-toe-board').classList.add('disabled');
      
      startPolling(); // Resume polling for signaling data
      
      // A full ICE restart logic would be here, but for this prototype, we'll try a basic restart if host
      if (isHost && peerConnection.iceConnectionState === 'failed') {
        peerConnection.restartIce();
        createOffer();
      }
    } else if (peerConnection.iceConnectionState === 'connected') {
      document.getElementById('reconnecting-overlay').classList.add('hidden');
      document.getElementById('network-dot').classList.add('connected');
      document.getElementById('tic-tac-toe-board').classList.remove('disabled');
      stopPolling();
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({ ice: event.candidate });
    }
  };

  if (isHost) {
    dataChannel = peerConnection.createDataChannel('gameChannel');
    setupDataChannel();
    createOffer();
  } else {
    peerConnection.ondatachannel = (event) => {
      dataChannel = event.channel;
      setupDataChannel();
    };
  }
}

async function createOffer() {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  await sendSignal({ sdp: peerConnection.localDescription });
}

function setupDataChannel() {
  dataChannel.onopen = () => {
    console.log("Data Channel OPEN");
    document.getElementById('network-dot').classList.add('connected');
    document.getElementById('game-status').innerText = "Match Started! " + (isHost ? "Your turn (X)" : "Opponent's turn (O)");
    document.getElementById('tic-tac-toe-board').classList.remove('disabled');
    myTurn = isHost; 
    stopPolling();
    
    // Exchange names
    dataChannel.send(JSON.stringify({ type: 'handshake', name: myName }));
  };
  
  dataChannel.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'handshake') {
      const oppName = msg.name || 'Opponent';
      document.getElementById('game-status').innerText = myTurn 
        ? `Your turn (${isHost ? 'X' : 'O'}) vs ${oppName}`
        : `${oppName}'s turn (${!isHost ? 'X' : 'O'})`;
    } else if (msg.type === 'move') {
      gameState[msg.index] = msg.player;
      updateBoard();
      myTurn = true;
      document.getElementById('game-status').innerText = "Your turn (" + (isHost ? "X" : "O") + ")";
      checkWin();
    }
  };
}

let signalQueue = Promise.resolve();

function sendSignal(payload) {
  if (!currentRoomId) return;
  payload.role = isHost ? 'host' : 'guest';
  
  signalQueue = signalQueue.then(async () => {
    try {
      await fetch(`${API_BASE}/api/rooms/${currentRoomId}/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.error("Signal error", e);
    }
  });
}

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    if (!currentRoomId) return;
    try {
      const res = await fetch(`${API_BASE}/api/rooms/${currentRoomId}/signal`);
      const room = await res.json();
      
      if (isHost) {
        if (room.guest_sdp && peerConnection.signalingState === 'have-local-offer') {
          const sdpStr = JSON.stringify(room.guest_sdp);
          if (sdpStr !== lastGuestSdpStr) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(room.guest_sdp));
            lastGuestSdpStr = sdpStr;
          }
        }
        room.guest_ice.forEach(async ice => {
          const iceStr = JSON.stringify(ice);
          if (!processedIceCandidates.has(iceStr)) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(ice));
            processedIceCandidates.add(iceStr);
          }
        });
      } else {
        if (room.host_sdp) {
          const sdpStr = JSON.stringify(room.host_sdp);
          if (sdpStr !== lastHostSdpStr) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(room.host_sdp));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            await sendSignal({ sdp: peerConnection.localDescription });
            lastHostSdpStr = sdpStr;
          }
        }
        room.host_ice.forEach(async ice => {
          const iceStr = JSON.stringify(ice);
          if (!processedIceCandidates.has(iceStr)) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(ice));
            processedIceCandidates.add(iceStr);
          }
        });
      }
    } catch (e) {
      console.log("Polling error", e);
    }
  }, 1000); // Polling every 1 second
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// Tic-Tac-Toe Game Logic
document.querySelectorAll('.cell').forEach(cell => {
  cell.addEventListener('click', (e) => {
    if (!myTurn || dataChannel?.readyState !== 'open') return;
    const index = e.target.getAttribute('data-index');
    if (gameState[index] !== '') return; // cell occupied
    
    const symbol = isHost ? 'X' : 'O';
    gameState[index] = symbol;
    updateBoard();
    myTurn = false;
    document.getElementById('game-status').innerText = "Opponent's turn";
    
    dataChannel.send(JSON.stringify({ type: 'move', index, player: symbol }));
    checkWin();
  });
});

function updateBoard() {
  document.querySelectorAll('.cell').forEach((cell, i) => {
    cell.innerText = gameState[i];
  });
}

function checkWin() {
  const winLines = [
    [0,1,2],[3,4,5],[6,7,8], // rows
    [0,3,6],[1,4,7],[2,5,8], // cols
    [0,4,8],[2,4,6]          // diagonals
  ];
  
  let winner = null;
  for (let line of winLines) {
    if (gameState[line[0]] && gameState[line[0]] === gameState[line[1]] && gameState[line[0]] === gameState[line[2]]) {
      winner = gameState[line[0]];
      break;
    }
  }
  
  if (winner) {
    document.getElementById('game-status').innerText = `${winner === (isHost ? 'X' : 'O') ? 'You win!' : 'You lose!'}`;
    document.getElementById('tic-tac-toe-board').classList.add('disabled');
    myTurn = false;
  } else if (!gameState.includes('')) {
    document.getElementById('game-status').innerText = "It's a draw!";
    myTurn = false;
  }
}

function leaveGame() {
  stopPolling();
  if (peerConnection) peerConnection.close();
  if (dataChannel) dataChannel.close();
  currentRoomId = null;
  releaseWakeLock();
  gameState = ['', '', '', '', '', '', '', '', ''];
  updateBoard();
  document.getElementById('tic-tac-toe-board').classList.add('disabled');
  showScreen('screen-lobby');
  loadRooms();
}
