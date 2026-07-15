


// --- GLOBALS ---
let myPeerId = 'peer-' + Math.random().toString(36).substr(2, 9);
const isDesktop = !(/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent));
const myWeight = (isDesktop ? 100 : 50) + Math.floor(Math.random() * 10);

function generateDarkColor() {
  const colors = ["#235880", "#3F1F74", "#6F4F1F", "#2E2B53", "#264C1C", "#533A51", "#220066", "MidnightBlue", "#4d004d", "RebeccaPurple", "Sienna", "#181B59", "#006652", "#006666", "#404040", "#404040"];
  return colors[Math.floor(Math.random() * colors.length)];
}

let myColor = localStorage.getItem('playerColor');
if (!myColor) {
  myColor = generateDarkColor();
  localStorage.setItem('playerColor', myColor);
}

let lobbyPeers = {}; // { [id]: { pc, dc, name } }
let gamePeers = {};  // { [id]: { pc, dc } }
let reconnectTimers = {}; // { [id]: timeoutId }

let myName = localStorage.getItem('playerName') || '';
let currentRoomId = null; 
let activeRooms = {}; // { roomId: { id, name, host } }
let isHost = false;
let mqttClient = null;
let recentChats = []; // { id, author, text, timestamp }

// --- AUDIO GLOBALS ---
let localAudioStream = null;
let micEnabled = localStorage.getItem('micEnabled') === 'true';
let speakerEnabled = localStorage.getItem('speakerEnabled') === 'true';
let remoteAudioStates = {};

function broadcastAudioState() {
  const msgStr = JSON.stringify({
    type: 'AUDIO_STATE',
    peerId: myPeerId,
    micEnabled: micEnabled,
    speakerEnabled: speakerEnabled
  });
  for (const p in gamePeers) {
    if (gamePeers[p].dc && gamePeers[p].dc.readyState === 'open') {
      gamePeers[p].dc.send(msgStr);
    }
  }
}

function updateAudioStateOutline() {
  const anyMicOn = Object.values(remoteAudioStates).some(state => state.micEnabled);
  const anySpeakerOn = Object.values(remoteAudioStates).some(state => state.speakerEnabled);
  
  const micBtn = document.getElementById('btn-toggle-mic');
  const speakerBtn = document.getElementById('btn-toggle-speaker');
  
  if (micBtn) {
    if (anyMicOn) micBtn.classList.add('outline-red');
    else micBtn.classList.remove('outline-red');
  }
  if (speakerBtn) {
    if (anySpeakerOn) speakerBtn.classList.add('outline-red');
    else speakerBtn.classList.remove('outline-red');
  }
}

let wakeLock = null;

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      console.error(`Wake Lock error: ${err.message}`);
    }
  }
}

function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});

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
  if (screenId === 'screen-lobby' || screenId === 'screen-game') {
    requestWakeLock();
  } else {
    releaseWakeLock();
  }

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

  mqttClient = mqtt.connect('wss://broker.emqx.io:8084/mqtt');

  mqttClient.on('connect', () => {
    console.log('Connected to public MQTT signaling server');
    mqttClient.subscribe('5dice/lobby/announce');
    mqttClient.subscribe(`5dice/lobby/signal/${myPeerId}`);

    // Announce presence
    mqttClient.publish('5dice/lobby/announce', JSON.stringify({ peerId: myPeerId }));
    updateDiagnostics();
    retryGameConnections();
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
          if (gameHost !== null && typeof gamePlayers !== 'undefined' && gamePlayers.includes(p)) {
            retryGameConnections();
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
  lobbyPeers[targetId] = { pc, dc, name: 'Unknown', iceQueue: [], routeVia, lastInitiated: Date.now() };
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
      const shareableChats = recentChats.filter(c => c.author !== 'System');
      dc.send(JSON.stringify({ type: 'handshake', name: myName, color: myColor, knownPeers: Object.keys(lobbyPeers), rooms: myRooms, chats: shareableChats }));
      updateDiagnostics();
    };

    dc.onopen = onOpenHandler;
    if (dc.readyState === 'open') {
      onOpenHandler();
    }

    dc.onclose = () => {
      const name = lobbyPeers[targetId] ? lobbyPeers[targetId].name : 'Unknown';
      if (name !== 'Unknown') {
        appendChatMessage('System', `${name} has left.`, null, null, '#555');
      }
      delete lobbyPeers[targetId];
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
        if (msg.color) lobbyPeers[targetId].color = msg.color;
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
        if (msg.chats) {
          msg.chats.forEach(c => appendChatMessage(c.author, c.text, c.id, c.timestamp, c.color));
        }
        appendChatMessage('System', `${msg.name} connected.`, null, null, '#555');
        
        if (currentRoomId && typeof gamePlayers !== 'undefined' && gamePlayers.includes(targetId)) {
          updateGameBackground();
          checkGameMeshReady();
        }
      } else if (msg.type === 'ROOM_CREATED' || msg.type === 'ROOM_UPDATED') {
        activeRooms[msg.room.id] = msg.room;
        renderRooms();
      } else if (msg.type === 'ROOM_CLOSED') {
        delete activeRooms[msg.roomId];
        renderRooms();
      } else if (msg.type === 'PROFILE_UPDATE') {
        if (lobbyPeers[msg.from]) {
          lobbyPeers[msg.from] = { ...lobbyPeers[msg.from], name: msg.name, color: msg.color, uuid: msg.uuid };
          renderRooms();
          if (currentRoomId && gamePlayers.includes(msg.from)) {
            updateGameBackground();
          }
        }
      } else if (msg.type === 'JOIN_ROOM_REQUEST') {
        const room = activeRooms[msg.roomId];
        if (room && room.host === myPeerId) {
          const isRejoin = room.status === 'in-progress' && room.players.includes(msg.guestUuid);
          const isNew = room.status === 'open';
          
          if (isNew || isRejoin) {
            if (isNew) {
              room.players.push(msg.guestUuid);
              room.status = 'in-progress';
              broadcastToLobby({ type: 'ROOM_UPDATED', room });
            }
            const randomFirstPlayer = Math.random() < 0.5 ? myPeerId : msg.guest;
            const gamePlayers = [myPeerId, msg.guest].sort();
            const resumeState = isRejoin ? { board: gameState, myTurn: !myTurn } : null;
            lobbyPeers[msg.guest].dc.send(JSON.stringify({ 
              type: 'START_GAME_SIGNAL', 
              players: gamePlayers,
              resumeState: resumeState,
              firstTurn: randomFirstPlayer
            }));
            handleGameStartSignal(gamePlayers, resumeState ? { board: gameState, myTurn: myTurn } : null, randomFirstPlayer);
          }
        }
      } else if (msg.type === 'chat') {
        appendChatMessage(msg.name, msg.text, msg.id, msg.timestamp, msg.color);
      } else if (msg.type === 'START_GAME_SIGNAL') {
        handleGameStartSignal(msg.players, msg.resumeState, msg.firstTurn);
      } else if (msg.type === 'game-offer' || msg.type === 'game-answer' || msg.type === 'game-ice') {
        handleGameSignal(msg);
      }
      updateDiagnostics();
    };
  }
  
  pc.onconnectionstatechange = () => {
    if (lobbyPeers[targetId] && lobbyPeers[targetId].pc !== pc) return;
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
    if (gameHost !== null && gamePlayers.includes(from)) {
      retryGameConnections();
    }
    return;
  }

  if (type === 'game-offer' || type === 'game-answer' || type === 'game-ice') {
    handleGameSignal(sig);
    return;
  }

  if (!lobbyPeers[from]) {
    const pc = new RTCPeerConnection(rtcConfig);
    lobbyPeers[from] = { pc, dc: null, name: 'Unknown', iceQueue: [], routeVia: via || null, lastInitiated: Date.now() };
    
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

function appendChatMessage(author, text, id = null, timestamp = null, color = '#333') {
  if (!id) id = Math.random().toString(36).substring(2);
  if (!timestamp) timestamp = Date.now();

  if (recentChats.some(c => c.id === id)) return;

  const isSystem = (author === 'System');
  const maxAge = isSystem ? 60 * 1000 : 5 * 60 * 1000;

  recentChats.push({ id, author, text, timestamp, color });
  recentChats = recentChats.filter(c => {
    const cMaxAge = (c.author === 'System') ? 60 * 1000 : 5 * 60 * 1000;
    return (Date.now() - c.timestamp) < cMaxAge;
  });

  const timeRemaining = maxAge - (Date.now() - timestamp);
  if (timeRemaining <= 0) return;

  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.style.backgroundColor = color;
  div.innerHTML = `<strong>${author}:</strong> ${text}`;
  chatHistory.appendChild(div);
  chatHistory.scrollTop = chatHistory.scrollHeight;
  setTimeout(() => { if (div.parentNode) div.remove(); }, timeRemaining);
}

window.getOpponentName = function() {
  const otherPeerId = gamePlayers.find(p => p !== myPeerId);
  return (otherPeerId && lobbyPeers[otherPeerId]) ? lobbyPeers[otherPeerId].name : 'Opponent';
};

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
  
  const chatId = Math.random().toString(36).substring(2);
  const timestamp = Date.now();
  appendChatMessage(myName, text, chatId, timestamp, myColor);
  broadcastToLobby({ type: 'chat', name: myName, text, id: chatId, timestamp, color: myColor });
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
  const btn = document.getElementById('btn-save-settings');
  btn.innerText = myName ? "Back to Lobby" : "Save & Return";
  btn.style.backgroundColor = myName ? "#28a745" : "#4a90e2";
  document.getElementById('settings-player-id-section').style.display = 'block';
  
  const colorPicker = document.getElementById('player-color-picker');
  if (colorPicker) colorPicker.value = myColor;

  if (document.getElementById('settings-uuid')) {
    document.getElementById('settings-uuid').value = myUuid;
    document.getElementById('update-uuid-btn').style.display = 'none';
  }

  showScreen('screen-settings');
});

document.getElementById('global-player-name').addEventListener('input', (e) => {
  const newName = e.target.value.trim();
  const btn = document.getElementById('btn-save-settings');
  if (!myName) {
    btn.innerText = "Head to Lobby";
    btn.style.backgroundColor = "#28a745";
  } else {
    const isChanged = (newName && newName !== myName);
    btn.innerText = isChanged ? "Save & Return" : "Back to Lobby";
    btn.style.backgroundColor = isChanged ? "#4a90e2" : "#28a745";
  }
});

function broadcastProfileUpdate() {
  const profileMsg = { type: 'PROFILE_UPDATE', from: myPeerId, name: myName, color: myColor, uuid: myUuid };
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish('5dice/lobby/announce', JSON.stringify({ peerId: myPeerId, name: myName, color: myColor, uuid: myUuid }));
  }
  Object.values(lobbyPeers).forEach(p => {
    if (p.dc && p.dc.readyState === 'open') {
      p.dc.send(JSON.stringify(profileMsg));
    }
  });
}

document.getElementById('btn-save-settings').addEventListener('click', () => {
  const newName = document.getElementById('global-player-name').value.trim();
  if (newName) {
    myName = newName;
    localStorage.setItem('playerName', myName);
    showScreen('screen-lobby');
    if (!mqttClient) {
      startLobbyMesh();
      startRoomPolling();
    } else {
      broadcastProfileUpdate();
    }
  } else {
    alert("Please enter a display name to continue.");
  }
});

const colorPickerEl = document.getElementById('player-color-picker');
if (colorPickerEl) {
  colorPickerEl.addEventListener('input', (e) => {
    myColor = e.target.value;
    localStorage.setItem('playerColor', myColor);
  });
}

document.getElementById('btn-create-new').addEventListener('click', () => {
  showScreen('screen-setup');
});

document.getElementById('btn-cancel-setup').addEventListener('click', () => {
  showScreen('screen-lobby');
});

const gameTypeSelect = document.getElementById('game-type-select');
if (gameTypeSelect) {
  gameTypeSelect.addEventListener('change', (e) => {
    const playerCountSelect = document.getElementById('player-count');
    playerCountSelect.innerHTML = '';
    
    if (e.target.value === 'Tic-Tac-Toe') {
      playerCountSelect.innerHTML = '<option value="2">2 Players</option>';
    } else if (e.target.value === '5 Dice') {
      for (let i = 2; i <= 6; i++) {
        const option = document.createElement('option');
        option.value = i;
        option.innerText = i + ' Players';
        playerCountSelect.appendChild(option);
      }
    }
  });
}

document.getElementById('room-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    document.getElementById('btn-create-room').click();
  }
});

document.getElementById('btn-create-room').addEventListener('click', async () => {
  const roomName = document.getElementById('room-name-input').value || 'New Game';
  const gameType = document.getElementById('game-type-select') ? document.getElementById('game-type-select').value : 'Tic-Tac-Toe';
  const maxPlayers = document.getElementById('player-count') ? parseInt(document.getElementById('player-count').value) : 2;
  
  showLoading('Creating Room...');
  
  const roomId = Math.random().toString(36).substr(2, 9);
  const room = { id: roomId, name: roomName, gameType: gameType, host: myPeerId, status: 'open', players: [myUuid], maxPlayers: maxPlayers };
  activeRooms[roomId] = room;
  isHost = true;
  currentRoomId = roomId;
  document.getElementById('game-room-name').innerText = `🎲 ${roomName} - ${gameType} 🎲`;
  
  broadcastToLobby({ type: 'ROOM_CREATED', room });
  
  setupGameUI(gameType);
  showScreen('screen-game');
  document.getElementById('game-status').innerText = 'Waiting for opponent to join...';
  hideLoading();
});

function setupGameUI(gameType) {
  const tttBoard = document.getElementById('tic-tac-toe-board');
  const fdContainer = document.getElementById('five-dice-container');
  if (gameType === '5 Dice') {
    tttBoard.classList.add('hidden');
    fdContainer.classList.remove('hidden');
    document.body.classList.add('bg-five-dice');
    init5DiceGame();
  } else {
    tttBoard.classList.remove('hidden');
    fdContainer.classList.add('hidden');
    document.body.classList.remove('bg-five-dice');
  }
}

window.joinRoom = function(roomId) {
  const room = activeRooms[roomId];
  if (!room) return alert('Room no longer exists.');
  
  const displayGameType = room.gameType || 'Tic-Tac-Toe';
  document.getElementById('game-room-name').innerText = `🎲 ${room.name} - ${displayGameType} 🎲`;
  
  showLoading('Joining Room...');
  const sendJoin = () => {
    lobbyPeers[room.host].dc.send(JSON.stringify({ type: 'JOIN_ROOM_REQUEST', roomId, guest: myPeerId, guestUuid: myUuid }));
    currentRoomId = roomId;
    isHost = false;
    setupGameUI(displayGameType);
    showScreen('screen-game');
    document.getElementById('game-status').innerText = 'Joined! Waiting for host to start game mesh...';
    hideLoading();
  };

  if (lobbyPeers[room.host] && lobbyPeers[room.host].dc && lobbyPeers[room.host].dc.readyState === 'open') {
    sendJoin();
  } else {
    initiateLobbyConnection(room.host, null);
    let attempts = 0;
    const interval = setInterval(() => {
      if (lobbyPeers[room.host] && lobbyPeers[room.host].dc && lobbyPeers[room.host].dc.readyState === 'open') {
        clearInterval(interval);
        sendJoin();
      } else if (++attempts > 20) { // 5 seconds timeout
        clearInterval(interval);
        hideLoading();
        alert('Failed to connect to the host. They might be offline.');
      }
    }, 250);
  }
};

function renderRooms() {
  const list = document.getElementById('room-list');
  const rooms = Object.values(activeRooms);
  list.innerHTML = '';
  
  let validRoomCount = 0;

  rooms.forEach(r => {
    const isZombie = (r.host !== myPeerId && !lobbyPeers[r.host]);
    
    if (isZombie) {
      if (!r.zombieSince) {
        r.zombieSince = Date.now();
        setTimeout(() => {
          if (activeRooms[r.id] && !lobbyPeers[r.host]) {
             delete activeRooms[r.id];
             renderRooms();
          }
        }, 1000);
      }
      if (Date.now() - r.zombieSince >= 1000) {
        delete activeRooms[r.id];
        return; // Hide
      }
    } else {
      if (r.zombieSince) delete r.zombieSince;
    }

    if (r.status === 'in-progress' && !(r.players && r.players.includes(myUuid))) {
      return; // Hide in-progress games if not a player
    }
    
    validRoomCount++;
    const isReturning = r.status === 'in-progress';
    
    const div = document.createElement('div');
    div.className = 'room-card';
    
    const hostColor = (r.host === myPeerId) ? myColor : ((lobbyPeers[r.host] && lobbyPeers[r.host].color) ? lobbyPeers[r.host].color : '');
    if (hostColor && !isZombie) {
      div.style.backgroundColor = hostColor;
    } else if (isZombie) {
      div.style.backgroundColor = '#555555';
      div.style.opacity = '0.5';
      div.style.filter = 'grayscale(100%)';
    }

    const displayGameType = r.gameType || 'Tic-Tac-Toe';
    div.innerHTML = `
      <h3>${r.name} - ${displayGameType}</h3>
      <p>Host: ${lobbyPeers[r.host] ? lobbyPeers[r.host].name : (isZombie ? 'Disconnected' : r.host)}</p>
      <button class="capsule-button small" onclick="joinRoom('${r.id}')" ${isZombie ? 'disabled' : ''}>${isReturning ? 'Rejoin Game' : 'Join Game'}</button>
    `;
    list.appendChild(div);
  });
  
  document.getElementById('game-count').innerText = `Games Found: ${validRoomCount}`;
}

function startRoomPolling() {
  renderRooms();
}

// --- TIER 2: GAME MESH (ZERO-SERVER) ---
let gameState = ['', '', '', '', '', '', '', '', ''];

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

let myUuid = localStorage.getItem('timeline_user_id');
if (!myUuid) {
  myUuid = generateUUID();
  localStorage.setItem('timeline_user_id', myUuid);
}

let myTurn = false;
Object.defineProperty(window, 'myTurn', { get: () => myTurn, set: (v) => { myTurn = v; } });
let gamePlayers = [];
let gameHost = null;

async function handleGameStartSignal(players, resumeState = null, firstTurn = null) {
  gamePlayers = players;
  gameHost = gamePlayers[0]; // Alphabetical sort means [0] is consistent host
  for (const p in gamePeers) {
    if (gamePeers[p].pc) gamePeers[p].pc.close();
  }
  gamePeers = {};
  
  if (resumeState) {
    gameState = resumeState.board;
    myTurn = resumeState.myTurn;
    updateBoard();
    const isOver = checkWin();
    if (isOver) {
      document.getElementById('btn-play-again').classList.remove('hidden');
    }
    const otherPeerId = gamePlayers.find(p => p !== myPeerId);
    if (otherPeerId) {
      const otherName = lobbyPeers[otherPeerId] ? lobbyPeers[otherPeerId].name : 'A player';
      const otherColor = lobbyPeers[otherPeerId] ? lobbyPeers[otherPeerId].color : '#333';
      showToast(`${otherName} is here`, otherColor);
    }
  } else {
    gameState = ['', '', '', '', '', '', '', '', ''];
    if (firstTurn) {
      myTurn = (myPeerId === firstTurn);
    } else {
      myTurn = (myPeerId === gameHost);
    }
    
    if (activeRooms[currentRoomId] && activeRooms[currentRoomId].gameType === '5 Dice') {
      if (window.update5DiceUI) window.update5DiceUI();
    } else {
      updateBoard();
    }
  }
  document.getElementById('game-status').innerText = `Game Mesh: Syncing...`;

  for (const p of gamePlayers) {
    if (p !== myPeerId) {
      if (myPeerId > p) {
        await initiateGameConnection(p);
      }
    }
  }
  
  if (window.gameMeshRetryInterval) clearInterval(window.gameMeshRetryInterval);
  window.gameMeshRetryInterval = setInterval(() => {
    if (gamePlayers.length > 1) {
      const readyCount = Object.values(gamePeers).filter(p => p.dc && p.dc.readyState === 'open').length;
      if (readyCount < gamePlayers.length - 1) {
        retryGameConnections();
      }
      for (const p of gamePlayers) {
        if (p !== myPeerId) {
          const lPeer = lobbyPeers[p];
          const lNotReady = !lPeer || !lPeer.dc || lPeer.dc.readyState !== 'open';
          if (lNotReady) {
            const isConnecting = lPeer && lPeer.pc && (lPeer.pc.connectionState === 'connecting' || lPeer.pc.connectionState === 'new');
            const isStuck = lPeer && lPeer.lastInitiated && (Date.now() - lPeer.lastInitiated > 6000);
            if ((!isConnecting || isStuck) && myPeerId > p) {
              if (lPeer && lPeer.pc) lPeer.pc.close();
              delete lobbyPeers[p];
              initiateLobbyConnection(p, null);
            }
          }
        }
      }
    }
  }, 3000);
  
  updateDiagnostics();
}

async function initiateGameConnection(targetId) {
  const pc = new RTCPeerConnection(rtcConfig);
  const dc = pc.createDataChannel('game-channel');
  if (!gamePeers[targetId]) gamePeers[targetId] = {};
  gamePeers[targetId].pc = pc;
  gamePeers[targetId].dc = dc;
  gamePeers[targetId].lastInitiated = Date.now();
  if (!gamePeers[targetId].iceQueue) gamePeers[targetId].iceQueue = [];
  setupGamePeer(targetId, pc, dc);

  if (localAudioStream && micEnabled) {
    localAudioStream.getTracks().forEach(track => pc.addTrack(track, localAudioStream));
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  
  sendSignal(targetId, { type: 'game-offer', sdp: offer });
}

function handleConnectionFailure(targetId) {
  if (!gamePeers[targetId]) return;
  
  if (reconnectTimers[targetId]) return;
  
  document.getElementById('reconnecting-overlay').classList.remove('hidden');
  
  reconnectTimers[targetId] = setTimeout(() => {
    document.getElementById('reconnecting-overlay').classList.add('hidden');
    delete reconnectTimers[targetId];
    handlePeerDisconnect(targetId);
  }, 30000);
  
  if (gamePeers[targetId].pc) gamePeers[targetId].pc.close();
  
  if (myPeerId < targetId) {
    setTimeout(() => {
      initiateGameConnection(targetId);
    }, 1000);
  }
}

function retryGameConnections() {
  if (gameHost !== null) {
    for (const targetId of gamePlayers) {
      if (targetId !== myPeerId) {
        const peer = gamePeers[targetId];
        const isNotReady = !peer || !peer.dc || peer.dc.readyState !== 'open';
        
        if (isNotReady) {
          const isConnecting = peer && peer.pc && (peer.pc.connectionState === 'connecting' || peer.pc.connectionState === 'new');
          const isStuck = peer && peer.lastInitiated && (Date.now() - peer.lastInitiated > 6000);
          
          if ((!isConnecting || isStuck) && myPeerId < targetId) {
            initiateGameConnection(targetId);
          }
        }
      }
    }
  }
}

function handlePeerDisconnect(targetId) {
  if (!gamePeers[targetId]) return;
  const name = lobbyPeers[targetId] ? lobbyPeers[targetId].name : 'Opponent';
  const color = lobbyPeers[targetId] ? lobbyPeers[targetId].color : null;
  showToast(`${name} has left`, color);

  if (gamePeers[targetId].pc) gamePeers[targetId].pc.close();
  delete gamePeers[targetId];
  delete remoteAudioStates[targetId];
  updateAudioStateOutline();

  if (currentRoomId && activeRooms[currentRoomId] && activeRooms[currentRoomId].host === targetId) {
    const remainingPlayers = [...gamePlayers].sort();
    if (remainingPlayers.length > 0 && remainingPlayers[0] === myPeerId) {
       isHost = true;
       activeRooms[currentRoomId].host = myPeerId;
       broadcastToLobby({ type: 'ROOM_UPDATED', room: activeRooms[currentRoomId] });
       showToast(`You are now hosting`);
       
       for (const p in gamePeers) {
         if (gamePeers[p].dc && gamePeers[p].dc.readyState === 'open') {
           gamePeers[p].dc.send(JSON.stringify({ type: 'HOST_HANDOFF', newHostId: myPeerId }));
         }
       }
    }
  }
  
  checkGameMeshReady();
}

function setupGamePeer(targetId, pc, dc) {
  pc.ontrack = (event) => {
    const remoteAudio = document.getElementById('remote-audio');
    if (remoteAudio && remoteAudio.srcObject !== event.streams[0]) {
      remoteAudio.srcObject = event.streams[0];
    }
  };

  pc.onconnectionstatechange = () => {
    if (gamePeers[targetId] && gamePeers[targetId].pc !== pc) return;
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      handleConnectionFailure(targetId);
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignal(targetId, { type: 'game-ice', candidate: e.candidate });
    }
  };

  if (dc) {
    let pingInterval;
    let timeoutTimer;
    
    const resetTimeout = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => {
        if (pc.connectionState !== 'closed') {
          handleConnectionFailure(targetId);
        }
      }, 5000); // 5 seconds timeout
    };

    const onOpenHandler = () => {
      if (reconnectTimers[targetId]) {
        clearTimeout(reconnectTimers[targetId]);
        delete reconnectTimers[targetId];
        if (Object.keys(reconnectTimers).length === 0) {
          document.getElementById('reconnecting-overlay').classList.add('hidden');
        }
      }
      checkGameMeshReady();
      broadcastAudioState();
      
      if (gameHost !== null && dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'sync', state: gameState, name: myName, color: myColor }));
      }
      
      pingInterval = setInterval(() => {
        if (dc.readyState === 'open') {
          try {
            dc.send(JSON.stringify({ type: 'ping' }));
          } catch (e) {}
        }
      }, 2000);
      resetTimeout();
    };
    dc.onopen = onOpenHandler;
    if (dc.readyState === 'open') {
      onOpenHandler();
    }
    
    dc.onclose = () => {
      if (pingInterval) clearInterval(pingInterval);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };

    dc.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'ping') {
        resetTimeout();
        return;
      }
      
      if (msg.type === 'move') {
        gameState[msg.index] = msg.player;
        updateBoard();
        const gameOver = checkWin();
        if (!gameOver) {
          myTurn = true; 
          document.getElementById('game-status').innerText = 'Your turn!';
          updateGameBackground();
        } else {
          document.getElementById('btn-play-again').classList.remove('hidden');
        }
      } else if (msg.type === 'PLAY_AGAIN') {
        const room = activeRooms[currentRoomId];
        if (room && room.gameType === '5 Dice') {
          if (window.reset5DiceGame) window.reset5DiceGame(msg.firstTurn);
        } else {
          resetGame(msg.firstTurn);
        }
      } else if (msg.type === 'sync') {
        if (msg.name) {
          if (!lobbyPeers[targetId]) lobbyPeers[targetId] = { name: 'Unknown', iceQueue: [] };
          lobbyPeers[targetId].name = msg.name;
          if (msg.color) lobbyPeers[targetId].color = msg.color;
        }
        const room = activeRooms[currentRoomId];
        if (room && room.gameType !== '5 Dice') {
          let updated = false;
          for (let i = 0; i < 9; i++) {
            if (gameState[i] === '' && msg.state[i] !== '') {
              gameState[i] = msg.state[i];
              updated = true;
            }
          }
          if (updated) {
            updateBoard();
            const gameOver = checkWin();
            if (!gameOver) {
               const xCount = gameState.filter(s => s === 'X').length;
               const oCount = gameState.filter(s => s === 'O').length;
               if (myPeerId === gameHost) {
                 myTurn = (xCount === oCount);
               } else {
                 myTurn = (xCount > oCount);
               }
               document.getElementById('game-status').innerText = myTurn ? 'Your turn!' : `${window.getOpponentName()}'s turn`;
               updateGameBackground();
            } else {
               document.getElementById('btn-play-again').classList.remove('hidden');
            }
          } else {
            document.getElementById('game-status').innerText = myTurn ? 'Your turn!' : `${window.getOpponentName()}'s turn`;
            updateGameBackground();
          }
        }
      } else if (msg.type === 'HOST_HANDOFF') {
        const newHostId = msg.newHostId;
        if (activeRooms[currentRoomId]) {
          activeRooms[currentRoomId].host = newHostId;
        }
        if (myPeerId === newHostId) {
          isHost = true;
          if (activeRooms[currentRoomId]) {
            broadcastToLobby({ type: 'ROOM_UPDATED', room: activeRooms[currentRoomId] });
          }
        }
        const newHostName = (newHostId === myPeerId) ? 'You' : (lobbyPeers[newHostId] ? lobbyPeers[newHostId].name : 'A player');
        showToast(`${newHostName} ${newHostId === myPeerId ? 'are' : 'is'} now hosting`);
      } else if (msg.type === 'AUDIO_STATE') {
        remoteAudioStates[msg.peerId] = { micEnabled: msg.micEnabled, speakerEnabled: msg.speakerEnabled };
        updateAudioStateOutline();
      } else if (msg.type === 'PLAYER_LEFT') {
        gamePlayers = gamePlayers.filter(p => p !== msg.peerId);
        handlePeerDisconnect(msg.peerId);
      } else if (msg.type.startsWith('5DICE_')) {
        if (typeof window.handle5DiceMessage === 'function') {
          window.handle5DiceMessage(msg);
        }
      }
    };
  }
}

async function handleGameSignal(msg) {
  const { type, from, sdp, candidate } = msg;
  
  if (type === 'game-offer') {
    let pc;
    if (gamePeers[from] && gamePeers[from].pc && gamePeers[from].pc.signalingState !== 'closed') {
      pc = gamePeers[from].pc;
    } else {
      if (gamePeers[from] && gamePeers[from].pc) {
        gamePeers[from].pc.close();
      }
      pc = new RTCPeerConnection(rtcConfig);
      if (!gamePeers[from]) gamePeers[from] = {};
      gamePeers[from].pc = pc;
      gamePeers[from].dc = null;
      if (!gamePeers[from].iceQueue) gamePeers[from].iceQueue = [];
      
      if (localAudioStream && micEnabled) {
        localAudioStream.getTracks().forEach(track => pc.addTrack(track, localAudioStream));
      }
      
      pc.ondatachannel = (e) => {
        if (e.channel.label === 'game-channel') {
          gamePeers[from].dc = e.channel;
          setupGamePeer(from, pc, e.channel);
          checkGameMeshReady();
        }
      };
      setupGamePeer(from, pc, null);
    }
    
    await pc.setRemoteDescription(sdp);
    
    if (gamePeers[from].iceQueue) {
      for (const cand of gamePeers[from].iceQueue) {
        await pc.addIceCandidate(cand).catch(e => console.error(e));
      }
      gamePeers[from].iceQueue = [];
    }
    
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    sendSignal(from, { type: 'game-answer', sdp: answer });
  } else if (type === 'game-answer') {
    await gamePeers[from].pc.setRemoteDescription(sdp);
    if (gamePeers[from].iceQueue) {
      for (const cand of gamePeers[from].iceQueue) {
        await gamePeers[from].pc.addIceCandidate(cand).catch(e => console.error(e));
      }
      gamePeers[from].iceQueue = [];
    }
  } else if (type === 'game-ice') {
    if (gamePeers[from] && gamePeers[from].pc && gamePeers[from].pc.remoteDescription) {
      await gamePeers[from].pc.addIceCandidate(candidate).catch(e => console.error(e));
    } else {
      if (!gamePeers[from]) gamePeers[from] = {};
      if (!gamePeers[from].iceQueue) gamePeers[from].iceQueue = [];
      gamePeers[from].iceQueue.push(candidate);
    }
  }
}

function updateGameBackground() {
  const gameScreen = document.getElementById('screen-game');
  gameScreen.classList.remove('tie-background', 'bg-watermark-x', 'bg-watermark-o');
  
  if (gameHost !== null) {
    const mySymbol = (myPeerId === gameHost) ? 'X' : 'O';
    gameScreen.classList.add(`bg-watermark-${mySymbol.toLowerCase()}`);
  }

  let opponentId = gamePlayers.find(p => p !== myPeerId);
  let opponentColor = (opponentId && lobbyPeers[opponentId] && lobbyPeers[opponentId].color) ? lobbyPeers[opponentId].color : '#2a2a2a';
  
  if (myTurn) {
    gameScreen.style.backgroundColor = myColor;
  } else {
    gameScreen.style.backgroundColor = opponentColor;
  }
}

function checkGameMeshReady() {
  if (typeof gamePlayers === 'undefined' || gamePlayers.length === 0) return;
  const ready = Object.values(gamePeers).every(p => p.dc && p.dc.readyState === 'open');
  if (ready && Object.keys(gamePeers).length === gamePlayers.length - 1) {
    if (!checkWin()) {
      if (activeRooms[currentRoomId] && activeRooms[currentRoomId].gameType === '5 Dice') {
        if (window.update5DiceUI) window.update5DiceUI();
      } else {
        document.getElementById('game-status').innerText = `Your turn!`;
        if (!myTurn) document.getElementById('game-status').innerText = `${window.getOpponentName()}'s turn`;
        document.getElementById('tic-tac-toe-board').classList.remove('disabled');
        updateGameBackground();
      }
    }
  } else {
    if (!activeRooms[currentRoomId] || activeRooms[currentRoomId].gameType !== '5 Dice') {
      const board = document.getElementById('tic-tac-toe-board');
      if (board) board.classList.add('disabled');
      document.getElementById('game-status').innerText = 'Waiting for opponent to reconnect...';
    }
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

  const gameDot = document.getElementById('game-network-dot');
  const gameTxt = document.getElementById('game-status-text');
  const gamePlayerCount = document.getElementById('game-player-count');

  if (gameDot && gameTxt && gamePlayerCount) {
    gamePlayerCount.innerText = `Players: ${gameCount + 1}`;
    if (gameCount > 0) {
      gameDot.className = 'status-dot connected';
      gameTxt.innerText = `GAME MESH: ${gameCount} PEER(S)`;
    } else {
      gameDot.className = 'status-dot connecting';
      gameTxt.innerText = `GAME MESH: SEEKING...`;
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
      try {
        gamePeers[p].dc.send(JSON.stringify({ type: 'move', index, player: mySymbol }));
      } catch (err) {
        console.error('Failed to send move:', err);
      }
    }
  }
  if (!gameOver) {
    myTurn = false;
    document.getElementById('game-status').innerText = `${window.getOpponentName()}'s turn`;
    updateGameBackground();
  } else {
    document.getElementById('btn-play-again').classList.remove('hidden');
  }
}

function resetGame(firstTurn = null) {
  gameState = ['', '', '', '', '', '', '', '', ''];
  if (firstTurn) {
    myTurn = (myPeerId === firstTurn);
  } else {
    myTurn = (myPeerId === gameHost);
  }
  updateBoard();
  document.getElementById('tic-tac-toe-board').classList.remove('disabled');
  document.getElementById('btn-play-again').classList.add('hidden');
  
  if (window.gameMeshRetryInterval) clearInterval(window.gameMeshRetryInterval);
  window.gameMeshRetryInterval = setInterval(() => {
    if (gamePlayers.length > 1) {
      const readyCount = Object.values(gamePeers).filter(p => p.dc && p.dc.readyState === 'open').length;
      if (readyCount < gamePlayers.length - 1) {
        retryGameConnections();
      }
      for (const p of gamePlayers) {
        if (p !== myPeerId) {
          const lPeer = lobbyPeers[p];
          const lNotReady = !lPeer || !lPeer.dc || lPeer.dc.readyState !== 'open';
          if (lNotReady) {
            const isConnecting = lPeer && lPeer.pc && (lPeer.pc.connectionState === 'connecting' || lPeer.pc.connectionState === 'new');
            const isStuck = lPeer && lPeer.lastInitiated && (Date.now() - lPeer.lastInitiated > 6000);
            if ((!isConnecting || isStuck) && myPeerId > p) {
              if (lPeer && lPeer.pc) lPeer.pc.close();
              delete lobbyPeers[p];
              initiateLobbyConnection(p, null);
            }
          }
        }
      }
    }
  }, 3000);

  document.getElementById('screen-game').classList.remove('tie-background');
  updateGameBackground();
  checkGameMeshReady();
}

document.getElementById('btn-play-again').addEventListener('click', () => {
  const otherPeerId = gamePlayers.find(p => p !== myPeerId);
  const nextFirstTurn = Math.random() < 0.5 ? myPeerId : otherPeerId;
  for (const p in gamePeers) {
    if (gamePeers[p].dc && gamePeers[p].dc.readyState === 'open') {
      gamePeers[p].dc.send(JSON.stringify({ type: 'PLAY_AGAIN', firstTurn: nextFirstTurn }));
    }
  }
  const room = activeRooms[currentRoomId];
  if (room && room.gameType === '5 Dice') {
    if (window.reset5DiceGame) window.reset5DiceGame(nextFirstTurn);
  } else {
    resetGame(nextFirstTurn);
  }
});

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
      let opponentId = gamePlayers.find(p => p !== myPeerId);
      let opponentColor = (opponentId && lobbyPeers[opponentId] && lobbyPeers[opponentId].color) ? lobbyPeers[opponentId].color : '#2a2a2a';
      let opponentName = (opponentId && lobbyPeers[opponentId] && lobbyPeers[opponentId].name) ? lobbyPeers[opponentId].name : 'Opponent';
      let winnerColor = (winner === mySymbol) ? myColor : opponentColor;
      
      document.getElementById('game-status').innerText = (winner === mySymbol) ? 'You Win!' : `${opponentName} Wins!`;
      document.getElementById('tic-tac-toe-board').classList.add('disabled');
      myTurn = false;
      document.getElementById('screen-game').style.backgroundColor = winnerColor;
      return true;
    }
  }
  if (!gameState.includes('')) {
    document.getElementById('game-status').innerText = "It's a draw!";
    myTurn = false;
    
    let opponentId = gamePlayers.find(p => p !== myPeerId);
    let opponentColor = (opponentId && lobbyPeers[opponentId] && lobbyPeers[opponentId].color) ? lobbyPeers[opponentId].color : '#2a2a2a';
    
    const gameScreen = document.getElementById('screen-game');
    gameScreen.style.setProperty('--color-1', myColor);
    gameScreen.style.setProperty('--color-2', opponentColor);
    gameScreen.style.backgroundColor = '';
    gameScreen.classList.add('tie-background');
    return true;
  }
  return false;
}

const handleLeaveGame = () => {
  const gameScreen = document.getElementById('screen-game');
  gameScreen.style.backgroundColor = '#2a2a2a';
  gameScreen.classList.remove('tie-background');
  
  if (isHost && currentRoomId) {
    const connectedPeers = Object.keys(gamePeers).filter(p => gamePeers[p].dc && gamePeers[p].dc.readyState === 'open');
    if (connectedPeers.length > 0) {
      const newHostId = connectedPeers[0];
      for (const p in gamePeers) {
        if (gamePeers[p].dc && gamePeers[p].dc.readyState === 'open') {
          gamePeers[p].dc.send(JSON.stringify({ type: 'HOST_HANDOFF', newHostId }));
        }
      }
    } else {
      broadcastToLobby({ type: 'ROOM_CLOSED', roomId: currentRoomId });
      delete activeRooms[currentRoomId];
    }
  }

  for (const p in gamePeers) {
    if (gamePeers[p].dc && gamePeers[p].dc.readyState === 'open') {
      gamePeers[p].dc.send(JSON.stringify({ type: 'PLAYER_LEFT', peerId: myPeerId }));
    }
    const pc = gamePeers[p].pc;
    if (pc) {
      setTimeout(() => pc.close(), 500);
    }
  }
  gamePeers = {};
  gamePlayers = [];
  gameState = ['', '', '', '', '', '', '', '', ''];
  updateBoard();
  document.getElementById('tic-tac-toe-board').classList.add('disabled');
  document.getElementById('btn-play-again').classList.add('hidden');
  
  if (window.gameMeshRetryInterval) {
    clearInterval(window.gameMeshRetryInterval);
    window.gameMeshRetryInterval = null;
  }
  
  isHost = false;
  currentRoomId = null;
  
  showScreen('screen-lobby');
  startRoomPolling();
  updateDiagnostics();
};

const headerBackBtn = document.getElementById('btn-back-lobby-header');
if (headerBackBtn) headerBackBtn.addEventListener('click', handleLeaveGame);

// --- PLAYER ID SYNC LOGIC ---
const settingsUuidInput = document.getElementById('settings-uuid');
const updateUuidBtn = document.getElementById('update-uuid-btn');
const copyUuidBtn = document.getElementById('copy-uuid-btn');
const pasteUuidBtn = document.getElementById('paste-uuid-btn');
const confirmUuidModal = document.getElementById('confirm-uuid-modal');
const confirmUuidYes = document.getElementById('confirm-uuid-yes');
const confirmUuidNo = document.getElementById('confirm-uuid-no');
const newUuidDisplay = document.getElementById('new-uuid-display');
const toastEl = document.getElementById('toast');

let pendingUuid = null;

function showToast(msg, bgColor = null) {
  if (!toastEl) return;
  toastEl.innerText = msg;
  toastEl.style.backgroundColor = bgColor || '#333';
  toastEl.classList.remove('hidden');
  setTimeout(() => { toastEl.classList.add('hidden'); }, 3000);
}

if (settingsUuidInput) {
  settingsUuidInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(val) && val !== myUuid) {
      updateUuidBtn.style.display = 'block';
    } else {
      updateUuidBtn.style.display = 'none';
    }
  });
}

if (copyUuidBtn) {
  copyUuidBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(myUuid).then(() => {
      showToast("Player ID copied!");
    }).catch(() => {
      showToast("Unable to copy ID");
    });
  });
}

if (pasteUuidBtn) {
  pasteUuidBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      settingsUuidInput.value = text.trim();
      settingsUuidInput.dispatchEvent(new Event('input'));
      showToast("ID pasted from clipboard");
    } catch (e) {
      showToast("Unable to paste ID");
    }
  });
}

if (updateUuidBtn) {
  updateUuidBtn.addEventListener('click', () => {
    pendingUuid = settingsUuidInput.value.trim();
    newUuidDisplay.innerText = pendingUuid;
    confirmUuidModal.classList.remove('hidden');
  });
}

if (confirmUuidNo) {
  confirmUuidNo.addEventListener('click', () => {
    confirmUuidModal.classList.add('hidden');
    settingsUuidInput.value = myUuid;
    updateUuidBtn.style.display = 'none';
    pendingUuid = null;
  });
}

if (confirmUuidYes) {
  confirmUuidYes.addEventListener('click', () => {
    myUuid = pendingUuid;
    localStorage.setItem('timeline_user_id', pendingUuid);
    confirmUuidModal.classList.add('hidden');
    showToast("Player ID synced! Reloading...");
    setTimeout(() => location.reload(), 1500);
  });
}

createBoard();
if (!myName) {
  document.getElementById('settings-player-id-section').style.display = 'none';
  const btn = document.getElementById('btn-save-settings');
  btn.innerText = "Head to Lobby";
  btn.style.backgroundColor = "#28a745";
  const colorPicker = document.getElementById('player-color-picker');
  if (colorPicker) colorPicker.value = myColor;
  showScreen('screen-settings');
} else {
  startLobbyMesh();
  startRoomPolling();
}

// --- AUDIO UI CONTROL LOGIC ---
const btnToggleMic = document.getElementById('btn-toggle-mic');
const btnToggleSpeaker = document.getElementById('btn-toggle-speaker');
const iconMicOn = document.getElementById('icon-mic-on');
const iconMicOff = document.getElementById('icon-mic-off');
const iconSpeakerOn = document.getElementById('icon-speaker-on');
const iconSpeakerOff = document.getElementById('icon-speaker-off');
const remoteAudio = document.getElementById('remote-audio');

async function enableMic() {
  try {
    if (!localAudioStream) {
      localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    // Add track to all existing game peers if not already added
    for (const p in gamePeers) {
      if (gamePeers[p].pc) {
        const senders = gamePeers[p].pc.getSenders();
        const hasTrack = senders.find(s => s.track && s.track.kind === 'audio');
        if (!hasTrack) {
           localAudioStream.getTracks().forEach(track => {
             gamePeers[p].pc.addTrack(track, localAudioStream);
           });
           const offer = await gamePeers[p].pc.createOffer();
           await gamePeers[p].pc.setLocalDescription(offer);
           sendSignal(p, { type: 'game-offer', sdp: offer });
        }
      }
    }
    localAudioStream.getTracks().forEach(t => t.enabled = true);
    micEnabled = true;
    localStorage.setItem('micEnabled', 'true');
    broadcastAudioState();
    if (btnToggleMic) {
      btnToggleMic.classList.remove('off');
      iconMicOn.classList.remove('hidden');
      iconMicOff.classList.add('hidden');
    }
  } catch (err) {
    console.error("Microphone access denied:", err);
    showToast("Microphone access denied", "#dc3545");
    micEnabled = false;
    localStorage.setItem('micEnabled', 'false');
  }
}

function disableMic() {
  if (localAudioStream) {
    localAudioStream.getTracks().forEach(t => t.enabled = false);
  }
  micEnabled = false;
  localStorage.setItem('micEnabled', 'false');
  broadcastAudioState();
  if (btnToggleMic) {
    btnToggleMic.classList.add('off');
    iconMicOn.classList.add('hidden');
    iconMicOff.classList.remove('hidden');
  }
}

function updateSpeakerState() {
  if (remoteAudio) {
    remoteAudio.muted = !speakerEnabled;
  }
  broadcastAudioState();
  if (btnToggleSpeaker) {
    if (speakerEnabled) {
      btnToggleSpeaker.classList.remove('off');
      iconSpeakerOn.classList.remove('hidden');
      iconSpeakerOff.classList.add('hidden');
    } else {
      btnToggleSpeaker.classList.add('off');
      iconSpeakerOn.classList.add('hidden');
      iconSpeakerOff.classList.remove('hidden');
    }
  }
}

if (btnToggleMic && btnToggleSpeaker) {
  if (micEnabled) {
    // Defer a bit so UI doesn't block immediately on load
    setTimeout(enableMic, 500);
  } else {
    disableMic();
  }
  updateSpeakerState();

  btnToggleMic.addEventListener('click', () => {
    if (micEnabled) {
      disableMic();
    } else {
      enableMic();
    }
  });

  btnToggleSpeaker.addEventListener('click', () => {
    speakerEnabled = !speakerEnabled;
    localStorage.setItem('speakerEnabled', speakerEnabled.toString());
    updateSpeakerState();
  });
}
