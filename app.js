// --- GLOBALS ---
// Persist peerId across sessions (was sessionStorage). Turn, host, and score state
// are all keyed by peerId; when it changed on reconnect (new tab/session), nobody
// matched the active turn and the game froze. A stable per-device peerId fixes that.
let myPeerId = localStorage.getItem('myPeerId') || sessionStorage.getItem('myPeerId');
if (!myPeerId) {
  myPeerId = 'peer-' + Math.random().toString(36).substr(2, 9);
}
localStorage.setItem('myPeerId', myPeerId);
window.myPeerId = myPeerId;

// Escape user-controlled text before inserting into innerHTML (chat, room/host names).
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateDarkColor() {
  const colors = ["#235880", "#3F1F74", "#6F4F1F", "#2E2B53", "#264C1C", "#533A51", "#220066", "MidnightBlue", "#4d004d", "RebeccaPurple", "Sienna", "#181B59", "#006652", "#006666", "#404040"];
  return colors[Math.floor(Math.random() * colors.length)];
}

function saveSharedProfile(name, color) {
  if (name !== undefined && name !== null) {
    myName = name;
    localStorage.setItem('playerName', myName);
  }
  if (color !== undefined && color !== null) {
    myColor = color;
    localStorage.setItem('playerColor', myColor);
  }
  let userData = {};
  try { userData = JSON.parse(localStorage.getItem('UserData') || '{}'); } catch(e) {}
  userData.Name = myName;
  userData.Color = myColor;
  userData.PlayerID = myUuid;
  localStorage.setItem('UserData', JSON.stringify(userData));
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

let myUuid = localStorage.getItem('timeline_user_id');

let myName = localStorage.getItem('playerName') || '';
let myColor = localStorage.getItem('playerColor');

// Restore identity shared with the Score Sheet BEFORE minting anything new:
// a device that has UserData.PlayerID (the Score app's storage shape) but no
// timeline_user_id must adopt that ID, not generate a fresh one (which would
// silently fork the shared identity).
try {
  const uData = JSON.parse(localStorage.getItem('UserData') || '{}');
  if (uData.Name && !myName) myName = uData.Name;
  if (uData.Color && !myColor) myColor = uData.Color;
  if (uData.PlayerID && !myUuid) {
    myUuid = uData.PlayerID;
    localStorage.setItem('timeline_user_id', myUuid);
  }
} catch(e) {}

if (!myUuid) {
  myUuid = generateUUID();
  localStorage.setItem('timeline_user_id', myUuid);
}

if (!myColor) {
  myColor = generateDarkColor();
}
saveSharedProfile(myName, myColor);

// --- HINTS SETTING ---
// When off, the 5 Dice board hides potential-score previews and the highlight
// on available categories, leaving just scored vs. open cells. five-dice.js reads
// window.hintsEnabled when rendering. Default: OFF — only on if the user has
// explicitly turned it on before (their choice is remembered).
let hintsEnabled = (localStorage.getItem('hintsEnabled') === 'true');
window.hintsEnabled = hintsEnabled;

function setHintsEnabled(on) {
  hintsEnabled = !!on;
  window.hintsEnabled = hintsEnabled;
  localStorage.setItem('hintsEnabled', hintsEnabled ? 'true' : 'false');
  // Reflect the change immediately if a game is on screen.
  if (currentRoomId && typeof window.update5DiceUI === 'function') window.update5DiceUI();
}

// --- AUTO-ROLL SETTING ---
// When on, the start-of-turn roll happens by itself — no Roll button press. Applies
// to both 5 Dice (first of the three rolls) and Backgammon (after a short pause, so
// the doubling cube is still reachable). five-dice.js and bg-game.js read
// window.autoRollEnabled. Default: ON — only off if the user turned it off.
let autoRollEnabled = (localStorage.getItem('autoRollEnabled') !== 'false');
window.autoRollEnabled = autoRollEnabled;

function setAutoRollEnabled(on) {
  autoRollEnabled = !!on;
  window.autoRollEnabled = autoRollEnabled;
  localStorage.setItem('autoRollEnabled', autoRollEnabled ? 'true' : 'false');
  // Turning it on mid-turn should pick up the roll that's already waiting.
  if (autoRollEnabled && typeof window.maybeAutoRoll5Dice === 'function') window.maybeAutoRoll5Dice();
  // Backgammon has its own switch on the board which follows this one until it
  // is overridden, so tell it either way — it decides what to do.
  if (window.BGGame && typeof window.BGGame.maybeAutoRoll === 'function') window.BGGame.maybeAutoRoll();
}

function parseGameState(rawState) {
  const result = ['', '', '', '', '', '', '', '', ''];
  if (!rawState) return result;
  if (Array.isArray(rawState)) {
    for (let i = 0; i < 9; i++) {
      result[i] = rawState[i] || '';
    }
  } else if (typeof rawState === 'object') {
    for (let i = 0; i < 9; i++) {
      result[i] = rawState[i] || rawState[i.toString()] || '';
    }
  }
  return result;
}

window.addEventListener('storage', (e) => {
  if (e.key === 'playerName' || e.key === 'playerColor' || e.key === 'UserData') {
    const updatedName = localStorage.getItem('playerName');
    const updatedColor = localStorage.getItem('playerColor');
    if (updatedName) myName = updatedName;
    if (updatedColor) myColor = updatedColor;
  }
});

let currentRoomId = null; 
let activeRooms = {}; // { roomId: { id, name, host, ... } }
let isHost = false;
let recentChats = []; // { id, author, text, timestamp }

// --- GAME STATE GLOBALS ---
let gameState = ['', '', '', '', '', '', '', '', ''];
let myTurn = false;
let pendingMoveCount = 0; // Counter to prevent Firebase listener from overwriting local state during writes
let gamePlayers = [];
let gameHost = null;
let roomPlayerDetails = [];

Object.defineProperty(window, 'myTurn', { get: () => myTurn, set: (v) => { myTurn = v; } });
Object.defineProperty(window, 'gamePlayers', { get: () => gamePlayers, set: (v) => { gamePlayers = v; } });
Object.defineProperty(window, 'gameHost', { get: () => gameHost, set: (v) => { gameHost = v; } });
// five-dice.js reads window.roomPlayerDetails to resolve each player's name/color.
// Without this it was undefined, so names fell back to the generic "Player" label.
Object.defineProperty(window, 'roomPlayerDetails', { get: () => roomPlayerDetails, set: (v) => { roomPlayerDetails = v; } });
Object.defineProperty(window, 'myPeerId', { get: () => myPeerId });
Object.defineProperty(window, 'myName', { get: () => myName });
Object.defineProperty(window, 'myColor', { get: () => myColor });

// Voice chat (mic/speaker buttons + WebRTC mesh) lives in voice-chat.js; it is
// attached per-room via window.voiceEnterRoom / window.voiceLeaveRoom.

// The game type of the room we're currently in. The lobby cache (activeRooms)
// can be empty right after a deep link / room deletion, and several code paths
// used to treat "no cache entry" as "this is tic-tac-toe" — dropping 5 Dice
// persistence and misrouting PLAY_AGAIN. This is set whenever we enter a room
// and consulted as the fallback.
let currentGameType = null;
function getCurrentGameType() {
  const room = activeRooms[currentRoomId];
  return (room && room.gameType) || currentGameType || 'Tic-Tac-Toe';
}

// Single-player (vs computer) tic-tac-toe room?
const AI_PLAYER_ID = 'computer';
function isAIGame() {
  const room = activeRooms[currentRoomId];
  const maxP = (room && room.maxPlayers) || window.gameMaxPlayers;
  return getCurrentGameType() === 'Tic-Tac-Toe' && maxP === 1;
}
// Any 1-player room with a computer opponent (tic-tac-toe or backgammon) —
// solo 5 Dice is the only 1-player room WITHOUT one.
function isVsComputerGame() {
  const room = activeRooms[currentRoomId];
  const maxP = (room && room.maxPlayers) || window.gameMaxPlayers;
  return maxP === 1 && getCurrentGameType() !== '5 Dice';
}
window.isAIGame = isAIGame;
window.isVsComputerGame = isVsComputerGame;
window.AI_PLAYER_ID = AI_PLAYER_ID;

// Two tabs on one device share the same peerId (and uuid), so they are the
// same player — their writes clobber each other. A full single-tab lock would
// change identity semantics, so instead we detect the situation and warn.
try {
  const tabChannel = new BroadcastChannel('5dice-tabs');
  tabChannel.onmessage = (e) => {
    if (!e.data) return;
    if (e.data.type === 'hello' && e.data.peerId === myPeerId) {
      tabChannel.postMessage({ type: 'claimed', peerId: myPeerId });
    } else if (e.data.type === 'claimed' && e.data.peerId === myPeerId) {
      if (typeof window.showToast === 'function') {
        window.showToast('5 Dice is already open in another tab — playing in both may conflict.', '#dc3545');
      }
    }
  };
  tabChannel.postMessage({ type: 'hello', peerId: myPeerId });
} catch (e) { /* BroadcastChannel unsupported — skip the warning */ }

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
      registration.update();
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

  // Sweep rooms nobody has entered in 48 hours. Cleanup used to run only when
  // someone created a room, so a quiet lobby never got tidied.
  window.firebaseGameBackend.cleanupOldRooms({ force: true });

  updateDiagnostics();
}

// --- GLOBAL CHAT ---

function appendChatMessage(author, text, id = null, timestamp = null, color = null) {
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
  // Empty string, not a literal — lets the stylesheet (and the active skin) win
  // when the sender has no color, e.g. System notices.
  div.style.backgroundColor = color || '';
  div.innerHTML = `<strong>${escapeHtml(author)}:</strong> ${escapeHtml(text)}`;
  chatHistory.appendChild(div);
  chatHistory.scrollTop = chatHistory.scrollHeight;
  setTimeout(() => { if (div.parentNode) div.remove(); }, timeRemaining);
}

// Canonical display name for a player: their set name if they have one, otherwise
// "Player N" based on their position in the roster (stable across all clients since
// everyone shares the same players array order).
window.getDisplayName = function(peerId) {
  if (peerId === AI_PLAYER_ID) return 'Computer';
  const list = roomPlayerDetails || [];
  const idx = list.findIndex(p => p.peerId === peerId || p.uuid === peerId);
  if (peerId === myPeerId && myName) return myName;      // live self-name
  if (idx >= 0 && list[idx].name) return list[idx].name; // set name
  if (idx >= 0) return `Player ${idx + 1}`;              // unnamed → numbered
  return 'Player';
};

window.getOpponentName = function() {
  if (isAIGame()) return 'Computer';
  const otherPlayer = (roomPlayerDetails || []).find(p => p.peerId !== myPeerId);
  return otherPlayer ? window.getDisplayName(otherPlayer.peerId) : 'Opponent';
};

// Name of the player whose turn it actually is (correct for 3+ players, unlike
// getOpponentName which just returns the first other player).
window.getPlayerNameById = function(peerId) {
  return window.getDisplayName(peerId);
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

// --- APP MENU ---
// One ☰ per screen. The items are generated per screen so the menu never offers
// you the page you're already on.

// Where Settings/About were opened from, so we can send you back to it.
let menuReturnScreen = 'screen-lobby';

const MENU_ACTIONS = {
  lobby:      { icon: '🏠',  label: 'Lobby' },
  game:       { icon: '🎲',  label: 'Back to Game' },
  leaveGame:  { icon: '🚪',  label: 'Leave Room' },
  settings:   { icon: '⚙️', label: 'Settings' },
  about:      { icon: 'ℹ️', label: 'About' },
  scoreSheet: { icon: '📋',  label: '5Dice Score Sheet' }
};

function menuItemsFor(menuName) {
  // From Settings/About the "go back" item points wherever you came from.
  const backItem = (menuReturnScreen === 'screen-game') ? 'game' : 'lobby';
  switch (menuName) {
    case 'lobby':    return ['settings', 'about', 'scoreSheet'];
    case 'settings': return [backItem, 'about', 'scoreSheet'];
    case 'about':    return [backItem, 'settings', 'scoreSheet'];
    case 'game':     return ['leaveGame', 'settings', 'about', 'scoreSheet'];
    default:         return ['lobby'];
  }
}

// Remember the screen a Settings/About visit started from. Hopping between
// Settings and About preserves the original origin.
function rememberMenuOrigin() {
  const active = document.querySelector('.screen.active');
  if (!active) return;
  if (active.id === 'screen-game') menuReturnScreen = 'screen-game';
  else if (active.id === 'screen-lobby') menuReturnScreen = 'screen-lobby';
}

function closeAppMenu() {
  document.querySelectorAll('.app-menu').forEach(nav => nav.classList.add('hidden'));
  document.querySelectorAll('.menu-btn').forEach(btn => btn.setAttribute('aria-expanded', 'false'));
}

// Navigating away from Settings by any route shouldn't silently drop a name the
// user just typed.
function commitSettingsName() {
  const settingsScreen = document.getElementById('screen-settings');
  if (!settingsScreen || !settingsScreen.classList.contains('active')) return;
  const newName = document.getElementById('global-player-name').value.trim();
  if (newName && newName !== myName) saveSharedProfile(newName, myColor);
}

// Save the display name and leave the Settings screen. The only way out now
// that the Back to Lobby button is first-run-only.
function leaveSettings(target) {
  const nameField = document.getElementById('global-player-name');
  let newName = nameField.value.trim();

  if (!newName) {
    if (!myName) {
      // First run — a name is required before there's a lobby to go to.
      alert("Please enter a display name to continue.");
      return;
    }
    // Field was cleared but a name already exists. Keep the old one rather than
    // trapping the user here with no way out.
    newName = myName;
    nameField.value = myName;
  }

  saveSharedProfile(newName, myColor);

  // If Settings was opened mid-game, drop straight back into the game rather
  // than the lobby — the seat was never given up.
  if (target === 'screen-game' && currentRoomId) {
    showScreen('screen-game');
  } else {
    menuReturnScreen = 'screen-lobby';
    // Going to the lobby while still seated in a room must actually leave the
    // room (release the seat, stop its listeners) — otherwise we stay in the
    // old room's roster forever and its events keep feeding this client.
    if (currentRoomId) {
      handleLeaveGame(); // shows the lobby itself
    } else {
      showScreen('screen-lobby');
    }
    startLobbyFirebase();
  }
}

function runMenuAction(key) {
  closeAppMenu();
  const settingsScreen = document.getElementById('screen-settings');
  const onSettings = settingsScreen && settingsScreen.classList.contains('active');

  switch (key) {
    case 'lobby':
    case 'game':
      // Leaving Settings saves first so a changed name sticks.
      if (onSettings) {
        leaveSettings(key === 'game' ? 'screen-game' : 'screen-lobby');
      } else if (key === 'lobby') {
        menuReturnScreen = 'screen-lobby';
        // "Lobby" while seated in a room = leave the room properly (release the
        // seat, stop listeners) rather than just switching screens.
        if (currentRoomId) handleLeaveGame();
        else showScreen('screen-lobby');
      } else {
        showScreen('screen-game');
      }
      break;
    case 'leaveGame':
      menuReturnScreen = 'screen-lobby';
      handleLeaveGame();
      break;
    case 'settings':
      openSettings();
      break;
    case 'about':
      commitSettingsName();
      rememberMenuOrigin();
      showScreen('screen-about');
      break;
    case 'scoreSheet':
      commitSettingsName();
      window.location.href = 'Score/';
      break;
  }
}

function toggleAppMenu(btn, nav) {
  const wasOpen = !nav.classList.contains('hidden');
  closeAppMenu();
  if (wasOpen) return;

  nav.innerHTML = '';
  menuItemsFor(btn.dataset.menu).forEach(key => {
    const spec = MENU_ACTIONS[key];
    if (!spec) return;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'app-menu-item';
    item.setAttribute('role', 'menuitem');
    const ic = document.createElement('span');
    ic.className = 'app-menu-ic';
    ic.textContent = spec.icon;
    item.appendChild(ic);
    item.appendChild(document.createTextNode(spec.label));
    item.addEventListener('click', () => runMenuAction(key));
    nav.appendChild(item);
  });

  nav.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
}

document.querySelectorAll('.menu-btn').forEach(btn => {
  const nav = document.createElement('nav');
  nav.className = 'app-menu hidden';
  nav.setAttribute('role', 'menu');
  btn.parentElement.appendChild(nav);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAppMenu(btn, nav);
  });
  nav.addEventListener('click', (e) => e.stopPropagation());
});

document.addEventListener('click', () => closeAppMenu());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAppMenu();
});

// --- SETTINGS UI ---

const openSettings = () => {
  closeAppMenu();
  rememberMenuOrigin();
  const settingsMenuBtn = document.querySelector('.menu-btn[data-menu="settings"]');
  if (settingsMenuBtn) settingsMenuBtn.style.display = '';
  document.getElementById('global-player-name').value = myName;
  // The button is a first-run affordance only — the menu handles leaving once
  // there's a name saved.
  document.getElementById('btn-save-settings').classList.toggle('hidden', !!myName);
  document.getElementById('settings-player-id-section').style.display = 'block';

  const colorPicker = document.getElementById('player-color-picker');
  if (colorPicker) colorPicker.value = myColor;

  const hintsToggle = document.getElementById('hints-toggle');
  if (hintsToggle) hintsToggle.checked = hintsEnabled;

  const autoRollToggle = document.getElementById('auto-roll-toggle');
  if (autoRollToggle) autoRollToggle.checked = autoRollEnabled;

  syncSkinPicker();

  if (document.getElementById('settings-uuid')) {
    document.getElementById('settings-uuid').value = myUuid;
    document.getElementById('update-uuid-btn').style.display = 'none';
  }

  showScreen('screen-settings');
};

document.getElementById('btn-save-settings').addEventListener('click', () => {
  leaveSettings('screen-lobby');
});

const colorPickerEl = document.getElementById('player-color-picker');
if (colorPickerEl) {
  colorPickerEl.addEventListener('input', (e) => {
    saveSharedProfile(myName, e.target.value);
  });
}

// --- SKIN PICKER ---
// window.Skins comes from skins.js, which runs in <head> before this file.
function syncSkinPicker() {
  if (!window.Skins) return;
  const current = window.Skins.get();
  document.querySelectorAll('.skin-option').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.skinValue === current));
  });
}

document.querySelectorAll('.skin-option').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!window.Skins) return;
    window.Skins.set(btn.dataset.skinValue);
    syncSkinPicker();
  });
});

// Another tab or the Score Sheet changed it — keep the picker honest.
window.addEventListener('storage', (e) => {
  if (e.key === 'skin') syncSkinPicker();
});

syncSkinPicker();

const hintsToggleEl = document.getElementById('hints-toggle');
if (hintsToggleEl) {
  hintsToggleEl.checked = hintsEnabled;
  hintsToggleEl.addEventListener('change', (e) => setHintsEnabled(e.target.checked));
}

const autoRollToggleEl = document.getElementById('auto-roll-toggle');
if (autoRollToggleEl) {
  autoRollToggleEl.checked = autoRollEnabled;
  autoRollToggleEl.addEventListener('change', (e) => setAutoRollEnabled(e.target.checked));
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
  const refreshSetupOptions = () => {
    const gameType = gameTypeSelect.value;
    const playerCount = document.getElementById('player-count').value;
    const bgOpts = document.getElementById('bg-options');
    const diffWrap = document.getElementById('bg-difficulty-wrap');
    if (bgOpts) bgOpts.classList.toggle('hidden', gameType !== 'Backgammon');
    // Difficulty only matters against the computer.
    if (diffWrap) diffWrap.classList.toggle('hidden', gameType !== 'Backgammon' || playerCount !== '1');
  };

  gameTypeSelect.addEventListener('change', (e) => {
    const playerCountSelect = document.getElementById('player-count');
    playerCountSelect.innerHTML = '';

    if (e.target.value === 'Tic-Tac-Toe') {
      playerCountSelect.innerHTML =
        '<option value="1">1 Player (vs Computer)</option>' +
        '<option value="2" selected>2 Players</option>';
    } else if (e.target.value === 'Backgammon') {
      playerCountSelect.innerHTML =
        '<option value="1">1 Player (vs Computer)</option>' +
        '<option value="2" selected>2 Players</option>';
    } else if (e.target.value === '5 Dice') {
      const solo = document.createElement('option');
      solo.value = 1;
      solo.innerText = '1 Player (Solo)';
      playerCountSelect.appendChild(solo);
      for (let i = 2; i <= 6; i++) {
        const option = document.createElement('option');
        option.value = i;
        option.innerText = i + ' Players';
        playerCountSelect.appendChild(option);
      }
      playerCountSelect.value = '2';
    }
    refreshSetupOptions();
  });

  const playerCountEl = document.getElementById('player-count');
  if (playerCountEl) playerCountEl.addEventListener('change', refreshSetupOptions);
}

document.getElementById('room-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    document.getElementById('btn-create-room').click();
  }
});

document.getElementById('btn-create-room').addEventListener('click', async () => {
  const roomName = document.getElementById('room-name-input').value || 'New Game';
  const gameType = document.getElementById('game-type-select') ? document.getElementById('game-type-select').value : 'Tic-Tac-Toe';
  let maxPlayers = document.getElementById('player-count') ? parseInt(document.getElementById('player-count').value, 10) : 2;
  // Tic-Tac-Toe and Backgammon are 1 player (vs computer) or exactly 2.
  if ((gameType === 'Tic-Tac-Toe' || gameType === 'Backgammon') && maxPlayers !== 1) maxPlayers = 2;

  // Backgammon room options
  const bgTargetSel = document.getElementById('bg-target-select');
  const bgDiffSel = document.getElementById('bg-difficulty-select');
  const bgCubeSel = document.getElementById('bg-cube-toggle');
  const bgTarget = gameType === 'Backgammon' && bgTargetSel ? parseInt(bgTargetSel.value, 10) || 1 : 1;
  const bgLevel = gameType === 'Backgammon' && maxPlayers === 1 && bgDiffSel ? bgDiffSel.value : null;
  // Off by default: without the cube there is no decision to make before the
  // dice, so backgammon turns can auto-roll instead of waiting for a tap.
  const bgCube = gameType === 'Backgammon' && bgCubeSel ? !!bgCubeSel.checked : false;

  showLoading('Creating Room...');

  const roomId = Math.random().toString(36).substr(2, 9);
  const playerObj = { peerId: myPeerId, uuid: myUuid, name: myName, color: myColor };
  // Single-player rooms start immediately — there is nobody to wait for.
  const solo = maxPlayers === 1;
  const initialStatus = solo ? 'in-progress' : 'open';

  const room = {
    id: roomId,
    name: roomName,
    gameType: gameType,
    host: myPeerId,
    hostUuid: myUuid,
    hostName: myName,
    hostColor: myColor,
    status: initialStatus,
    players: [playerObj],
    maxPlayers: maxPlayers,
    lastActive: Date.now()
  };
  if (gameType === 'Backgammon') {
    room.bgTarget = bgTarget;
    room.bgCube = bgCube;
    if (bgLevel) room.bgLevel = bgLevel;
  }

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
    status: initialStatus,
    players: [playerObj],
    currentTurnPlayerId: myPeerId,
    gameState: ['', '', '', '', '', '', '', '', ''],
    fiveDiceState: {
      dice: [1, 1, 1, 1, 1],
      held: [false, false, false, false, false],
      rollsLeft: 3,
      scores: initialScores,
      turnsLeft: 13,
      isGameOver: false,
      // Persisted so every client (including one that reloads mid-game) derives
      // the same turn order instead of falling back to a local-only anchor.
      firstTurn: myPeerId
    }
  };
  if (gameType === 'Backgammon') {
    initialGameData.bgTarget = bgTarget;
    initialGameData.bgCube = bgCube;
    if (bgLevel) initialGameData.bgLevel = bgLevel;
  }

  try {
    await window.firebaseGameBackend.createRoom(room);
    await window.firebaseGameBackend.initGameSession(roomId, initialGameData);
  } catch (err) {
    console.error('Failed to create room:', err);
    hideLoading();
    showToast('Could not create the room — check your connection and try again.', '#dc3545');
    return;
  }

  // Commit local state only after the writes succeeded, so a failure can't
  // leave us "in" a room that was never created.
  currentRoomId = roomId;
  isHost = true;
  currentGameType = gameType;
  window.gameMaxPlayers = maxPlayers;
  window.fiveDiceState = null;      // never inherit a previous room's board
  window.currentFirstTurn = myPeerId;
  window._lastGameRoomId = roomId;
  // Cached for setupGameUI, which may run before the lobby snapshot arrives.
  window._bgLevel = bgLevel;
  window._bgTarget = bgTarget;
  window._bgCube = bgCube;

  document.getElementById('game-room-name').innerText = `🎲 ${roomName} - ${gameType} 🎲`;

  setupGameUI(gameType);
  showScreen('screen-game');
  document.getElementById('game-status').innerText = solo ? 'Your turn!' : 'Waiting for players to join...';

  startListeningToGameSession(roomId);
  if (window.voiceEnterRoom) window.voiceEnterRoom(roomId);
  hideLoading();
});

// A room counts as idle (abandoned) if there's been no activity for a while.
// Game rooms have no live presence, so this lets a host clear a zombie room even
// when a player who has left is still listed in the roster.
const ROOM_IDLE_MS = 15 * 60 * 1000;
function isRoomIdle(room) {
  if (!room || !room.lastActive) return true;
  return (Date.now() - room.lastActive) > ROOM_IDLE_MS;
}

// Bump the room's lastActive during play (throttled to once/min) so an actively
// played game never looks idle. Abandoned games stop bumping and go idle.
let lastRoomTouchTs = 0;
function touchRoomActivity() {
  if (!currentRoomId || !window.firebaseGameBackend || !window.firebaseGameBackend.updateRoom) return;
  const now = Date.now();
  if (now - lastRoomTouchTs < 60000) return;
  lastRoomTouchTs = now;
  window.firebaseGameBackend.updateRoom(currentRoomId, {}); // updateRoom sets lastActive
}

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
    const isHost = (r.hostUuid === myUuid || r.host === myPeerId);
    const otherPlayers = playerList.filter(p => p.uuid !== myUuid && p.peerId !== myPeerId);
    // Host can delete when no other players remain, OR the room has gone idle
    // (abandoned) even if a stale player is still listed.
    const canDelete = isHost && (otherPlayers.length === 0 || isRoomIdle(r));
    
    const div = document.createElement('div');
    div.className = 'room-card';
    if (isReturning) {
      div.classList.add('room-card-returning');
    }
    
    const hostColor = r.hostColor || '#28a745';
    div.style.backgroundColor = hostColor;

    const displayGameType = r.gameType || 'Tic-Tac-Toe';
    let seatText = '';
    let isFull = false;
    if (isReturning) {
      seatText = `<p class="room-seats seats-playing">🎮 Game In Progress (You are playing)</p>`;
    } else if (r.maxPlayers && r.status === 'open') {
      const currentCount = playerList.length;
      const emptySeats = Math.max(0, r.maxPlayers - currentCount);
      isFull = emptySeats === 0;
      seatText = `<p class="room-seats ${isFull ? 'seats-full' : 'seats-open'}">` +
                 (isFull ? 'Game Full' : `${emptySeats} Seat${emptySeats === 1 ? '' : 's'} Remaining`) + 
                 `</p>`;
    }

    // No inline onclick with interpolated ids — r.id is attacker-controllable
    // data from the database (stored XSS). Actions are wired via data
    // attributes + the delegated listener below.
    const deleteBtnHtml = canDelete ? `<button class="delete-room-btn" title="Delete Game Room" data-action="delete">✕</button>` : '';

    div.dataset.roomId = r.id;
    div.innerHTML = `
      ${deleteBtnHtml}
      <h3>${escapeHtml(r.name)} - ${escapeHtml(displayGameType)}</h3>
      <p>Host: ${escapeHtml(r.hostName || 'Host')}</p>
      ${seatText}
      <button class="capsule-button small${isReturning ? ' btn-rejoin' : ''}" data-action="join" ${isFull && !isReturning ? 'disabled' : ''}>${isReturning ? 'Rejoin Game' : 'Join Game'}</button>
    `;
    list.appendChild(div);
  });

  document.getElementById('game-count').innerText = `Games Found: ${validRoomCount}`;
}

// One delegated handler for every room card (join / delete).
document.getElementById('room-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const card = btn.closest('.room-card');
  if (!card || !card.dataset.roomId) return;
  if (btn.disabled) return;
  if (btn.dataset.action === 'join') {
    joinRoom(card.dataset.roomId);
  } else if (btn.dataset.action === 'delete') {
    promptDeleteRoom(e, card.dataset.roomId);
  }
});

window.joinRoom = async function(roomId) {
  const room = activeRooms[roomId];
  if (!room) return alert('Room no longer exists.');

  const displayGameType = room.gameType || 'Tic-Tac-Toe';

  showLoading('Joining Room...');

  const me = { peerId: myPeerId, uuid: myUuid, name: myName, color: myColor };
  const maxPlayers = room.maxPlayers || 2;
  const wasAlreadyPlaying = (room.players || []).some(p => p && (p.uuid === myUuid || p.peerId === myPeerId));

  let players;
  let updatedStatus;

  try {
    // Atomic transaction join (avoids two joiners clobbering each other; the
    // transaction re-checks maxPlayers/status from the live room, not our cache).
    const res = window.firebaseGameBackend.addPlayerToRoom
      ? await window.firebaseGameBackend.addPlayerToRoom(roomId, me, maxPlayers)
      : { ok: false, reason: 'error' };

    if (res.ok) {
      players = res.players;
      updatedStatus = res.status;
    } else if (res.reason === 'full') {
      hideLoading();
      return alert('This game room is full or already in progress.');
    } else if (res.reason === 'gone') {
      hideLoading();
      return alert('Room no longer exists.');
    } else if (res.reason === 'auth') {
      hideLoading();
      return alert('Could not connect to the game service. Please try again.');
    } else {
      // Fallback (transient/transaction error): the previous read-modify-write path.
      players = room.players || [];
      const existingPlayerIndex = players.findIndex(p => p.uuid === myUuid || p.peerId === myPeerId);
      if (existingPlayerIndex < 0) players.push(me);
      else players[existingPlayerIndex] = me;
      const isFullNow = players.length >= maxPlayers;
      updatedStatus = isFullNow ? 'in-progress' : room.status;
      await window.firebaseGameBackend.updateRoom(roomId, {
        players: players,
        status: updatedStatus
      });
    }

    // Merge (not overwrite) the roster into the game node so two concurrent
    // joiners can't erase each other, then sync the room status.
    if (window.firebaseGameBackend.syncGamePlayers) {
      await window.firebaseGameBackend.syncGamePlayers(roomId, players);
      await window.firebaseGameBackend.updateGameState(roomId, { status: updatedStatus });
    } else {
      await window.firebaseGameBackend.updateGameState(roomId, { players: players, status: updatedStatus });
    }
  } catch (err) {
    console.error('Failed to join room:', err);
    hideLoading();
    showToast('Could not join the room — check your connection and try again.', '#dc3545');
    return;
  }

  // Commit local state only once the join actually succeeded.
  currentRoomId = roomId;
  isHost = (room.host === myPeerId);
  currentGameType = displayGameType;
  window.gameMaxPlayers = maxPlayers;
  window._bgLevel = room.bgLevel || null;
  window._bgTarget = room.bgTarget || 1;
  // Rooms created before this option existed have no bgCube field; those played
  // with the cube, so undefined must stay "on".
  window._bgCube = room.bgCube;
  document.getElementById('game-room-name').innerText = `🎲 ${room.name} - ${displayGameType} 🎲`;

  // "Rejoin" (keep the local board) only applies when returning to a game we
  // were already part of. A stale fiveDiceState from a previous room must never
  // survive into a new one — it blocks state adoption and can corrupt the new
  // game for everyone.
  const isRejoin = updatedStatus === 'in-progress' && wasAlreadyPlaying && window._lastGameRoomId === roomId;
  if (!isRejoin) {
    window.fiveDiceState = null;
    window.currentFirstTurn = null;
  }
  // Win/tie tallies are PER ROOM. Carrying them into a different room meant the
  // new room briefly rendered the old room's record — until Firebase delivered
  // the real numbers, which never happens at all for a room with no wins yet.
  if (window._lastGameRoomId !== roomId) {
    window.roomWins = {};
    window.roomTies = {};
  }
  window._lastGameRoomId = roomId;

  setupGameUI(displayGameType, isRejoin);
  showScreen('screen-game');

  startListeningToGameSession(roomId);
  if (window.voiceEnterRoom) window.voiceEnterRoom(roomId);
  hideLoading();
};

function setupGameUI(gameType, isRejoin = false) {
  const tttBoard = document.getElementById('tic-tac-toe-board');
  const fdContainer = document.getElementById('five-dice-container');
  const bgContainer = document.getElementById('backgammon-container');
  // No one to talk to in a single-player room — hide the voice controls.
  const audioCtl = document.querySelector('.audio-controls');
  if (audioCtl) audioCtl.style.display = (window.gameMaxPlayers === 1) ? 'none' : '';

  // The Room record is a GAME-OVER panel, and #fd-wins is shared by every game
  // type. It used to be hidden only on the tic-tac-toe path, so a tally left
  // visible by a finished game followed you into the next one — showing
  // backgammon's record on the 5 Dice board, and showing a record mid-game in
  // backgammon. Each game's own game-over handler re-shows it.
  const winsEl = document.getElementById('fd-wins');
  if (winsEl) winsEl.classList.add('hidden');

  // Tear down any previous backgammon scene unless we're re-entering one.
  if (gameType !== 'Backgammon' && window.BGGame && window.BGGame.active) {
    window.BGGame.cleanup();
  }
  if (bgContainer && gameType !== 'Backgammon') bgContainer.classList.add('hidden');

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
  } else if (gameType === 'Backgammon') {
    tttBoard.classList.add('hidden');
    fdContainer.classList.add('hidden');
    document.body.classList.remove('bg-five-dice');
    const room = activeRooms[currentRoomId] || {};
    if (window.BGGame && bgContainer) {
      // Seat assignment. hostUuid is stable across sessions/devices; peerId can go
      // stale, and the old `(room.host || gameHost || myPeerId) === myPeerId`
      // fallback made EVERYONE host when room data hadn't synced yet — which is
      // why the board sometimes rendered 180° backwards at game start. Fall back
      // to the `isHost` flag committed at create/join time, never to myPeerId.
      const amBgHost =
        room.hostUuid != null ? room.hostUuid === myUuid :
        room.host     != null ? room.host === myPeerId :
        gameHost      != null ? gameHost === myPeerId :
        isHost;
      window.BGGame.enter({
        container: bgContainer,
        isHost: amBgHost,
        aiLevel: (room.maxPlayers === 1 || window.gameMaxPlayers === 1) ? (room.bgLevel || window._bgLevel || 'normal') : null,
        matchTarget: room.bgTarget || window._bgTarget || 1,
        cubeEnabled: room.bgCube !== undefined ? room.bgCube
                   : window._bgCube !== undefined ? window._bgCube
                   : true
      });
    }
  } else {
    tttBoard.classList.remove('hidden', 'disabled');
    fdContainer.classList.add('hidden');
    document.body.classList.remove('bg-five-dice');
    createBoard();
    updateBoard();
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

  const room = activeRooms[currentRoomId] || gameData;
  if (room && room.gameType) currentGameType = room.gameType;
  const is5Dice = (getCurrentGameType() === '5 Dice');

  // The game only becomes active once the room is full (status flips to
  // 'in-progress'). Until then nobody may take a turn. This matters for 3-6 player
  // rooms where players join over time; with 2 players the room fills instantly so
  // this window was previously invisible.
  window.gameStarted = (gameData.status === 'in-progress');
  window.gameMaxPlayers = (room && room.maxPlayers) || gamePlayers.length;
  window.roomWins = gameData.wins || {}; // persistent per-room win counts
  window.roomTies = gameData.ties || {}; // persistent per-room tie counts

  const turnPlayerId = gameData.currentTurnPlayerId || gameHost;
  window.currentTurnPlayerId = turnPlayerId;

  if (!window.gameStarted) {
    myTurn = false;
  } else if (gamePlayers.length <= 1) {
    myTurn = true;
  } else {
    myTurn = (myPeerId === turnPlayerId);
  }

  // Host-only "Start now": begin before the room is full (needs at least 2 players).
  const btnStartNow = document.getElementById('btn-start-now');
  if (btnStartNow) {
    const amHost = (gameHost === myPeerId);
    const canStartEarly = amHost && !window.gameStarted && gamePlayers.length >= 2;
    btnStartNow.classList.toggle('hidden', !canStartEarly);
  }

  const isBackgammon = (getCurrentGameType() === 'Backgammon');
  if (isBackgammon) {
    // Backgammon owns its own status text and turn logic.
    if (gameData.bgTarget) window._bgTarget = gameData.bgTarget;
    if (gameData.bgLevel) window._bgLevel = gameData.bgLevel;
    if (gameData.bgCube !== undefined) window._bgCube = gameData.bgCube;
    if (gameData.backgammonState && window.BGGame && window.BGGame.active) {
      window.BGGame.syncState(gameData.backgammonState);
    }
    if (window.BGGame && window.BGGame.active) window.BGGame.poke();
    // Backgammon was the only branch that never repainted the tally, so the
    // server's win count never reached the panel that was already on screen.
    // Only repaint while it's actually showing (game over) — never un-hide it.
    const bgWinsEl = document.getElementById('fd-wins');
    if (bgWinsEl && !bgWinsEl.classList.contains('hidden') && window.renderWinsTally) {
      window.renderWinsTally();
    }
  } else if (is5Dice) {
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
    // 5 Dice status text (waiting-for-players / whose-turn / game-over) is owned
    // entirely by sync5DiceState so there's a single source of truth.
    if (window.fiveDiceState && window.fiveDiceState.isGameOver && window.renderWinsTally) {
      window.renderWinsTally(); // keep the room win tally current at game over
    }
  } else {
    // Skip overwriting local state if we have pending moves being written to Firebase
    if (pendingMoveCount === 0) {
      gameState = parseGameState(gameData.gameState);
      updateBoard();
      const isOver = checkWin();
      if (!isOver) {
        document.getElementById('game-status').innerText = window._aiPending
          ? "Computer's turn..."
          : (myTurn ? 'Your turn!' : `${window.getPlayerNameById(turnPlayerId)}'s turn`);
        document.getElementById('tic-tac-toe-board').classList.remove('disabled');
        // Safeguard: clear a stale tie/win background if a reset (empty-board) state
        // arrives without the accompanying PLAY_AGAIN event.
        const gs = document.getElementById('screen-game');
        if (gs) gs.classList.remove('tie-background');
      } else {
        document.getElementById('btn-play-again').classList.remove('hidden');
      }
    }
    // Refresh the running tally from the freshest counts on EVERY update — even
    // while our own move write is pending — so the two separate tie increments
    // can't leave the finishing client stuck showing a stale total. roomWins/
    // roomTies were already updated from gameData above the game-type branch.
    if (checkWinSilent() && typeof window.renderWinsTally === 'function') {
      window.renderWinsTally();
    }
  }

  updateGameBackground();
  updateDiagnostics();
}

function handleGameEvent(evt) {
  if (evt.sender === myPeerId) return; // Skip echo of our own events

  if (evt.type === 'PLAY_AGAIN') {
    // Route by the tracked game type, not the lobby cache — a missing cache
    // entry used to send a 5 Dice PLAY_AGAIN into the tic-tac-toe reset.
    if (getCurrentGameType() === '5 Dice') {
      if (window.reset5DiceGame) window.reset5DiceGame(evt.firstTurn);
    } else {
      resetGame(evt.firstTurn);
    }
  } else if (evt.type && evt.type.startsWith('5DICE_')) {
    if (typeof window.handle5DiceMessage === 'function') {
      window.handle5DiceMessage(evt);
    }
  } else if (evt.type && evt.type.startsWith('BG_')) {
    if (window.BGGame && window.BGGame.active) {
      window.BGGame.handleEvent(evt);
    }
  }
}

// Writes are chained so they land in the order the moves happened. Without
// this, two rapid actions raced: each awaited its event push and only THEN read
// the game state, so a slow first write could persist a mid-turn board on top
// of a newer one.
let gameActionChain = Promise.resolve();

async function retryWrite(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 300 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

window.sendGameAction = function(msgObj) {
  if (!currentRoomId || !window.firebaseGameBackend) return Promise.resolve();

  const roomId = currentRoomId;
  const eventPayload = { ...msgObj, sender: myPeerId };

  // Snapshot the state NOW, not after the event await — see the note above.
  const updates = { lastUpdated: Date.now() };

  // Keyed off the tracked game type (not the lobby cache) so 5 Dice state is
  // persisted even when the lobby snapshot hasn't arrived — otherwise rolls
  // and scores broadcast as transient events but are lost on any reload.
  if (getCurrentGameType() === '5 Dice') {
    updates.fiveDiceState = window.fiveDiceState;
    if (window.currentTurnPlayerId) {
      updates.currentTurnPlayerId = window.currentTurnPlayerId;
    }
  } else if (getCurrentGameType() === 'Backgammon' && window.BGGame && window.BGGame.active) {
    const json = window.BGGame.getStateJson();
    if (json) updates.backgammonState = json;
  }

  gameActionChain = gameActionChain.then(async () => {
    // The event is only the fast path — it carries the animation. Losing it is
    // survivable, so a failure here must NOT skip the state write below: that
    // write is the reconciliation channel the other client heals from. It used
    // to be one try/catch around both, which meant a single dropped event left
    // the two boards permanently disagreeing about whose turn it was.
    let eventOk = true;
    try {
      // Retrying can duplicate an event; the receiver's seq guard drops dupes.
      await retryWrite(() => window.firebaseGameBackend.sendGameEvent(roomId, eventPayload));
    } catch (err) {
      eventOk = false;
      console.error('sendGameEvent failed (falling back to state sync):', err);
    }

    try {
      await retryWrite(() => window.firebaseGameBackend.updateGameState(roomId, updates));
      touchRoomActivity();
    } catch (err) {
      console.error('updateGameState failed:', err);
      showToast('Move failed to sync — check your connection.', '#dc3545');
      return;
    }

    if (!eventOk) {
      // State landed, so the opponent still catches up from the games node —
      // they just miss the animation for this one action.
      console.warn('Game event dropped; opponent reconciles from persisted state.');
    }
  }).catch(err => {
    console.error('sendGameAction failed:', err);
  });

  return gameActionChain;
};

// Record a win/tie for a player in the current room (atomic; persists across games).
// incrementWin/Tie are async Firebase transactions, but callers render the
// tally in the SAME tick — so the winner saw the pre-win number (usually 0) and
// it only corrected if some later state update happened to repaint. Bump the
// local copy optimistically and repaint now; the state listener overwrites
// window.roomWins with the authoritative server value moments later.
function bumpLocalTally(bucket, playerId) {
  window[bucket] = window[bucket] || {};
  window[bucket][playerId] = (window[bucket][playerId] || 0) + 1;
  if (typeof window.renderWinsTally === 'function') window.renderWinsTally();
}
window.recordRoomWin = function(playerId) {
  if (!currentRoomId || !playerId || !window.firebaseGameBackend || !window.firebaseGameBackend.incrementWin) return;
  bumpLocalTally('roomWins', playerId);
  window.firebaseGameBackend.incrementWin(currentRoomId, playerId);
};
window.recordRoomTie = function(playerId) {
  if (!currentRoomId || !playerId || !window.firebaseGameBackend || !window.firebaseGameBackend.incrementTie) return;
  bumpLocalTally('roomTies', playerId);
  window.firebaseGameBackend.incrementTie(currentRoomId, playerId);
};

function updateGameBackground() {
  const gameScreen = document.getElementById('screen-game');
  if (!gameScreen) return;

  // 5 Dice game over: the winner's color (or tie stripes) owns the background —
  // don't overwrite it with the current-turn color on later state syncs. Key off
  // the visible 5 Dice view so a stale isGameOver from a prior game can't affect
  // a tic-tac-toe board.
  const fdcNow = document.getElementById('five-dice-container');
  const in5DiceView = fdcNow && !fdcNow.classList.contains('hidden');
  if (in5DiceView && window.fiveDiceState && window.fiveDiceState.isGameOver) {
    if (typeof window.apply5DiceWinnerBackground === 'function') window.apply5DiceWinnerBackground();
    return;
  }

  // Don't overwrite winner/tie backgrounds
  if (gameScreen.classList.contains('tie-background')) return;
  const boardEl = document.getElementById('tic-tac-toe-board');
  if (boardEl && boardEl.classList.contains('disabled') && checkWinSilent()) return;

  gameScreen.classList.remove('bg-watermark-x', 'bg-watermark-o');

  // The X/O watermark belongs to tic-tac-toe only.
  if (gameHost !== null && getCurrentGameType() === 'Tic-Tac-Toe') {
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

// Silent win check (no side effects) — used by updateGameBackground to detect game-over state
function checkWinSilent() {
  const state = parseGameState(gameState);
  const winPatterns = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];
  for (let pattern of winPatterns) {
    const [a,b,c] = pattern;
    if (state[a] && state[a] === state[b] && state[a] === state[c]) return true;
  }
  return !state.includes('');
}

// Returns the winning symbol ('X'/'O') if there's a completed line, else null
// (a full board with no line is a draw).
function getTTTWinnerSymbol() {
  const state = parseGameState(gameState);
  const winPatterns = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];
  for (let pattern of winPatterns) {
    const [a,b,c] = pattern;
    if (state[a] && state[a] === state[b] && state[a] === state[c]) return state[a];
  }
  return null;
}

// TIC TAC TOE LOGIC
function createBoard() {
  const board = document.getElementById('tic-tac-toe-board');
  if (!board) return;
  board.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('div');
    const val = gameState[i] || '';
    cell.className = 'cell' + (val === 'X' ? ' cell-x' : (val === 'O' ? ' cell-o' : ''));
    cell.dataset.index = i;
    cell.innerText = val;
    
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      handleMove(i);
    });

    board.appendChild(cell);
  }

  if (!board.dataset.hasDelegation) {
    board.dataset.hasDelegation = 'true';
    board.addEventListener('click', (e) => {
      const cell = e.target.closest('.cell');
      if (cell && cell.dataset.index !== undefined) {
        const idx = parseInt(cell.dataset.index, 10);
        if (!isNaN(idx)) handleMove(idx);
      }
    });
  }
}

async function handleMove(index) {
  // The game must have started (room full, or the host used "Start now") before
  // anyone — including the host — can place a mark.
  if (window.gameStarted === false) return;
  // Enforce turn order in multiplayer
  if (gamePlayers.length > 1 && !myTurn) return;
  // In a vs-computer game, wait for the computer to finish its move.
  if (window._aiPending) return;

  gameState = parseGameState(gameState);
  if (gameState[index] !== '') return;

  const aiGame = isAIGame();
  const playedCount = gameState.filter(c => c !== '').length;
  let mySymbol = 'X';
  if (aiGame) {
    // Vs computer: the human is always X; the computer replies as O.
    mySymbol = 'X';
  } else if (gamePlayers.length <= 1) {
    // Solo (waiting for an opponent): alternate X and O each move
    mySymbol = (playedCount % 2 === 0) ? 'X' : 'O';
  } else {
    // Multiplayer: host is always X, non-host is always O
    mySymbol = (myPeerId === gameHost) ? 'X' : 'O';
  }

  gameState[index] = mySymbol;
  updateBoard();

  const gameOver = checkWin();
  const otherPlayer = gamePlayers.find(p => p !== myPeerId) || myPeerId;
  const nextTurnPlayer = gameOver ? myPeerId : (gamePlayers.length <= 1 ? myPeerId : otherPlayer);

  // Keep local turn state consistent immediately (so the turn-color background is
  // correct before the Firebase echo). Don't re-enable my turn once the game is over
  // — checkWin() already set myTurn=false on a final move.
  window.currentTurnPlayerId = nextTurnPlayer;
  myTurn = !gameOver && (myPeerId === nextTurnPlayer || gamePlayers.length <= 1);

  if (!gameOver) {
    if (aiGame) {
      document.getElementById('game-status').innerText = "Computer's turn...";
      scheduleAiMove();
    } else {
      document.getElementById('game-status').innerText = (gamePlayers.length <= 1 || myTurn) ? 'Your turn!' : `${window.getOpponentName()}'s turn`;
    }
    updateGameBackground();
  } else {
    document.getElementById('btn-play-again').classList.remove('hidden');
    // This client made the final move, so it records the result exactly once
    // into the room's running tally (a win for me, or a tie for everyone).
    const winSym = getTTTWinnerSymbol();
    if (winSym) {
      if (typeof window.recordRoomWin === 'function') window.recordRoomWin(myPeerId);
    } else if (aiGame) {
      if (typeof window.recordRoomTie === 'function') {
        window.recordRoomTie(myPeerId);
        window.recordRoomTie(AI_PLAYER_ID);
      }
    } else {
      (gamePlayers || []).forEach(p => { if (typeof window.recordRoomTie === 'function') window.recordRoomTie(p); });
    }
    if (typeof window.renderWinsTally === 'function') window.renderWinsTally();
  }

  if (window.firebaseGameBackend && currentRoomId) {
    // Increment counter to prevent the Firebase listener from overwriting
    // our local state with stale data before the write completes.
    // Using a counter (not boolean) so overlapping rapid clicks don't
    // let the first finally-block prematurely unblock the listener.
    pendingMoveCount++;
    try {
      await window.firebaseGameBackend.sendGameEvent(currentRoomId, { type: 'move', index, player: mySymbol, sender: myPeerId });
      await window.firebaseGameBackend.updateGameState(currentRoomId, {
        gameState: gameState,
        currentTurnPlayerId: nextTurnPlayer,
        lastUpdated: Date.now()
      });
      touchRoomActivity();
    } catch (err) {
      console.error('Failed to sync move:', err);
    } finally {
      pendingMoveCount--;
    }
  }
}

// --- TIC-TAC-TOE COMPUTER OPPONENT ---
// Rule-based: 1) take a winning move, 2) block the human's winning move,
// 3) otherwise prefer center, then corners, then edges.
const TTT_WIN_PATTERNS = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6]
];

function findWinningMove(state, symbol) {
  for (const [a,b,c] of TTT_WIN_PATTERNS) {
    const line = [state[a], state[b], state[c]];
    if (line.filter(v => v === symbol).length === 2 && line.includes('')) {
      return [a,b,c][line.indexOf('')];
    }
  }
  return -1;
}

function computeAiMove(state) {
  const win = findWinningMove(state, 'O');
  if (win >= 0) return win;
  const block = findWinningMove(state, 'X');
  if (block >= 0) return block;
  if (state[4] === '') return 4;
  const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const corners = [0,2,6,8].filter(i => state[i] === '');
  if (corners.length) return pickRandom(corners);
  const edges = [1,3,5,7].filter(i => state[i] === '');
  if (edges.length) return pickRandom(edges);
  return -1;
}

let aiMoveTimer = null;
function cancelAiMove() {
  if (aiMoveTimer) { clearTimeout(aiMoveTimer); aiMoveTimer = null; }
  window._aiPending = false;
}

function scheduleAiMove() {
  window._aiPending = true;
  if (aiMoveTimer) clearTimeout(aiMoveTimer);
  aiMoveTimer = setTimeout(() => {
    aiMoveTimer = null;
    window._aiPending = false;
    if (!currentRoomId || !isAIGame()) return;

    gameState = parseGameState(gameState);
    if (checkWinSilent()) return; // game already ended (e.g. reset raced us)
    const idx = computeAiMove(gameState);
    if (idx < 0) return;

    gameState[idx] = 'O';
    updateBoard();

    const gameOver = checkWin();
    if (!gameOver) {
      document.getElementById('game-status').innerText = 'Your turn!';
      myTurn = true;
      updateGameBackground();
    } else {
      document.getElementById('btn-play-again').classList.remove('hidden');
      const winSym = getTTTWinnerSymbol();
      if (winSym === 'O') {
        if (typeof window.recordRoomWin === 'function') window.recordRoomWin(AI_PLAYER_ID);
      } else if (!winSym) {
        if (typeof window.recordRoomTie === 'function') {
          window.recordRoomTie(myPeerId);
          window.recordRoomTie(AI_PLAYER_ID);
        }
      }
      if (typeof window.renderWinsTally === 'function') window.renderWinsTally();
    }

    // Persist so a reload restores the board mid-game.
    if (window.firebaseGameBackend && currentRoomId) {
      pendingMoveCount++;
      Promise.resolve(window.firebaseGameBackend.updateGameState(currentRoomId, {
        gameState: gameState,
        currentTurnPlayerId: myPeerId,
        lastUpdated: Date.now()
      })).catch(err => console.error('Failed to sync computer move:', err))
        .finally(() => { pendingMoveCount--; });
    }
  }, 450);
}

function resetGame(firstTurn = null) {
  cancelAiMove();
  pendingMoveCount = 0;
  const selectedFirstTurn = firstTurn || gameHost;
  window.currentTurnPlayerId = selectedFirstTurn;
  myTurn = (myPeerId === selectedFirstTurn || gamePlayers.length <= 1);
  gameState = ['', '', '', '', '', '', '', '', ''];
  updateBoard();
  
  document.getElementById('tic-tac-toe-board').classList.remove('disabled');
  document.getElementById('btn-play-again').classList.add('hidden');
  document.getElementById('screen-game').classList.remove('tie-background');
  const winsElReset = document.getElementById('fd-wins');
  if (winsElReset) winsElReset.classList.add('hidden');

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
  // Backgammon handles its own reset (next match game or fresh game) and
  // broadcasts it — none of the shared PLAY_AGAIN plumbing applies.
  if (getCurrentGameType() === 'Backgammon') {
    if (window.BGGame && window.BGGame.active) window.BGGame.reset();
    return;
  }

  const nextFirstTurn = gamePlayers[Math.floor(Math.random() * gamePlayers.length)] || myPeerId;

  const is5Dice = getCurrentGameType() === '5 Dice';
  if (is5Dice) {
    if (window.reset5DiceGame) window.reset5DiceGame(nextFirstTurn);
  } else {
    resetGame(nextFirstTurn);
  }

  if (window.firebaseGameBackend && currentRoomId) {
    try {
      const updates = {
        currentTurnPlayerId: nextFirstTurn,
        lastUpdated: Date.now()
      };
      if (is5Dice) {
        updates.fiveDiceState = window.fiveDiceState;
      } else {
        updates.gameState = ['', '', '', '', '', '', '', '', ''];
      }
      await window.firebaseGameBackend.updateGameState(currentRoomId, updates);
      await window.firebaseGameBackend.sendGameEvent(currentRoomId, { type: 'PLAY_AGAIN', firstTurn: nextFirstTurn, sender: myPeerId });
    } catch (err) {
      console.error('Failed to sync play-again:', err);
      showToast('Could not start a new game — check your connection.', '#dc3545');
    }
  }
});

// Host starts the game early with whoever is currently in the room.
const btnStartNowEl = document.getElementById('btn-start-now');
if (btnStartNowEl) {
  btnStartNowEl.addEventListener('click', async () => {
    if (!currentRoomId || !window.firebaseGameBackend) return;
    const lockedCount = gamePlayers.length;
    if (lockedCount < 2) { alert('You need at least 2 players to start.'); return; }
    btnStartNowEl.classList.add('hidden');
    // Lock the roster to the players who are here now (so nobody can join mid-game)
    // and flip the room to in-progress, which starts the game for everyone.
    await window.firebaseGameBackend.updateRoom(currentRoomId, { status: 'in-progress', maxPlayers: lockedCount });
    await window.firebaseGameBackend.updateGameState(currentRoomId, { status: 'in-progress' });
  });
}

function updateBoard() {
  gameState = parseGameState(gameState);
  const board = document.getElementById('tic-tac-toe-board');
  if (!board) return;
  const cells = board.querySelectorAll('.cell');
  cells.forEach((cell, i) => {
    const val = gameState[i] || '';
    cell.innerText = val;
    cell.classList.remove('cell-x', 'cell-o');
    if (val === 'X') {
      cell.classList.add('cell-x');
    } else if (val === 'O') {
      cell.classList.add('cell-o');
    }
  });
}

function checkWin() {
  gameState = parseGameState(gameState);
  const winPatterns = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];
  for (let pattern of winPatterns) {
    const [a,b,c] = pattern;
    if (gameState[a] && gameState[a] === gameState[b] && gameState[a] === gameState[c]) {
      const winner = gameState[a];
      const aiGame = isAIGame();
      const mySymbol = (aiGame || myPeerId === gameHost) ? 'X' : 'O';
      let opponent = roomPlayerDetails.find(p => p.peerId !== myPeerId);
      let opponentColor = aiGame ? '#333' : (opponent ? opponent.color : '#2a2a2a');
      let opponentName = aiGame ? 'Computer' : (opponent ? window.getDisplayName(opponent.peerId) : 'Opponent');
      let winnerColor = (winner === mySymbol) ? myColor : opponentColor;

      // Detect the transition into game-over (board isn't disabled yet) so the
      // celebration fires once, not on every echoed checkWin() call.
      const boardEl = document.getElementById('tic-tac-toe-board');
      const firstDetection = boardEl && !boardEl.classList.contains('disabled');

      document.getElementById('game-status').innerText = (winner === mySymbol) ? 'You Win!' : `${opponentName} Wins!`;
      if (boardEl) boardEl.classList.add('disabled');
      myTurn = false;
      document.getElementById('screen-game').style.backgroundColor = winnerColor;

      // Confetti for the local winner only, once per game.
      if (winner === mySymbol && firstDetection && window.confetti) {
        const config = { spread: 100, startVelocity: 50, scalar: 1.2 };
        window.confetti({ ...config, particleCount: 150, origin: { x: 0.2, y: 0.8 } });
        window.confetti({ ...config, particleCount: 150, origin: { x: 0.8, y: 0.8 } });
        setTimeout(() => window.confetti({ ...config, particleCount: 200, origin: { x: 0.5, y: 0.6 } }), 300);
      }
      return true;
    }
  }
  if (!gameState.includes('')) {
    document.getElementById('game-status').innerText = "It's a draw!";
    myTurn = false;
    
    let opponent = roomPlayerDetails.find(p => p.peerId !== myPeerId);
    let opponentColor = isAIGame() ? '#333' : (opponent ? opponent.color : '#2a2a2a');

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
    gameScreen.style.backgroundColor = '';
    gameScreen.classList.remove('tie-background');
  }

  cancelAiMove();
  if (window.voiceLeaveRoom) window.voiceLeaveRoom();

  if (window.firebaseGameBackend) {
    window.firebaseGameBackend.stopGameListeners();
  }

  const leavingRoomId = currentRoomId;
  if (leavingRoomId) {
    const room = activeRooms[leavingRoomId];
    const isFiveDiceOver = (window.fiveDiceState && window.fiveDiceState.isGameOver);
    // Use the side-effect-free check here; checkWin() mutates the DOM/turn state,
    // which corrupted the UI while leaving the room.
    const isTTTOver = checkWinSilent();
    const isGameOver = isFiveDiceOver || isTTTOver;
    // Fall back to the tracked game status when the lobby snapshot hasn't
    // arrived — the old cache-only gate left the player seated (and empty rooms
    // undeleted) whenever activeRooms was momentarily empty.
    const roomStatus = room ? room.status : (window.gameStarted ? 'in-progress' : 'open');

    // Single-player rooms normally die with their only player: "keep the seat
    // for rejoining" is multiplayer behavior, and without this a mid-game solo
    // leave left a "Game In Progress (You are playing)" card squatting in the
    // lobby forever. EXCEPTION: a solo 5 Dice game with real progress keeps its
    // Rejoin card, so a half-finished scorecard can be resumed later (an
    // abandoned vs-computer tic-tac-toe board isn't worth keeping).
    const isSoloRoom = room ? room.maxPlayers === 1 : window.gameMaxPlayers === 1;
    let soloResumable = false;
    if (isSoloRoom && !isGameOver && getCurrentGameType() === '5 Dice') {
      const myScores = (window.fiveDiceState && window.fiveDiceState.scores &&
                        window.fiveDiceState.scores[myPeerId]) || {};
      soloResumable = Object.values(myScores).some(v => typeof v === 'number');
    }
    // A backgammon game against the computer takes a while — keep its Rejoin
    // card too when there's real progress on the board.
    if (isSoloRoom && getCurrentGameType() === 'Backgammon' &&
        window.BGGame && window.BGGame.active && window.BGGame.hasProgress()) {
      soloResumable = true;
    }

    // Only remove player/delete room if the room is an unstarted lobby ('open'),
    // the game has finished, or it's single-player (and not a resumable solo
    // scorecard); a mid-game multiplayer leave keeps the seat for rejoining.
    if (roomStatus === 'open' || isGameOver || (isSoloRoom && !soloResumable)) {
      try {
        // Transactional removal: migrates the host (including hostUuid) and
        // deletes the room + game when the last player leaves. Never recreates
        // an already-deleted room.
        const res = window.firebaseGameBackend.removePlayerFromRoom
          ? await window.firebaseGameBackend.removePlayerFromRoom(leavingRoomId, { peerId: myPeerId, uuid: myUuid })
          : { ok: false };
        if (res.ok && !res.deleted) {
          await window.firebaseGameBackend.setGamePlayers(leavingRoomId, res.players);
          if (res.host) {
            await window.firebaseGameBackend.updateGameState(leavingRoomId, { host: res.host });
          }
        }
      } catch (err) {
        console.error('Error leaving room:', err);
      }
    }
  }

  currentRoomId = null;
  isHost = false;
  currentGameType = null;
  gamePlayers = [];
  roomPlayerDetails = [];
  gameState = ['', '', '', '', '', '', '', '', ''];
  // Drop the finished/abandoned board entirely: a stale fiveDiceState surviving
  // into the next room blocked state adoption and could corrupt the new game.
  window.fiveDiceState = null;
  window.currentFirstTurn = null;
  window.currentTurnPlayerId = null;

  updateBoard();
  document.getElementById('tic-tac-toe-board').classList.add('disabled');
  document.getElementById('btn-play-again').classList.add('hidden');

  showScreen('screen-lobby');
  updateDiagnostics();

  if (window.cleanup5DiceGame) {
    window.cleanup5DiceGame();
  }
  if (window.BGGame && window.BGGame.active) {
    window.BGGame.cleanup();
  }
  const bgc = document.getElementById('backgammon-container');
  if (bgc) bgc.classList.add('hidden');
};

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
  toastEl.style.backgroundColor = bgColor || '';
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

// --- DELETE ROOM LOGIC ---
let pendingDeleteRoomId = null;

window.promptDeleteRoom = function(e, roomId) {
  if (e) e.stopPropagation();
  const room = activeRooms[roomId];
  if (!room) return;

  pendingDeleteRoomId = roomId;
  const nameEl = document.getElementById('delete-room-name');
  if (nameEl) nameEl.innerText = room.name || 'this game';

  const modal = document.getElementById('delete-room-modal');
  if (modal) modal.classList.remove('hidden');
};

const deleteRoomModal = document.getElementById('delete-room-modal');
const btnConfirmDeleteRoom = document.getElementById('btn-confirm-delete-room');
const btnCancelDeleteRoom = document.getElementById('btn-cancel-delete-room');

if (btnCancelDeleteRoom) {
  btnCancelDeleteRoom.addEventListener('click', () => {
    if (deleteRoomModal) deleteRoomModal.classList.add('hidden');
    pendingDeleteRoomId = null;
  });
}

if (btnConfirmDeleteRoom) {
  btnConfirmDeleteRoom.addEventListener('click', async () => {
    if (!pendingDeleteRoomId) return;
    const targetRoomId = pendingDeleteRoomId;
    if (deleteRoomModal) deleteRoomModal.classList.add('hidden');
    
    // Double check the room still exists and is safe to delete: either no other
    // players are listed, or it has gone idle (abandoned).
    const room = activeRooms[targetRoomId];
    if (room) {
      const playerList = room.players || [];
      const otherPlayers = playerList.filter(p => p.uuid !== myUuid && p.peerId !== myPeerId);
      if (otherPlayers.length > 0 && !isRoomIdle(room)) {
        showToast("Cannot delete: another player is active in the room", "#dc3545");
        pendingDeleteRoomId = null;
        return;
      }
    }

    try {
      await window.firebaseGameBackend.deleteRoom(targetRoomId);
      showToast("Game room deleted");
    } catch (err) {
      console.error("Error deleting room:", err);
      showToast("Failed to delete game room", "#dc3545");
    }
    pendingDeleteRoomId = null;
  });
}

// APP INITIALIZATION
createBoard();

// Re-render the lobby once a minute so a room that crosses the idle threshold
// surfaces the host delete-✕ even if no new Firebase event has arrived.
setInterval(() => {
  const lobby = document.getElementById('screen-lobby');
  if (lobby && lobby.classList.contains('active')) {
    renderRooms();
    // Throttled internally to twice an hour, so a long-open lobby still sweeps
    // 48-hour-old rooms without hammering the database.
    if (window.firebaseGameBackend) window.firebaseGameBackend.cleanupOldRooms();
  }
}, 60000);
if (!myName) {
  document.getElementById('settings-player-id-section').style.display = 'none';
  // No lobby to go back to until a name is set — hide the menu on first run.
  const firstRunMenuBtn = document.querySelector('.menu-btn[data-menu="settings"]');
  if (firstRunMenuBtn) firstRunMenuBtn.style.display = 'none';
  // First run is the one time the button is shown — the menu is hidden above.
  document.getElementById('btn-save-settings').classList.remove('hidden');
  const colorPicker = document.getElementById('player-color-picker');
  if (colorPicker) colorPicker.value = myColor;
  showScreen('screen-settings');
} else {
  startLobbyFirebase();

  // Deep links, so the Score Sheet (a separate page) can jump straight here.
  const landingHash = (window.location.hash || '').toLowerCase();
  if (landingHash === '#about' || landingHash === '#settings') {
    // Drop the hash so a later refresh lands on the lobby as usual.
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (landingHash === '#about') showScreen('screen-about');
    else openSettings();
  }
}
