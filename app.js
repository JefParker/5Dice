// --- GLOBALS ---
let myPeerId = sessionStorage.getItem('myPeerId');
if (!myPeerId) {
  myPeerId = 'peer-' + Math.random().toString(36).substr(2, 9);
  sessionStorage.setItem('myPeerId', myPeerId);
}
window.myPeerId = myPeerId;

function generateDarkColor() {
  const colors = ["#235880", "#3F1F74", "#6F4F1F", "#2E2B53", "#264C1C", "#533A51", "#220066", "MidnightBlue", "#4d004d", "RebeccaPurple", "Sienna", "#181B59", "#006652", "#006666", "#404040"];
  return colors[Math.floor(Math.random() * colors.length)];
}

let myColor = localStorage.getItem('playerColor');
if (!myColor) {
  myColor = generateDarkColor();
  localStorage.setItem('playerColor', myColor);
}

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

let myName = localStorage.getItem('playerName') || '';
let currentRoomId = null; 
let activeRooms = {}; // { roomId: { id, name, host, ... } }
let isHost = false;
let recentChats = []; // { id, author, text, timestamp }

// --- GAME STATE GLOBALS ---
let gameState = ['', '', '', '', '', '', '', '', ''];
let myTurn = false;
let gamePlayers = [];
let gameHost = null;
let roomPlayerDetails = [];

Object.defineProperty(window, 'myTurn', { get: () => myTurn, set: (v) => { myTurn = v; } });
Object.defineProperty(window, 'gamePlayers', { get: () => gamePlayers, set: (v) => { gamePlayers = v; } });
Object.defineProperty(window, 'gameHost', { get: () => gameHost, set: (v) => { gameHost = v; } });
Object.defineProperty(window, 'myPeerId', { get: () => myPeerId });
Object.defineProperty(window, 'myName', { get: () => myName });
Object.defineProperty(window, 'myColor', { get: () => myColor });

// Audio state stub
let localAudioStream = null;
let micEnabled = false;
let speakerEnabled = false;

// --- WAKE LOCK LOGIC ---
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

// --- FIREBASE LOBBY & DIAGNOSTICS ---

function updateDiagnostics() {
  const isConnected = window.firebaseGameBackend && window.firebaseGameBackend.isConnected;
  
  const dot = document.getElementById('network-dot');
  const txt = document.getElementById('status-text');
  
  if (dot && txt) {
    if (isConnected) {
      dot.className = 'status-dot connected';
      txt.innerText = `LOBBY: ONLINE (FIREBASE)`;
    } else {
      dot.className = 'status-dot connecting';
      txt.innerText = `LOBBY: CONNECTING...`;
    }
  }

  const gameDot = document.getElementById('game-network-dot');
  const gameTxt = document.getElementById('game-status-text');
  const gamePlayerCount = document.getElementById('game-player-count');

  if (gameDot && gameTxt && gamePlayerCount) {
    const pCount = gamePlayers.length > 0 ? gamePlayers.length : 1;
    gamePlayerCount.innerText = `Players: ${pCount}`;
    if (isConnected) {
      gameDot.className = 'status-dot connected';
      gameTxt.innerText = `GAME: ONLINE (FIREBASE)`;
    } else {
      gameDot.className = 'status-dot connecting';
      gameTxt.innerText = `GAME: CONNECTING...`;
    }
  }
}
window.updateDiagnostics = updateDiagnostics;

function startLobbyFirebase() {
  if (!window.firebaseGameBackend) {
    window.addEventListener('firebaseGameReady', startLobbyFirebase, { once: true });
    return;
  }

  window.firebaseGameBackend.init((connected) => {
    updateDiagnostics();
  });

  window.firebaseGameBackend.listenRooms((rooms) => {
    activeRooms = rooms || {};
    renderRooms();
    updateDiagnostics();
  });

  window.firebaseGameBackend.listenLobbyChat((msg) => {
    appendChatMessage(msg.author, msg.text, msg.id, msg.timestamp, msg.color);
  });

  updateDiagnostics();
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
  div.style.backgroundColor = color || '#333';
  div.innerHTML = `<strong>${author}:</strong> ${text}`;
  chatHistory.appendChild(div);
  chatHistory.scrollTop = chatHistory.scrollHeight;
  setTimeout(() => { if (div.parentNode) div.remove(); }, timeRemaining);
}

window.getOpponentName = function() {
  const otherPlayer = roomPlayerDetails.find(p => p.peerId !== myPeerId);
  return otherPlayer ? otherPlayer.name : 'Opponent';
};

window.getOpponentColor = function() {
  if (!roomPlayerDetails || !Array.isArray(roomPlayerDetails)) return '#333';
  const otherPlayer = roomPlayerDetails.find(p => p.peerId !== myPeerId);
  return (otherPlayer && otherPlayer.color) ? otherPlayer.color : '#333';
};

btnChatSend.addEventListener('click', () => {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  
  const chatId = Math.random().toString(36).substring(2);
  const timestamp = Date.now();
  const msgObj = { id: chatId, author: myName, text, timestamp, color: myColor };

  if (window.firebaseGameBackend) {
    window.firebaseGameBackend.sendLobbyChat(msgObj);
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

// --- SETTINGS UI ---

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

document.getElementById('btn-save-settings').addEventListener('click', () => {
  const newName = document.getElementById('global-player-name').value.trim();
  if (newName) {
    myName = newName;
    localStorage.setItem('playerName', myName);
    showScreen('screen-lobby');
    startLobbyFirebase();
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

// --- ROOM CREATION & LOBBY RENDER ---

document.getElementById('btn-create-new').addEventListener('click', () => {
  showScreen('screen-setup');
  setTimeout(() => {
    const input = document.getElementById('room-name-input');
    if (input) input.focus();
  }, 50);
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
  const playerObj = { peerId: myPeerId, uuid: myUuid, name: myName, color: myColor };
  
  const room = {
    id: roomId,
    name: roomName,
    gameType: gameType,
    host: myPeerId,
    hostUuid: myUuid,
    hostName: myName,
    hostColor: myColor,
    status: 'open',
    players: [playerObj],
    maxPlayers: maxPlayers,
    lastActive: Date.now()
  };

  const initialScores = {};
  initialScores[myPeerId] = {
    ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
    chance: null, 'three-kind': null, 'four-kind': null, 'full-house': null,
    'sm-straight': null, 'lg-straight': null, 'five-dice': null, 'bonus-5s': null
  };

  const initialGameData = {
    roomId: roomId,
    gameType: gameType,
    host: myPeerId,
    status: 'open',
    players: [playerObj],
    currentTurnPlayerId: myPeerId,
    gameState: ['', '', '', '', '', '', '', '', ''],
    fiveDiceState: {
      dice: [1, 1, 1, 1, 1],
      held: [false, false, false, false, false],
      rollsLeft: 3,
      scores: initialScores,
      turnsLeft: 13,
      isGameOver: false
    }
  };

  currentRoomId = roomId;
  isHost = true;

  await window.firebaseGameBackend.createRoom(room);
  await window.firebaseGameBackend.initGameSession(roomId, initialGameData);

  document.getElementById('game-room-name').innerText = `🎲 ${roomName} - ${gameType} 🎲`;
  
  setupGameUI(gameType);
  showScreen('screen-game');
  document.getElementById('game-status').innerText = 'Waiting for players to join...';
  
  startListeningToGameSession(roomId);
  hideLoading();
});

function renderRooms() {
  const list = document.getElementById('room-list');
  const rooms = Object.values(activeRooms);
  list.innerHTML = '';
  
  let validRoomCount = 0;

  rooms.forEach(r => {
    if (!r || !r.id) return;
    const playerList = r.players || [];
    const isPlayer = playerList.some(p => p.uuid === myUuid || p.peerId === myPeerId);

    if (r.status === 'in-progress' && !isPlayer) {
      return; // Hide in-progress games if not a player
    }
    
    validRoomCount++;
    const isReturning = r.status === 'in-progress' && isPlayer;
    
    const div = document.createElement('div');
    div.className = 'room-card';
    if (isReturning) {
      div.style.border = '2px solid #00ffcc';
    }
    
    const hostColor = r.hostColor || '#28a745';
    div.style.backgroundColor = hostColor;

    const displayGameType = r.gameType || 'Tic-Tac-Toe';
    let seatText = '';
    let isFull = false;
    if (isReturning) {
      seatText = `<p style="font-size: 0.85rem; margin-top: 4px; font-weight: bold; color: #00ffcc;">🎮 Game In Progress (You are playing)</p>`;
    } else if (r.maxPlayers && r.status === 'open') {
      const currentCount = playerList.length;
      const emptySeats = Math.max(0, r.maxPlayers - currentCount);
      isFull = emptySeats === 0;
      seatText = `<p style="font-size: 0.85rem; margin-top: 4px; font-weight: bold; color: ${isFull ? '#ff4444' : '#44ff44'};">` + 
                 (isFull ? 'Game Full' : `${emptySeats} Seat${emptySeats === 1 ? '' : 's'} Remaining`) + 
                 `</p>`;
    }
    
    div.innerHTML = `
      <h3>${r.name} - ${displayGameType}</h3>
      <p>Host: ${r.hostName || 'Host'}</p>
      ${seatText}
      <button class="capsule-button small" onclick="joinRoom('${r.id}')" ${isFull && !isReturning ? 'disabled' : ''} style="${isReturning ? 'background-color: #0088cc; font-weight: bold;' : ''}">${isReturning ? 'Rejoin Game' : 'Join Game'}</button>
    `;
    list.appendChild(div);
  });
  
  document.getElementById('game-count').innerText = `Games Found: ${validRoomCount}`;
}

window.joinRoom = async function(roomId) {
  const room = activeRooms[roomId];
  if (!room) return alert('Room no longer exists.');
  
  const displayGameType = room.gameType || 'Tic-Tac-Toe';
  document.getElementById('game-room-name').innerText = `🎲 ${room.name} - ${displayGameType} 🎲`;
  
  showLoading('Joining Room...');
  currentRoomId = roomId;
  isHost = (room.host === myPeerId);

  let players = room.players || [];
  const existingPlayerIndex = players.findIndex(p => p.uuid === myUuid || p.peerId === myPeerId);
  
  if (existingPlayerIndex < 0) {
    players.push({ peerId: myPeerId, uuid: myUuid, name: myName, color: myColor });
  } else {
    players[existingPlayerIndex] = { peerId: myPeerId, uuid: myUuid, name: myName, color: myColor };
  }

  const isFullNow = players.length >= (room.maxPlayers || 2);
  const updatedStatus = isFullNow ? 'in-progress' : room.status;

  await window.firebaseGameBackend.updateRoom(roomId, {
    players: players,
    status: updatedStatus
  });

  await window.firebaseGameBackend.updateGameState(roomId, {
    players: players,
    status: updatedStatus
  });

  setupGameUI(displayGameType, updatedStatus === 'in-progress');
  showScreen('screen-game');
  
  startListeningToGameSession(roomId);
  hideLoading();
};

function setupGameUI(gameType, isRejoin = false) {
  const tttBoard = document.getElementById('tic-tac-toe-board');
  const fdContainer = document.getElementById('five-dice-container');
  if (gameType === '5 Dice') {
    tttBoard.classList.add('hidden');
    fdContainer.classList.remove('hidden');
    document.body.classList.add('bg-five-dice');
    if (!window.dice3d && typeof Dice3D !== 'undefined') {
      window.dice3d = new Dice3D();
    }
    if (!isRejoin || !window.fiveDiceState || window.fiveDiceState.isGameOver) {
      init5DiceGame();
    } else {
      update5DiceUI();
    }
  } else {
    tttBoard.classList.remove('hidden');
    fdContainer.classList.add('hidden');
    document.body.classList.remove('bg-five-dice');
  }
}

// --- GAME SESSION FIREBASE SYNC & ACTIONS ---

function startListeningToGameSession(roomId) {
  if (!window.firebaseGameBackend) return;

  window.firebaseGameBackend.listenGameState(roomId, (gameData) => {
    if (!gameData) return;
    handleGameStateUpdate(gameData);
  });

  window.firebaseGameBackend.listenGameEvents(roomId, (eventObj) => {
    if (!eventObj) return;
    handleGameEvent(eventObj);
  });
}

function handleGameStateUpdate(gameData) {
  roomPlayerDetails = gameData.players || [];
  gamePlayers = roomPlayerDetails.map(p => p.peerId);
  gameHost = gameData.host || (gamePlayers.length > 0 ? gamePlayers[0] : null);

  const turnPlayerId = gameData.currentTurnPlayerId || gameHost;
  window.currentTurnPlayerId = turnPlayerId;
  myTurn = (myPeerId === turnPlayerId);

  const room = activeRooms[currentRoomId] || gameData;
  const is5Dice = (room && room.gameType === '5 Dice');

  if (is5Dice) {
    if (gameData.fiveDiceState) {
      // Ensure all players are initialized in scores structure
      const scores = gameData.fiveDiceState.scores || {};
      for (const p of gamePlayers) {
        if (!scores[p]) {
          scores[p] = {
            ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
            chance: null, 'three-kind': null, 'four-kind': null, 'full-house': null,
            'sm-straight': null, 'lg-straight': null, 'five-dice': null, 'bonus-5s': null
          };
        }
      }
      gameData.fiveDiceState.scores = scores;

      if (window.sync5DiceState) {
        window.sync5DiceState(gameData.fiveDiceState);
      }
    }
    if (!window.fiveDiceState || !window.fiveDiceState.isGameOver) {
      document.getElementById('game-status').innerText = window.myTurn ? 'Your turn!' : `${window.getOpponentName()}'s turn...`;
    }
  } else {
    if (gameData.gameState) {
      gameState = gameData.gameState;
      updateBoard();
      const isOver = checkWin();
      if (!isOver) {
        document.getElementById('game-status').innerText = myTurn ? 'Your turn!' : `${window.getOpponentName()}'s turn`;
        document.getElementById('tic-tac-toe-board').classList.remove('disabled');
      } else {
        document.getElementById('btn-play-again').classList.remove('hidden');
      }
    }
  }

  updateGameBackground();
  updateDiagnostics();
}

function handleGameEvent(evt) {
  if (evt.sender === myPeerId) return; // Skip echo of our own events

  if (evt.type === 'PLAY_AGAIN') {
    const room = activeRooms[currentRoomId];
    if (room && room.gameType === '5 Dice') {
      if (window.reset5DiceGame) window.reset5DiceGame(evt.firstTurn);
    } else {
      resetGame(evt.firstTurn);
    }
  } else if (evt.type && evt.type.startsWith('5DICE_')) {
    if (typeof window.handle5DiceMessage === 'function') {
      window.handle5DiceMessage(evt);
    }
  }
}

window.sendGameAction = async function(msgObj) {
  if (!currentRoomId || !window.firebaseGameBackend) return;

  const eventPayload = {
    ...msgObj,
    sender: myPeerId
  };
  await window.firebaseGameBackend.sendGameEvent(currentRoomId, eventPayload);

  // Synchronize overall state in Firebase
  const updates = { lastUpdated: Date.now() };

  if (activeRooms[currentRoomId] && activeRooms[currentRoomId].gameType === '5 Dice') {
    updates.fiveDiceState = window.fiveDiceState;
    if (window.currentTurnPlayerId) {
      updates.currentTurnPlayerId = window.currentTurnPlayerId;
    }
  }

  await window.firebaseGameBackend.updateGameState(currentRoomId, updates);
};

function updateGameBackground() {
  const gameScreen = document.getElementById('screen-game');
  if (!gameScreen) return;
  gameScreen.classList.remove('tie-background', 'bg-watermark-x', 'bg-watermark-o');
  
  const room = activeRooms[currentRoomId];
  if (gameHost !== null && (!room || room.gameType !== '5 Dice')) {
    const mySymbol = (myPeerId === gameHost) ? 'X' : 'O';
    gameScreen.classList.add(`bg-watermark-${mySymbol.toLowerCase()}`);
  }

  const activeTurnId = window.currentTurnPlayerId || gameHost;
  const activeTurnPlayer = roomPlayerDetails.find(p => p.peerId === activeTurnId);
  const activeOpponent = roomPlayerDetails.find(p => p.peerId !== myPeerId);
  const turnColor = activeTurnPlayer ? activeTurnPlayer.color : (activeOpponent ? activeOpponent.color : '#2a2a2a');
  
  if (window.myTurn) {
    gameScreen.style.backgroundColor = myColor;
  } else {
    gameScreen.style.backgroundColor = turnColor;
  }
}

// TIC TAC TOE LOGIC
function createBoard() {
  const board = document.getElementById('tic-tac-toe-board');
  if (!board) return;
  board.innerHTML = '';
  for (let i=0; i<9; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.index = i;
    cell.addEventListener('click', () => handleMove(i));
    board.appendChild(cell);
  }
}

async function handleMove(index) {
  if (gameState[index] !== '' || !myTurn) return;
  const mySymbol = (myPeerId === gameHost) ? 'X' : 'O';
  gameState[index] = mySymbol;
  updateBoard();
  
  const gameOver = checkWin();
  const otherPlayer = gamePlayers.find(p => p !== myPeerId) || myPeerId;
  const nextTurnPlayer = gameOver ? myPeerId : otherPlayer;

  myTurn = (myPeerId === nextTurnPlayer);

  if (!gameOver) {
    document.getElementById('game-status').innerText = `${window.getOpponentName()}'s turn`;
  } else {
    document.getElementById('btn-play-again').classList.remove('hidden');
  }
  updateGameBackground();

  if (window.firebaseGameBackend && currentRoomId) {
    await window.firebaseGameBackend.sendGameEvent(currentRoomId, { type: 'move', index, player: mySymbol, sender: myPeerId });
    await window.firebaseGameBackend.updateGameState(currentRoomId, {
      gameState: gameState,
      currentTurnPlayerId: nextTurnPlayer,
      lastUpdated: Date.now()
    });
  }
}

function resetGame(firstTurn = null) {
  const selectedFirstTurn = firstTurn || gameHost;
  window.currentTurnPlayerId = selectedFirstTurn;
  myTurn = (myPeerId === selectedFirstTurn);
  gameState = ['', '', '', '', '', '', '', '', ''];
  updateBoard();
  
  document.getElementById('tic-tac-toe-board').classList.remove('disabled');
  document.getElementById('btn-play-again').classList.add('hidden');
  document.getElementById('screen-game').classList.remove('tie-background');
  
  updateGameBackground();
  
  document.getElementById('game-status').innerText = myTurn ? 'Your turn!' : `${window.getOpponentName()}'s turn`;

  if (window.firebaseGameBackend && currentRoomId) {
    window.firebaseGameBackend.updateGameState(currentRoomId, {
      gameState: gameState,
      currentTurnPlayerId: selectedFirstTurn,
      lastUpdated: Date.now()
    });
  }
}

document.getElementById('btn-play-again').addEventListener('click', async () => {
  const nextFirstTurn = gamePlayers[Math.floor(Math.random() * gamePlayers.length)] || myPeerId;
  
  const room = activeRooms[currentRoomId];
  if (room && room.gameType === '5 Dice') {
    if (window.reset5DiceGame) window.reset5DiceGame(nextFirstTurn);
  } else {
    resetGame(nextFirstTurn);
  }

  if (window.firebaseGameBackend && currentRoomId) {
    const updates = {
      currentTurnPlayerId: nextFirstTurn,
      lastUpdated: Date.now()
    };
    if (room && room.gameType === '5 Dice') {
      updates.fiveDiceState = window.fiveDiceState;
    } else {
      updates.gameState = ['', '', '', '', '', '', '', '', ''];
    }
    await window.firebaseGameBackend.updateGameState(currentRoomId, updates);
    await window.firebaseGameBackend.sendGameEvent(currentRoomId, { type: 'PLAY_AGAIN', firstTurn: nextFirstTurn, sender: myPeerId });
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
      let opponent = roomPlayerDetails.find(p => p.peerId !== myPeerId);
      let opponentColor = opponent ? opponent.color : '#2a2a2a';
      let opponentName = opponent ? opponent.name : 'Opponent';
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
    
    let opponent = roomPlayerDetails.find(p => p.peerId !== myPeerId);
    let opponentColor = opponent ? opponent.color : '#2a2a2a';
    
    const gameScreen = document.getElementById('screen-game');
    gameScreen.style.setProperty('--color-1', myColor);
    gameScreen.style.setProperty('--color-2', opponentColor);
    gameScreen.style.backgroundColor = '';
    gameScreen.classList.add('tie-background');
    return true;
  }
  return false;
}

const handleLeaveGame = async () => {
  const gameScreen = document.getElementById('screen-game');
  if (gameScreen) {
    gameScreen.style.backgroundColor = '#2a2a2a';
    gameScreen.classList.remove('tie-background');
  }

  if (window.firebaseGameBackend) {
    window.firebaseGameBackend.stopGameListeners();
  }

  if (currentRoomId && activeRooms[currentRoomId]) {
    let room = activeRooms[currentRoomId];
    const isFiveDiceOver = (window.fiveDiceState && window.fiveDiceState.isGameOver);
    const isTTTOver = (gameState && checkWin());
    const isGameOver = isFiveDiceOver || isTTTOver;

    // Only remove player/delete room if the room is an unstarted lobby ('open') or the game has finished
    if (room.status === 'open' || isGameOver) {
      let players = (room.players || []).filter(p => p.peerId !== myPeerId && p.uuid !== myUuid);
      
      if (players.length === 0) {
        await window.firebaseGameBackend.deleteRoom(currentRoomId);
      } else {
        const newHost = players[0];
        await window.firebaseGameBackend.updateRoom(currentRoomId, {
          players: players,
          host: newHost.peerId,
          hostName: newHost.name,
          hostColor: newHost.color
        });
        await window.firebaseGameBackend.updateGameState(currentRoomId, {
          players: players,
          host: newHost.peerId
        });
      }
    }
  }

  currentRoomId = null;
  isHost = false;
  gamePlayers = [];
  roomPlayerDetails = [];
  gameState = ['', '', '', '', '', '', '', '', ''];
  
  updateBoard();
  document.getElementById('tic-tac-toe-board').classList.add('disabled');
  document.getElementById('btn-play-again').classList.add('hidden');
  
  showScreen('screen-lobby');
  updateDiagnostics();
  
  if (window.cleanup5DiceGame) {
    window.cleanup5DiceGame();
  }
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
let toastTimeoutId = null;

function showToast(msg, bgColor = null) {
  if (!toastEl) return;
  toastEl.innerText = msg;
  toastEl.style.backgroundColor = bgColor || '#333';
  toastEl.classList.remove('hidden');
  if (toastTimeoutId) clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(() => { toastEl.classList.add('hidden'); }, 3000);
}
window.showToast = showToast;

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

// APP INITIALIZATION
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
  startLobbyFirebase();
}
