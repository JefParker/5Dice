
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') 
  ? 'http://127.0.0.1:8787' 
  : 'https://5dice-backend.jeffreyrobertparker.workers.dev';

// --- GLOBALS ---
let myPeerId = 'peer-' + Math.random().toString(36).substr(2, 9);
const isDesktop = !(/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent));
const myWeight = (isDesktop ? 100 : 50) + Math.floor(Math.random() * 10);

let lobbyPeers = {}; // { [id]: { pc, dc, name } }
let gamePeers = {};  // { [id]: { pc, dc } }

let myName = localStorage.getItem('playerName') || 'Jeff';
let currentRoomId = null; 

let isLeader = false;
let leaderId = null;
let lobbyMeshInterval = null;
let roomPollInterval = null;

const rtcConfig = { 
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
  ] 
};

// UI Elements
const chatInput = document.getElementById('chat-input');
const btnChatSend = document.getElementById('btn-chat-send');
const chatHistory = document.getElementById('chat-history');

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

// iOS PWA Logic
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    document.body.style.height = window.visualViewport.height + 'px';
  });
}

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

// --- TIER 1: LOBBY MESH ---

async function startLobbyMesh() {
  if (lobbyMeshInterval) clearInterval(lobbyMeshInterval);
  
  // Announce presence
  try {
    await fetch(`${API_BASE}/api/lobby/new_peers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: myPeerId })
    });
  } catch (e) {
    console.error("Lobby announce failed", e);
  }

  updateDiagnostics();

  lobbyMeshInterval = setInterval(async () => {
    // 1. Leader Election
    try {
      const res = await fetch(`${API_BASE}/api/lobby/leader`);
      const leader = await res.json();
      const now = leader.serverTime || Date.now();
      
      if (!leader.peerId || (now - leader.timestamp > 65000)) {
        await claimLeadership();
      } else if (leader.peerId === myPeerId) {
        await claimLeadership();
      } else if (leader.weight < myWeight && (now - leader.timestamp > 65000)) {
        await claimLeadership();
      } else {
        isLeader = false;
        leaderId = leader.peerId;
      }
    } catch (e) {}

    // 2. If Leader, poll for new peers
    if (isLeader) {
      try {
        const res = await fetch(`${API_BASE}/api/lobby/new_peers`);
        const newPeers = await res.json();
        for (const p of newPeers) {
          if (p !== myPeerId && !lobbyPeers[p]) {
            await initiateLobbyConnection(p, null); // Leader uses HTTP for new peers
          }
        }
      } catch(e){}
    }

    // 3. Always poll own inbox for fallback WebRTC signals from unconnected peers
    try {
      const res = await fetch(`${API_BASE}/api/lobby/signal/${myPeerId}`);
      const signals = await res.json();
      for (const sig of signals) {
        try {
          await handleLobbySignal(sig);
        } catch(err) {
          console.error('Error handling signal:', err);
        }
      }
    } catch(e){}
    
    updateDiagnostics();
  }, 3000);
}

async function claimLeadership() {
  isLeader = true;
  leaderId = myPeerId;
  await fetch(`${API_BASE}/api/lobby/leader`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId: myPeerId, weight: myWeight, timestamp: Date.now() })
  });
}


async function sendSignal(targetId, signalPayload) {
  const route = lobbyPeers[targetId] ? lobbyPeers[targetId].routeVia : null;
  
  if (route && lobbyPeers[route] && lobbyPeers[route].dc && lobbyPeers[route].dc.readyState === 'open') {
    // Relay over WebRTC Mesh
    lobbyPeers[route].dc.send(JSON.stringify({
      type: 'relay', to: targetId, from: myPeerId, signal: signalPayload
    }));
  } else {
    // HTTP Fallback
    await fetch(`${API_BASE}/api/lobby/signal/${targetId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: myPeerId, ...signalPayload })
    });
  }
}

async function initiateLobbyConnection(targetId, routeVia = null) {
  if (lobbyPeers[targetId]) return;
  const pc = new RTCPeerConnection(rtcConfig);
  const dc = pc.createDataChannel('lobby-channel');
  lobbyPeers[targetId] = { pc, dc, name: 'Unknown', iceQueue: [], routeVia };
  setupLobbyPeer(targetId, pc, dc);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  
  await sendSignal(targetId, { type: 'offer', sdp: offer });
}

function setupLobbyPeer(targetId, pc, dc) {
  pc.onicecandidate = async (e) => {
    if (e.candidate) {
      await sendSignal(targetId, { type: 'ice', candidate: e.candidate });
    }
  };

  if (dc) {
    dc.onopen = () => {
      console.log(`Lobby channel open with ${targetId}`);
      dc.send(JSON.stringify({ type: 'handshake', name: myName, knownPeers: Object.keys(lobbyPeers) }));
      updateDiagnostics();
    };

    dc.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'relay') {
        if (msg.to === myPeerId) {
          handleLobbySignal({ from: msg.from, via: targetId, ...msg.signal });
        } else if (lobbyPeers[msg.to] && lobbyPeers[msg.to].dc && lobbyPeers[msg.to].dc.readyState === 'open') {
          lobbyPeers[msg.to].dc.send(JSON.stringify(msg)); // Forward to target
        }
      } else if (msg.type === 'handshake') {
        lobbyPeers[targetId].name = msg.name;
        if (msg.knownPeers) {
          for (const p of msg.knownPeers) {
            if (p !== myPeerId && !lobbyPeers[p] && myPeerId > p) {
              await initiateLobbyConnection(p, targetId); // Route via the peer who introduced us
            }
          }
        }
        appendChatMessage('System', `${msg.name} connected.`);
      } else if (msg.type === 'chat') {
        appendChatMessage(msg.name, msg.text);
      } else if (msg.type === 'START_GAME_SIGNAL') {
        handleGameStartSignal(msg.players);
      } else if (msg.type === 'game-offer' || msg.type === 'game-answer' || msg.type === 'game-ice') {
        handleGameSignal(msg);
      }
      updateDiagnostics();
    };
  }
  
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      delete lobbyPeers[targetId];
      updateDiagnostics();
    }
  };
}

async function handleLobbySignal(sig) {
  const { from, type, via } = sig;
  if (!lobbyPeers[from]) {
    const pc = new RTCPeerConnection(rtcConfig);
    lobbyPeers[from] = { pc, dc: null, name: 'Unknown', iceQueue: [], routeVia: via || null };
    
    pc.ondatachannel = (e) => {
      if (e.channel.label === 'lobby-channel') {
        lobbyPeers[from].dc = e.channel;
        setupLobbyPeer(from, pc, e.channel);
      }
    };
    setupLobbyPeer(from, pc, null);
  }

  const pc = lobbyPeers[from].pc;
  
  if (type === 'offer') {
    await pc.setRemoteDescription(sig.sdp);
    if (lobbyPeers[from].iceQueue) {
      for (const cand of lobbyPeers[from].iceQueue) {
        await pc.addIceCandidate(cand).catch(e => console.error(e));
      }
      lobbyPeers[from].iceQueue = [];
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendSignal(from, { type: 'answer', sdp: answer });
  } else if (type === 'answer') {
    await pc.setRemoteDescription(sig.sdp);
    if (lobbyPeers[from].iceQueue) {
      for (const cand of lobbyPeers[from].iceQueue) {
        await pc.addIceCandidate(cand).catch(e => console.error(e));
      }
      lobbyPeers[from].iceQueue = [];
    }
  } else if (type === 'ice') {
    if (pc.remoteDescription) {
      await pc.addIceCandidate(sig.candidate).catch(e => console.error(e));
    } else {
      lobbyPeers[from].iceQueue.push(sig.candidate);
    }
  }
}

// --- GLOBAL CHAT ---

function appendChatMessage(author, text) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<strong>${author}:</strong> ${text}`;
  chatHistory.appendChild(div);
  chatHistory.scrollTop = chatHistory.scrollHeight;
  setTimeout(() => { if (div.parentNode) div.remove(); }, 5 * 60 * 1000);
}

btnChatSend.addEventListener('click', () => {
  if (chatInput.value.trim() !== '') {
    const text = chatInput.value.trim();
    chatInput.value = '';
    chatInput.style.height = 'auto';
    
    appendChatMessage(myName, text);
    
    for (const p in lobbyPeers) {
      const dc = lobbyPeers[p].dc;
      if (dc && dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'chat', name: myName, text }));
      }
    }
  }
});
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    btnChatSend.click();
  }
});
document.getElementById('chat-sidebar').addEventListener('click', () => {
  if (window.innerWidth <= 768) {
    document.getElementById('chat-sidebar').classList.add('mobile-expanded');
  }
});
document.getElementById('btn-close-chat').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('chat-sidebar').classList.remove('mobile-expanded');
});
document.querySelector('.main-content').addEventListener('click', () => {
  if (window.innerWidth <= 768) {
    document.getElementById('chat-sidebar').classList.remove('mobile-expanded');
  }
});

// --- ROOM LOGIC (Using Cloudflare for discovery) ---

document.getElementById('btn-create-new').addEventListener('click', () => {
  if (roomPollInterval) clearInterval(roomPollInterval);
  showScreen('screen-setup');
});

document.getElementById('btn-cancel-setup').addEventListener('click', () => {
  showScreen('screen-lobby');
  startRoomPolling();
});

document.getElementById('btn-create-room').addEventListener('click', async () => {
  const roomName = document.getElementById('room-name-input').value || 'New Game';
  const myNameInput = document.getElementById('player-1-input').value || myName;
  myName = myNameInput;
  localStorage.setItem('playerName', myName);
  
  showLoading('Creating Room...');
  try {
    const res = await fetch(`${API_BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: roomName, host: myPeerId })
    });
    const room = await res.json();
    currentRoomId = room.id;
    isHost = true;
    
    showScreen('screen-game');
    document.getElementById('game-status').innerText = 'Waiting for opponent to join...';
    hideLoading();
    
    // As host, poll the room to see if a guest joined
    if (roomPollInterval) clearInterval(roomPollInterval);
    roomPollInterval = setInterval(async () => {
      const gRes = await fetch(`${API_BASE}/api/rooms/${currentRoomId}/signal`);
      const gRoom = await gRes.json();
      if (gRoom.guest) {
        clearInterval(roomPollInterval); // Stop polling cloudflare
        const guestPeerId = gRoom.guest;
        // Start Game Mesh Tier 2 using Lobby Channels
        const gamePlayers = [myPeerId, guestPeerId].sort();
        // Send signal via lobby mesh
        if (lobbyPeers[guestPeerId] && lobbyPeers[guestPeerId].dc) {
          lobbyPeers[guestPeerId].dc.send(JSON.stringify({ type: 'START_GAME_SIGNAL', players: gamePlayers }));
          handleGameStartSignal(gamePlayers);
        } else {
          document.getElementById('game-status').innerText = 'Guest joined but not found in Lobby Mesh!';
        }
      }
    }, 2000);
  } catch (err) {
    console.error(err);
    hideLoading();
    alert('Failed to create room.');
  }
});

async function joinRoom(roomId) {
  if (roomPollInterval) clearInterval(roomPollInterval);
  showLoading('Joining Room...');
  
  try {
    const res = await fetch(`${API_BASE}/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest: myPeerId })
    });
    if (!res.ok) throw new Error('Room full or closed');
    currentRoomId = roomId;
    isHost = false;
    
    showScreen('screen-game');
    document.getElementById('game-status').innerText = 'Joined! Waiting for Game Mesh...';
    hideLoading();
    // We now just wait for the START_GAME_SIGNAL over the Lobby Mesh
  } catch (err) {
    console.error(err);
    hideLoading();
    alert('Failed to join room.');
    startRoomPolling();
  }
}

function startRoomPolling() {
  if (roomPollInterval) clearInterval(roomPollInterval);
  const fetchRooms = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/rooms`);
      const rooms = await res.json();
      const list = document.getElementById('room-list');
      list.innerHTML = '';
      
      document.getElementById('game-count').innerText = `Games Found: ${rooms.length}`;
      
      rooms.forEach(r => {
        const div = document.createElement('div');
        div.className = 'room-card';
        div.innerHTML = `
          <h3>${r.name}</h3>
          <p>Host: ${r.host}</p>
          <button class="capsule-button small">Join Game</button>
        `;
        div.querySelector('button').addEventListener('click', () => joinRoom(r.id));
        list.appendChild(div);
      });
      if (rooms.length === 0) {
        list.innerHTML = `<p class="empty-state">No games found. Create one!</p>`;
      }
    } catch (e) {
      console.error('Room fetch error', e);
    }
  };
  fetchRooms();
  roomPollInterval = setInterval(fetchRooms, 3000);
}

// --- TIER 2: GAME MESH (ZERO-SERVER) ---
let gameState = ['', '', '', '', '', '', '', '', ''];
let myTurn = false;
let gamePlayers = [];
let gameHost = null;

async function handleGameStartSignal(players) {
  gamePlayers = players;
  gameHost = gamePlayers[0]; // Alphabetical sort means [0] is consistent host
  gamePeers = {};
  
  gameState = ['', '', '', '', '', '', '', '', ''];
  myTurn = (myPeerId === gameHost);
  updateBoard();
  document.getElementById('game-status').innerText = `Game Mesh: Syncing...`;

  for (const p of gamePlayers) {
    if (p !== myPeerId) {
      if (myPeerId > p) {
        await initiateGameConnection(p);
      }
    }
  }
  updateDiagnostics();
}

async function initiateGameConnection(targetId) {
  const pc = new RTCPeerConnection(rtcConfig);
  const dc = pc.createDataChannel('game-channel');
  gamePeers[targetId] = { pc, dc };
  setupGamePeer(targetId, pc, dc);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  
  if (lobbyPeers[targetId] && lobbyPeers[targetId].dc) {
    lobbyPeers[targetId].dc.send(JSON.stringify({
      type: 'game-offer', from: myPeerId, sdp: offer
    }));
  }
}

function setupGamePeer(targetId, pc, dc) {
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      if (lobbyPeers[targetId] && lobbyPeers[targetId].dc) {
        lobbyPeers[targetId].dc.send(JSON.stringify({
          type: 'game-ice', from: myPeerId, candidate: e.candidate
        }));
      }
    }
  };

  if (dc) {
    dc.onopen = () => {
      checkGameMeshReady();
    };
    dc.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'move') {
        gameState[msg.index] = msg.player;
        myTurn = true; 
        updateBoard();
        checkWin();
      }
    };
  }
}

async function handleGameSignal(msg) {
  const { type, from, sdp, candidate } = msg;
  
  if (type === 'game-offer') {
    const pc = new RTCPeerConnection(rtcConfig);
    gamePeers[from] = { pc, dc: null };
    
    pc.ondatachannel = (e) => {
      if (e.channel.label === 'game-channel') {
        gamePeers[from].dc = e.channel;
        setupGamePeer(from, pc, e.channel);
        checkGameMeshReady();
      }
    };
    setupGamePeer(from, pc, null);
    
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    lobbyPeers[from].dc.send(JSON.stringify({
      type: 'game-answer', from: myPeerId, sdp: answer
    }));
  } else if (type === 'game-answer') {
    await gamePeers[from].pc.setRemoteDescription(sdp);
  } else if (type === 'game-ice') {
    await gamePeers[from].pc.addIceCandidate(candidate);
  }
}

function checkGameMeshReady() {
  const ready = Object.values(gamePeers).every(p => p.dc && p.dc.readyState === 'open');
  if (ready && Object.keys(gamePeers).length === gamePlayers.length - 1) {
    document.getElementById('game-status').innerText = `Your turn!`;
    if (!myTurn) document.getElementById('game-status').innerText = `Opponent's turn`;
    document.getElementById('tic-tac-toe-board').classList.remove('disabled');
  }
  updateDiagnostics();
}

function updateDiagnostics() {
  const lobbyCount = Object.values(lobbyPeers).filter(p => p.dc && p.dc.readyState === 'open').length;
  const gameCount = Object.values(gamePeers).filter(p => p.dc && p.dc.readyState === 'open').length;
  
  const dot = document.getElementById('network-dot');
  const txt = document.getElementById('status-text');
  
  if (dot && txt) {
    if (lobbyCount > 0) {
      dot.className = 'status-dot connected';
      txt.innerText = `LOBBY MESH: ${lobbyCount} PEER(S) ${isLeader ? '[LEADER]' : ''}`;
    } else {
      dot.className = 'status-dot connecting';
      txt.innerText = `LOBBY MESH: SEEKING... ${isLeader ? '[LEADER]' : ''}`;
    }
  }
}

// TIC TAC TOE LOGIC
function createBoard() {
  const board = document.getElementById('tic-tac-toe-board');
  board.innerHTML = '';
  for (let i=0; i<9; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.index = i;
    cell.addEventListener('click', () => handleMove(i));
    board.appendChild(cell);
  }
}

function handleMove(index) {
  if (gameState[index] !== '' || !myTurn) return;
  const mySymbol = (myPeerId === gameHost) ? 'X' : 'O';
  gameState[index] = mySymbol;
  updateBoard();
  checkWin();
  
  for (const p in gamePeers) {
    if (gamePeers[p].dc && gamePeers[p].dc.readyState === 'open') {
      gamePeers[p].dc.send(JSON.stringify({ type: 'move', index, player: mySymbol }));
    }
  }
  myTurn = false;
  document.getElementById('game-status').innerText = `Opponent's turn`;
}

function updateBoard() {
  const cells = document.querySelectorAll('.cell');
  cells.forEach((cell, i) => {
    cell.innerText = gameState[i];
  });
}

function checkWin() {
  const winPatterns = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];
  for (let pattern of winPatterns) {
    const [a,b,c] = pattern;
    if (gameState[a] && gameState[a] === gameState[b] && gameState[a] === gameState[c]) {
      const winner = gameState[a];
      const mySymbol = (myPeerId === gameHost) ? 'X' : 'O';
      document.getElementById('game-status').innerText = (winner === mySymbol) ? 'You Win!' : 'Opponent Wins!';
      document.getElementById('tic-tac-toe-board').classList.add('disabled');
      myTurn = false;
      return;
    }
  }
  if (!gameState.includes('')) {
    document.getElementById('game-status').innerText = "It's a draw!";
    myTurn = false;
  }
}

document.getElementById('btn-leave-game').addEventListener('click', () => {
  for (const p in gamePeers) {
    if (gamePeers[p].pc) gamePeers[p].pc.close();
  }
  gamePeers = {};
  gamePlayers = [];
  gameState = ['', '', '', '', '', '', '', '', ''];
  updateBoard();
  document.getElementById('tic-tac-toe-board').classList.add('disabled');
  
  showScreen('screen-lobby');
  startRoomPolling();
  updateDiagnostics();
});

createBoard();
startLobbyMesh();
startRoomPolling();
