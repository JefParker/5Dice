


// --- GLOBALS ---
let myPeerId = 'peer-' + Math.random().toString(36).substr(2, 9);
const isDesktop = !(/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent));
const myWeight = (isDesktop ? 100 : 50) + Math.floor(Math.random() * 10);

let lobbyPeers = {}; // { [id]: { pc, dc, name } }
let gamePeers = {};  // { [id]: { pc, dc } }

let myName = localStorage.getItem('playerName') || 'Jeff';
let currentRoomId = null; 
let activeRooms = {}; // { roomId: { id, name, host } }
let isHost = false;
let mqttClient = null;

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

function showLoading(text) {
  const overlay = document.getElementById('loading-overlay');
  const txt = document.getElementById('loading-text');
  if (overlay && txt) {
    txt.innerText = text;
    overlay.classList.remove('hidden');
    overlay.style.display = 'flex';
  }
}

function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.style.display = 'none';
  }
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

function startLobbyMesh() {
  if (mqttClient) return;

  mqttClient = mqtt.connect('wss://test.mosquitto.org:8081');

  mqttClient.on('connect', () => {
    console.log('Connected to public MQTT signaling server');
    mqttClient.subscribe('5dice/lobby/announce');
    mqttClient.subscribe(`5dice/lobby/signal/${myPeerId}`);

    // Announce presence
    mqttClient.publish('5dice/lobby/announce', JSON.stringify({ peerId: myPeerId }));
    updateDiagnostics();
  });

  mqttClient.on('message', async (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());

      if (topic === '5dice/lobby/announce') {
        const p = payload.peerId;
        if (p !== myPeerId) {
          // Tell the new peer we exist so they can initiate if their ID > ours
          mqttClient.publish(`5dice/lobby/signal/${p}`, JSON.stringify({ from: myPeerId, type: 'announce_reply' }));
          
          if (!lobbyPeers[p] && myPeerId > p) {
            await initiateLobbyConnection(p, null);
          }
        }
      } else if (topic === `5dice/lobby/signal/${myPeerId}`) {
        await handleLobbySignal(payload);
      }
    } catch (err) {
      console.error('MQTT message error:', err);
    }
  });
}

async function sendSignal(targetId, signalPayload) {
  const route = lobbyPeers[targetId] ? lobbyPeers[targetId].routeVia : null;
  
  if (route && lobbyPeers[route] && lobbyPeers[route].dc && lobbyPeers[route].dc.readyState === 'open') {
    // Relay over WebRTC Mesh
    lobbyPeers[route].dc.send(JSON.stringify({
      type: 'relay', to: targetId, from: myPeerId, signal: signalPayload
    }));
  } else if (mqttClient && mqttClient.connected) {
    // MQTT WebSocket Fallback
    mqttClient.publish(`5dice/lobby/signal/${targetId}`, JSON.stringify({ from: myPeerId, ...signalPayload }));
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
    const onOpenHandler = () => {
      console.log(`Lobby channel open with ${targetId}`);
      const myRooms = Object.values(activeRooms).filter(r => r.host === myPeerId);
      dc.send(JSON.stringify({ type: 'handshake', name: myName, knownPeers: Object.keys(lobbyPeers), rooms: myRooms }));
      updateDiagnostics();
    };

    dc.onopen = onOpenHandler;
    if (dc.readyState === 'open') {
      onOpenHandler();
    }

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
              await initiateLobbyConnection(p, targetId);
            }
          }
        }
        if (msg.rooms) {
          msg.rooms.forEach(r => activeRooms[r.id] = r);
          renderRooms();
        }
        appendChatMessage('System', `${msg.name} connected.`);
      } else if (msg.type === 'ROOM_CREATED') {
        activeRooms[msg.room.id] = msg.room;
        renderRooms();
      } else if (msg.type === 'ROOM_CLOSED') {
        delete activeRooms[msg.roomId];
        renderRooms();
      } else if (msg.type === 'JOIN_ROOM_REQUEST') {
        if (activeRooms[msg.roomId] && activeRooms[msg.roomId].host === myPeerId) {
          const gamePlayers = [myPeerId, msg.guest].sort();
          lobbyPeers[msg.guest].dc.send(JSON.stringify({ type: 'START_GAME_SIGNAL', players: gamePlayers }));
          handleGameStartSignal(gamePlayers);
          delete activeRooms[msg.roomId];
          broadcastToLobby({ type: 'ROOM_CLOSED', roomId: msg.roomId });
        }
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

  if (type === 'announce_reply') {
    if (!lobbyPeers[from] && myPeerId > from) {
      await initiateLobbyConnection(from, null);
    }
    return;
  }

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

function broadcastToLobby(msgObj) {
  const payload = JSON.stringify(msgObj);
  for (const peerId in lobbyPeers) {
    if (lobbyPeers[peerId].dc && lobbyPeers[peerId].dc.readyState === 'open') {
      lobbyPeers[peerId].dc.send(payload);
    }
  }
}

btnChatSend.addEventListener('click', () => {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  appendChatMessage('Me', text);
  broadcastToLobby({ type: 'chat', name: myName, text });
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

// --- ROOM LOGIC ---

document.getElementById('btn-settings').addEventListener('click', () => {
  document.getElementById('global-player-name').value = myName;
  showScreen('screen-settings');
});

document.getElementById('btn-save-settings').addEventListener('click', () => {
  const newName = document.getElementById('global-player-name').value.trim();
  if (newName) {
    myName = newName;
    localStorage.setItem('playerName', myName);
  }
  showScreen('screen-lobby');
});

document.getElementById('btn-create-new').addEventListener('click', () => {
  document.getElementById('player-1-input').value = myName;
  showScreen('screen-setup');
});

document.getElementById('btn-cancel-setup').addEventListener('click', () => {
  showScreen('screen-lobby');
});

document.getElementById('btn-create-room').addEventListener('click', async () => {
  const roomName = document.getElementById('room-name-input').value || 'New Game';
  const myNameInput = document.getElementById('player-1-input').value || myName;
  myName = myNameInput;
  localStorage.setItem('playerName', myName);
  
  showLoading('Creating Room...');
  
  const roomId = Math.random().toString(36).substr(2, 9);
  const room = { id: roomId, name: roomName, host: myPeerId, status: 'open' };
  activeRooms[roomId] = room;
  isHost = true;
  currentRoomId = roomId;
  
  broadcastToLobby({ type: 'ROOM_CREATED', room });
  
  showScreen('screen-game');
  document.getElementById('game-status').innerText = 'Waiting for opponent to join...';
  hideLoading();
});

window.joinRoom = function(roomId) {
  const room = activeRooms[roomId];
  if (!room) return alert('Room no longer exists.');
  
  showLoading('Joining Room...');
  if (lobbyPeers[room.host] && lobbyPeers[room.host].dc && lobbyPeers[room.host].dc.readyState === 'open') {
    lobbyPeers[room.host].dc.send(JSON.stringify({ type: 'JOIN_ROOM_REQUEST', roomId, guest: myPeerId }));
    currentRoomId = roomId;
    isHost = false;
    showScreen('screen-game');
    document.getElementById('game-status').innerText = 'Joined! Waiting for host to start game mesh...';
  } else {
    alert('Host is not connected to your mesh network!');
  }
  hideLoading();
};

function renderRooms() {
  const list = document.getElementById('room-list');
  const rooms = Object.values(activeRooms);
  list.innerHTML = '';
  document.getElementById('game-count').innerText = `Games Found: ${rooms.length}`;
  
  rooms.forEach(r => {
    const div = document.createElement('div');
    div.className = 'room-card';
    div.innerHTML = `
      <h3>${r.name}</h3>
      <p>Host: ${lobbyPeers[r.host] ? lobbyPeers[r.host].name : r.host}</p>
      <button class="capsule-button small" onclick="joinRoom('${r.id}')">Join Game</button>
    `;
    list.appendChild(div);
  });
}

function startRoomPolling() {
  renderRooms();
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
    const onOpenHandler = () => {
      checkGameMeshReady();
    };
    dc.onopen = onOpenHandler;
    if (dc.readyState === 'open') {
      onOpenHandler();
    }
    dc.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'move') {
        gameState[msg.index] = msg.player;
        updateBoard();
        const gameOver = checkWin();
        if (!gameOver) {
          myTurn = true; 
          document.getElementById('game-status').innerText = 'Your turn!';
        }
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
      txt.innerText = `LOBBY MESH: ${lobbyCount} PEER(S)`;
    } else {
      dot.className = 'status-dot connecting';
      txt.innerText = `LOBBY MESH: SEEKING...`;
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
  const gameOver = checkWin();
  
  for (const p in gamePeers) {
    if (gamePeers[p].dc && gamePeers[p].dc.readyState === 'open') {
      gamePeers[p].dc.send(JSON.stringify({ type: 'move', index, player: mySymbol }));
    }
  }
  if (!gameOver) {
    myTurn = false;
    document.getElementById('game-status').innerText = `Opponent's turn`;
  }
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
      return true;
    }
  }
  if (!gameState.includes('')) {
    document.getElementById('game-status').innerText = "It's a draw!";
    myTurn = false;
    return true;
  }
  return false;
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
