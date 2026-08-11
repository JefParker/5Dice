function getPeerName(pId) {
  // Delegate to the canonical resolver in app.js (handles set names and the
  // "Player N" numbering for players who haven't set a display name).
  if (typeof window.getDisplayName === 'function') return window.getDisplayName(pId);
  if (pId === window.myPeerId && window.myName) return window.myName;
  if (window.roomPlayerDetails && Array.isArray(window.roomPlayerDetails)) {
    const found = window.roomPlayerDetails.find(p => p.peerId === pId || p.uuid === pId);
    if (found && found.name) return found.name;
  }
  return 'Player';
}

function getPeerColor(pId) {
  if (pId === window.myPeerId) return window.myColor;
  if (window.roomPlayerDetails && Array.isArray(window.roomPlayerDetails)) {
    const found = window.roomPlayerDetails.find(p => p.peerId === pId || p.uuid === pId);
    if (found && found.color) return found.color;
  }
  // Generic fallback (avoid getOpponentColor — 2-player biased).
  return '#333';
}

function calculateUpperPar(scoresObj) {
  if (!scoresObj) return { par: 0, text: ' (on par)' };
  const upperBenchmarks = {
    ones: 3,
    twos: 6,
    threes: 9,
    fours: 12,
    fives: 15,
    sixes: 18
  };
  let par = 0;
  let scoredCount = 0;
  for (const cat in upperBenchmarks) {
    const val = scoresObj[cat];
    if (typeof val === 'number') {
      par += (val - upperBenchmarks[cat]);
      scoredCount++;
    }
  }
  if (scoredCount === 0 || par === 0) {
    return { par: 0, text: ' (on par)' };
  }
  const parText = par > 0 ? ` (+${par})` : ` (${par})`;
  return { par, text: parText };
}

window.fiveDiceState = {
  dice: [1, 1, 1, 1, 1],
  held: [false, false, false, false, false],
  rollsLeft: 3,
  scores: {},
  turnsLeft: 13
};

function init5DiceGame() {
  window._fd_celebrated = false;
  window.fiveDiceState = {
    dice: [1, 1, 1, 1, 1],
    held: [false, false, false, false, false],
    rollsLeft: 3,
    scores: {},
    turnsLeft: 13,
    isGameOver: false,
    // Persisted turn-order anchor: every client derives the same rotation from
    // this instead of a local-only variable that a reload would lose.
    firstTurn: window.currentFirstTurn || window.gameHost || window.myPeerId
  };

  const players = window.gamePlayers || [window.myPeerId];
  for (const p of players) {
    window.fiveDiceState.scores[p] = {
      ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
      chance: null, 'three-kind': null, 'four-kind': null, 'full-house': null,
      'sm-straight': null, 'lg-straight': null, 'five-dice': null, 'bonus-5s': null
    };
  }
  
  update5DiceUI();
}

function update5DiceUI() {
  if (!window.fiveDiceState) return;
  if (!window.fiveDiceState.scores) window.fiveDiceState.scores = {};
  if (window.myPeerId && !window.fiveDiceState.scores[window.myPeerId]) {
    window.fiveDiceState.scores[window.myPeerId] = {
      ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
      chance: null, 'three-kind': null, 'four-kind': null, 'full-house': null,
      'sm-straight': null, 'lg-straight': null, 'five-dice': null, 'bonus-5s': null
    };
  }
  const state = window.fiveDiceState;
  
  if (window.myTurn && !window.fiveDiceState.isGameOver) {
    document.getElementById('fd-board').classList.remove('hidden');
    document.getElementById('fd-scorecard').classList.add('hidden');
    // Also dim/disable the roll button once out of rolls (previously only the
    // handler guard stopped it, so it still looked clickable at 0 rolls).
    const outOfRolls = state.rollsLeft <= 0;
    document.getElementById('fd-roll-btn').style.opacity = outOfRolls ? '0.3' : '1';
    document.getElementById('fd-roll-btn').style.pointerEvents = outOfRolls ? 'none' : 'auto';
  } else {
    document.getElementById('fd-board').classList.add('hidden');
    document.getElementById('fd-scorecard').classList.remove('hidden');
    document.getElementById('fd-roll-btn').style.opacity = '0.3';
    document.getElementById('fd-roll-btn').style.pointerEvents = 'none';
    renderScorecard();
  }

  const btnPlayAgain = document.getElementById('btn-play-again');
  if (btnPlayAgain) {
    if (window.fiveDiceState.isGameOver) {
      btnPlayAgain.classList.remove('hidden');
    } else {
      btnPlayAgain.classList.add('hidden');
    }
  }
  
  
  // Render dice
  for (let i = 0; i < 5; i++) {
    const dieEl = document.querySelector(`.fd-die[data-index="${i}"]`);
    if (dieEl) {
      dieEl.classList.remove('die-1', 'die-2', 'die-3', 'die-4', 'die-5', 'die-6');
      dieEl.classList.add(`die-${state.dice[i]}`);
      dieEl.classList.toggle('held', state.held[i]);
    }
  }
  
  if (state.isGameOver) {
    const playArea = document.getElementById('fd-play-area');
    if (playArea) playArea.style.display = 'none';
  } else {
    const playArea = document.getElementById('fd-play-area');
    if (playArea) playArea.style.display = 'flex';
  }

  // Render rolls left
  document.getElementById('fd-rolls-left').innerText = state.rollsLeft;
  
  const turnCats = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes', 'chance', 'three-kind', 'four-kind', 'full-house', 'sm-straight', 'lg-straight', 'five-dice'];
  let myScoreCount = 0;
  const pScores = state.scores[window.myPeerId] || {};
  for (const cat of turnCats) {
    if (typeof pScores[cat] === 'number') myScoreCount++;
  }
  document.getElementById('fd-turns-count').innerText = Math.max(0, 13 - myScoreCount);

  // Sync 3D dice state AFTER updating playArea visibility so it can detect if it's hidden
  if (window.dice3d && !window.dice3d.rolling) {
    const targetElements = [];
    for (let i = 0; i < 5; i++) {
      targetElements.push(document.querySelector(`.fd-die[data-index="${i}"]`));
    }
    window.dice3d.snapToState(state.dice, state.held, targetElements);
  }
  
  const myScores = state.scores[window.myPeerId] || {};
  let upperTotal = 0;
  let lowerTotal = 0;

  // Tint the board + roll button in the local player's own color.
  const fdc = document.getElementById('five-dice-container');
  if (fdc && window.myColor) fdc.style.setProperty('--pc', fdHexToRgb(window.myColor));

  // Live "potential score" previews appear on unscored tiles once you've rolled —
  // but not while the 3D dice are still tumbling (wait for them to settle), and
  // only when Hints is on (Settings). With Hints off, unscored tiles stay blank.
  const hintsOn = (window.hintsEnabled !== false);
  const rolled = state.rollsLeft < 3 && !(window.dice3d && window.dice3d.rolling);

  document.querySelectorAll('#fd-board .fd-cat').forEach(catEl => {
    const cat = catEl.getAttribute('data-category');
    const scoreEl = catEl.querySelector('.fd-cat-score');
    catEl.classList.remove('scored', 'avail', 'zero');
    const scored = (myScores[cat] !== null && myScores[cat] !== undefined);
    if (scored) {
      scoreEl.innerText = myScores[cat];
      catEl.classList.add('scored');
      if (FD_UPPER_KEYS.includes(cat)) upperTotal += myScores[cat];
      else lowerTotal += myScores[cat];
    } else if (cat === 'bonus-5s') {
      scoreEl.innerText = '';            // filled only by the Yahtzee bonus rule
    } else if (rolled && window.myTurn && hintsOn) {
      const pot = calculate5DiceScore(cat, state.dice, pScores);
      scoreEl.innerText = pot;
      catEl.classList.add('avail');
      if (pot === 0) catEl.classList.add('zero');
    } else {
      scoreEl.innerText = '';
    }
  });
  
  document.getElementById('fd-upper-total').innerText = upperTotal;
  document.getElementById('fd-lower-total').innerText = lowerTotal;
  
  const bonus = upperTotal >= 63 ? 35 : 0;
  document.getElementById('fd-bonus').innerText = bonus;
  
  const parInfo = calculateUpperPar(myScores);
  document.getElementById('fd-total-par').innerText = `${upperTotal}${parInfo.text}`;
  
  // Final total UI
  const total = upperTotal + lowerTotal + bonus;
  document.getElementById('fd-grand-total').innerText = total;

  // Every path that starts a turn ends up here, so this is the one place that
  // reliably catches "it's my turn and nothing's been rolled yet".
  if (window.maybeAutoRoll5Dice) window.maybeAutoRoll5Dice();

  // The board's height moves with it — a scored row grows a tick, the scorecard
  // swaps in and out — so re-check the fit whenever it has been repainted.
  if (window.scheduleFiveDiceFit) window.scheduleFiveDiceFit();
}

// --- Scorecard skin helpers ---
const FD_UPPER_KEYS = ['ones','twos','threes','fours','fives','sixes'];
const FD_LOWER_KEYS = ['chance','three-kind','four-kind','full-house','sm-straight','lg-straight','five-dice','bonus-5s'];

function fdEsc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fdHexToRgb(hex){
  let h = (hex||'').trim(); if (h[0]==='#') h = h.slice(1);
  if (h.length===3) h = h.split('').map(c=>c+c).join('');
  const n = parseInt(h,16);
  if (h.length!==6 || isNaN(n)) return '90,110,140';
  return `${(n>>16)&255},${(n>>8)&255},${n&255}`;
}
function fdLighten(rgb, amt){ const [r,g,b]=rgb.split(',').map(Number); const m=v=>Math.round(v+(255-v)*amt); return `${m(r)},${m(g)},${m(b)}`; }
function fdSum(state,p,keys){ let t=0; const s=state.scores[p]; if(s) keys.forEach(k=>{ if(typeof s[k]==='number') t+=s[k]; }); return t; }
function fdUpper(state,p){ return fdSum(state,p,FD_UPPER_KEYS); }
function fdLower(state,p){ return fdSum(state,p,FD_LOWER_KEYS); }
function fdGrand(state,p){ const u=fdUpper(state,p); return u + (u>=63?35:0) + fdLower(state,p); }

const FD_FACE = (n)=>`<span class="fd-face">${['','⚀','⚁','⚂','⚃','⚄','⚅'][n]}</span>`;
const FD_ICONS = {
  q:'<span class="fd-q">?</span>',
  house:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#ffd08a" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>',
  rain:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke-width="2" stroke-linecap="round"><path d="M3 18a9 9 0 0 1 18 0" stroke="#ff8a8a"/><path d="M6 18a6 6 0 0 1 12 0" stroke="#ffd08a"/><path d="M9 18a3 3 0 0 1 6 0" stroke="#8fe08a"/></svg>',
  star:'<span class="fd-star">★</span>'
};

function renderScorecard() {
  const state = window.fiveDiceState;
  let players = Object.keys(state.scores);
  if (state.isGameOver) players.sort((a,b)=>fdGrand(state,b)-fdGrand(state,a));

  const activeId = window.currentTurnPlayerId;

  const upperCats = [
    { id:'ones', label:"1's", ic:FD_FACE(1) }, { id:'twos', label:"2's", ic:FD_FACE(2) },
    { id:'threes', label:"3's", ic:FD_FACE(3) }, { id:'fours', label:"4's", ic:FD_FACE(4) },
    { id:'fives', label:"5's", ic:FD_FACE(5) }, { id:'sixes', label:"6's", ic:FD_FACE(6) },
    { id:'bonus', label:'Bonus &gt; 62', ic:'' }
  ];
  const lowerCats = [
    { id:'chance', label:'Chance', ic:FD_ICONS.q }, { id:'three-kind', label:'3 of a kind', ic:FD_FACE(3) },
    { id:'four-kind', label:'4 of a kind', ic:FD_FACE(4) }, { id:'full-house', label:'Full House', ic:FD_ICONS.house },
    { id:'sm-straight', label:'Sm Strt', ic:FD_ICONS.rain }, { id:'lg-straight', label:'Lg Strt', ic:FD_ICONS.rain },
    { id:'five-dice', label:'5 Dice', ic:FD_FACE(5) }, { id:'bonus-5s', label:"Bonus 5's", ic:FD_ICONS.star }
  ];

  const cell = (p, val, extra) => {
    const empty = (val===null || val===undefined || val==='');
    const cls = 'fd-sc-score' + (empty?' empty':'') + (p===activeId?' active':'') + (extra?(' '+extra):'');
    return `<div class="${cls}" style="--pc:${fdHexToRgb(getPeerColor(p))}">${empty?'&ndash;':val}</div>`;
  };
  const rowCells = (fn)=>players.map(fn).join('');

  // active-column glow layer (one full-height panel behind the active player's column)
  let html = `<div class="fd-sc-colbg"><div class="col"></div>${
    rowCells(p=>`<div class="col${p===activeId?' active':''}" style="--pc:${fdHexToRgb(getPeerColor(p))}"></div>`)}</div>`;

  // header (names tinted in a lightened version of each player's own color)
  html += `<div class="fd-sc-row fd-sc-head"><div class="fd-sc-cat"></div>${
    rowCells(p=>{ const rgb=fdHexToRgb(getPeerColor(p));
      return `<div class="fd-sc-ph${p===activeId?' active':''}" style="--pc:${rgb};--pcl:${fdLighten(rgb,.55)};--pcm:${fdLighten(rgb,.18)}">${fdEsc(getPeerName(p))}</div>`;
    })}</div>`;

  // upper rows
  upperCats.forEach(c=>{
    const catInner = c.ic ? `<span class="fd-ic">${c.ic}</span>${c.label}` : c.label;
    html += `<div class="fd-sc-row"><div class="fd-sc-cat">${catInner}</div>${
      rowCells(p=>{
        if (c.id==='bonus') return cell(p, fdUpper(state,p)>=63?35:0);
        return cell(p, state.scores[p]?state.scores[p][c.id]:null);
      })}</div>`;
  });
  // upper total (with par)
  html += `<div class="fd-sc-row fd-sc-tot"><div class="fd-sc-cat">Upper Tot</div>${
    rowCells(p=>{
      const u=fdUpper(state,p); const par=calculateUpperPar(state.scores[p]||{});
      return cell(p, `${u}<span class="fd-sub">${par.text}</span>`, 'stack');
    })}</div>`;

  // lower rows
  lowerCats.forEach(c=>{
    html += `<div class="fd-sc-row"><div class="fd-sc-cat lower"><span class="fd-ic">${c.ic}</span>${c.label}</div>${
      rowCells(p=>cell(p, state.scores[p]?state.scores[p][c.id]:null))}</div>`;
  });
  // lower total
  html += `<div class="fd-sc-row fd-sc-tot"><div class="fd-sc-cat">Lower Tot</div>${
    rowCells(p=>cell(p, fdLower(state,p)))}</div>`;
  // grand total
  html += `<div class="fd-sc-row fd-sc-tot fd-sc-grand"><div class="fd-sc-cat">Grand Total</div>${
    rowCells(p=>cell(p, fdGrand(state,p), 'grand'))}</div>`;

  const el = document.getElementById('fd-scorecard');
  el.style.setProperty('--n', players.length);
  el.classList.toggle('tight', players.length >= 4);
  el.innerHTML = html;
}

// Bind dice click
document.querySelectorAll('.fd-die').forEach(die => {
  die.addEventListener('click', (e) => {
    if (!window.myTurn) return; // Only hold on your turn
    const dieEl = e.target.closest('.fd-die');
    if (!dieEl) return;
    const idx = parseInt(dieEl.getAttribute('data-index'), 10);
    if (isNaN(idx)) return;
    if (window.fiveDiceState.rollsLeft < 3) {
      window.fiveDiceState.held[idx] = !window.fiveDiceState.held[idx];
      update5DiceUI();
      broadcast5DiceHold();
    }
  });
});

// The roll itself, shared by the Roll button and by Auto-Roll.
function performRoll() {
  if (!window.myTurn) return;
  if (!window.fiveDiceState) return;
  if (window.fiveDiceState.rollsLeft <= 0) return;

  const btn = document.getElementById('fd-roll-btn');
  if (!btn) return;
  if (btn.classList.contains('is-rolling')) return;
  btn.classList.add('is-rolling');

  // You cannot hold a die before you have thrown it, so the first roll of a
  // turn always throws all five. That is the rule of the game, and it also
  // means any stale hold that survived the turn hand-off is harmless: without
  // it, a held die would keep the value it was reset to, which is 1.
  if (window.fiveDiceState.rollsLeft === 3) {
    window.fiveDiceState.held = [false, false, false, false, false];
  }

  let unheldIndices = [];
  let finalValues = [];
  for (let i = 0; i < 5; i++) {
    if (window.fiveDiceState.held[i]) {
      finalValues.push(window.fiveDiceState.dice[i]);
    } else {
      finalValues.push(Math.floor(Math.random() * 6) + 1);
      unheldIndices.push(i);
    }
  }
  
  window.fiveDiceState.dice = finalValues;
  window.fiveDiceState.rollsLeft--;
  
  broadcast5DiceState();
  
  const targetElements = [];
  for (let i = 0; i < 5; i++) {
    targetElements.push(document.querySelector(`.fd-die[data-index="${i}"]`));
  }
  
  if (window.dice3d) {
    window.dice3d.roll(finalValues, unheldIndices, targetElements, () => {
      btn.classList.remove('is-rolling');
      update5DiceUI();
    });
    update5DiceUI(); // clear the previous previews immediately while the dice tumble
  } else {
    btn.classList.remove('is-rolling');
    update5DiceUI();
  }
}

// Bind roll click
document.getElementById('fd-roll-btn').addEventListener('click', performRoll);

// --- AUTO-ROLL ---
// With the Auto-Roll setting on (app.js, default ON), the first of a turn's three
// rolls happens by itself. Only the first: holds and re-rolls are the actual game,
// so those stay manual. rollsLeft === 3 is exactly "nothing rolled yet this turn".
// The small delay lets the turn hand-off finish painting first — rolling inside
// the same frame that reveals the board reads as a glitch rather than a roll.
const FD_AUTO_ROLL_DELAY = 350;
let fdAutoRollTimer = null;

function fdAutoRollAllowed() {
  return window.autoRollEnabled !== false &&
    !!window.fiveDiceState &&
    !!window.myTurn &&
    window.gameStarted !== false &&
    !window.fiveDiceState.isGameOver &&
    window.fiveDiceState.rollsLeft === 3;
}

window.maybeAutoRoll5Dice = function() {
  if (!fdAutoRollAllowed()) {
    clearTimeout(fdAutoRollTimer);
    fdAutoRollTimer = null;
    return;
  }
  // update5DiceUI() runs on every state change; collapse repeat calls into the
  // one pending roll instead of stacking timers.
  if (fdAutoRollTimer) return;
  fdAutoRollTimer = setTimeout(() => {
    fdAutoRollTimer = null;
    if (fdAutoRollAllowed()) performRoll();
  }, FD_AUTO_ROLL_DELAY);
};

// Bind category click (Scoring)
document.querySelectorAll('.fd-cat').forEach(catEl => {
  catEl.addEventListener('click', () => {
    if (!window.myTurn) return;
    if (!window.fiveDiceState) return;
    if (window.fiveDiceState.rollsLeft === 3) return; // Must roll at least once
    
    const cat = catEl.getAttribute('data-category');
    if (cat === 'bonus-5s') return; // Not a direct user input

    if (!window.fiveDiceState.scores) window.fiveDiceState.scores = {};
    if (!window.fiveDiceState.scores[window.myPeerId]) {
      window.fiveDiceState.scores[window.myPeerId] = {
        ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
        chance: null, 'three-kind': null, 'four-kind': null, 'full-house': null,
        'sm-straight': null, 'lg-straight': null, 'five-dice': null, 'bonus-5s': null
      };
    }
    
    if (window.fiveDiceState.scores[window.myPeerId][cat] !== null && window.fiveDiceState.scores[window.myPeerId][cat] !== undefined) return; // Already scored
    
    const score = calculate5DiceScore(cat, window.fiveDiceState.dice, window.fiveDiceState.scores[window.myPeerId]);
    
    // Show commit dialog. Remove any existing overlay first so we never have two
    // overlays sharing the same element IDs (which wired handlers to the wrong
    // buttons and could commit the wrong category).
    document.querySelectorAll('.fd-commit-overlay').forEach(el => el.remove());

    const commitDiv = document.createElement('div');
    commitDiv.className = 'fd-commit-overlay';
    commitDiv.innerHTML = `
      <div>Score ${score} in ${cat}?</div>
      <div class="fd-commit-buttons">
        <button id="btn-fd-cancel" class="fd-cancel">Cancel</button>
        <button id="btn-fd-commit" class="btn-success">Commit</button>
      </div>
    `;
    document.getElementById('five-dice-container').appendChild(commitDiv);

    // Bind against THIS overlay's buttons (not getElementById, which returns the
    // first match in the document).
    commitDiv.querySelector('#btn-fd-cancel').onclick = () => {
      commitDiv.remove();
    };

    commitDiv.querySelector('#btn-fd-commit').onclick = () => {
      window.fiveDiceState.scores[window.myPeerId][cat] = score;
      commitDiv.remove();
      
      // Yahtzee Bonus Rule: if 5 of a kind rolled, and 'five-dice' already 50, add 100 to 'bonus-5s'
      if (cat !== 'five-dice') {
        const is5Dice = window.fiveDiceState.dice.every(d => d === window.fiveDiceState.dice[0]);
        if (is5Dice) {
          const has5DiceScore = window.fiveDiceState.scores[window.myPeerId]['five-dice'] === 50;
          if (has5DiceScore) {
            let currentBonus = window.fiveDiceState.scores[window.myPeerId]['bonus-5s'] || 0;
            window.fiveDiceState.scores[window.myPeerId]['bonus-5s'] = currentBonus + 100;
            broadcast5DiceScore('bonus-5s', currentBonus + 100);
          }
        }
      }
      
      window.fiveDiceState.rollsLeft = 3;
      window.fiveDiceState.held = [false, false, false, false, false];
      window.fiveDiceState.dice = [1, 1, 1, 1, 1];
      window.fiveDiceState.turnsLeft--; 
      
      if (check5DiceGameOver()) {
        handle5DiceGameOver();
        // This commit ended the game, so THIS client records the result — exactly
        // once (the single finishing player), avoiding every client double-counting.
        // A sole winner counts as a win; a tie is recorded separately for each
        // tied player (not as a win). Solo games have no opponent, so there is
        // nothing meaningful to tally.
        const soloGame = (window.gamePlayers || []).length <= 1;
        if (!soloGame) {
          const finalWinners = compute5DiceWinners();
          if (finalWinners.length > 1) {
            if (typeof window.recordRoomTie === 'function') finalWinners.forEach(w => window.recordRoomTie(w));
          } else {
            if (typeof window.recordRoomWin === 'function') finalWinners.forEach(w => window.recordRoomWin(w));
          }
        }
      } else {
        if (window.sync5DiceState) {
          window.sync5DiceState(window.fiveDiceState);
        }
        if (window.updateGameBackground) window.updateGameBackground();
      }

      broadcast5DiceScore(cat, score);
    };
  });
});

function calculate5DiceScore(category, dice, playerScores) {
  const counts = {1:0, 2:0, 3:0, 4:0, 5:0, 6:0};
  let sum = 0;
  dice.forEach(d => { counts[d]++; sum += d; });

  const hasN = (n) => Object.values(counts).some(c => c >= n);
  // Joker rule: a five-of-a-kind may fill Full House / a straight for full
  // points only once the 5 Dice box is already used (scored 50 or zeroed).
  // A first-turn five-of-a-kind can NOT bank Full House for a free 25.
  const jokerOk = hasN(5) && playerScores && typeof playerScores['five-dice'] === 'number';

  switch(category) {
    case 'ones': return counts[1] * 1;
    case 'twos': return counts[2] * 2;
    case 'threes': return counts[3] * 3;
    case 'fours': return counts[4] * 4;
    case 'fives': return counts[5] * 5;
    case 'sixes': return counts[6] * 6;
    case 'chance': return sum;
    case 'three-kind': return hasN(3) ? sum : 0;
    case 'four-kind': return hasN(4) ? sum : 0;
    case 'full-house': return (Object.values(counts).includes(3) && Object.values(counts).includes(2)) || jokerOk ? 25 : 0;
    case 'sm-straight':
      if (counts[1] && counts[2] && counts[3] && counts[4]) return 30;
      if (counts[2] && counts[3] && counts[4] && counts[5]) return 30;
      if (counts[3] && counts[4] && counts[5] && counts[6]) return 30;
      return jokerOk ? 30 : 0;
    case 'lg-straight':
      if (counts[1] && counts[2] && counts[3] && counts[4] && counts[5]) return 40;
      if (counts[2] && counts[3] && counts[4] && counts[5] && counts[6]) return 40;
      return jokerOk ? 40 : 0;
    case 'five-dice': return hasN(5) ? 50 : 0;
    case 'bonus-5s': return 0; // Filled only by the automatic Yahtzee bonus rule
  }
  return 0;
}

function broadcast5DiceState() {
  const msg = {
    type: '5DICE_ROLL',
    dice: window.fiveDiceState.dice,
    held: window.fiveDiceState.held,
    rollsLeft: window.fiveDiceState.rollsLeft,
    sender: window.myPeerId
  };
  if (typeof window.sendGameAction === 'function') {
    window.sendGameAction(msg);
  }
}

function broadcast5DiceHold() {
  const msg = {
    type: '5DICE_HOLD',
    held: window.fiveDiceState.held,
    sender: window.myPeerId
  };
  if (typeof window.sendGameAction === 'function') {
    window.sendGameAction(msg);
  }
}

function broadcast5DiceScore(category, score) {
  const msg = {
    type: '5DICE_SCORE',
    category: category,
    score: score,
    player: window.myPeerId,
    sender: window.myPeerId
  };
  if (typeof window.sendGameAction === 'function') {
    window.sendGameAction(msg);
  }
}

window.handle5DiceMessage = function(msg) {
  // A roll or a hold describes the dice of whoever is ON ROLL. If it is MY
  // turn then that is me, and a message still in flight from the previous
  // player's turn must not touch my dice — it used to land in the gap between
  // the turn hand-off and my first roll, leaving their holds switched on over
  // my freshly-reset 1s, which the roll then dutifully kept.
  //
  // sync5DiceState already refuses Firebase echoes on my own turn for exactly
  // this reason ("local player is authoritative for active turn"); the peer
  // messages need the same rule. Scores are different: they carry the other
  // player's result and hand the turn over, so they always apply.
  if (window.myTurn && (msg.type === '5DICE_ROLL' || msg.type === '5DICE_HOLD')) return;

  if (msg.type === '5DICE_ROLL') {
    const playArea = document.getElementById('fd-play-area');
    if (playArea) playArea.scrollIntoView({ behavior: 'smooth', block: 'end' });
    
    window.fiveDiceState.held = msg.held;
    window.fiveDiceState.rollsLeft = msg.rollsLeft;
    const finalValues = msg.dice;
    let unheldIndices = [];
    for (let i = 0; i < 5; i++) {
      if (!window.fiveDiceState.held[i]) {
        unheldIndices.push(i);
      }
    }
    
    const targetElements = [];
    for (let i = 0; i < 5; i++) {
      targetElements.push(document.querySelector(`.fd-die[data-index="${i}"]`));
    }
    
    if (window.dice3d) {
      window.dice3d.roll(finalValues, unheldIndices, targetElements, () => {
        window.fiveDiceState.dice = finalValues;
        update5DiceUI();
      });
    } else {
      window.fiveDiceState.dice = finalValues;
      update5DiceUI();
    }
  } else if (msg.type === '5DICE_HOLD') {
    window.fiveDiceState.held = msg.held;
    update5DiceUI();
  } else if (msg.type === '5DICE_SCORE') {
    if (!window.fiveDiceState.scores[msg.player]) {
       window.fiveDiceState.scores[msg.player] = {};
    }
    // Update score (accumulate if bonus-5s)
    if (msg.category === 'bonus-5s') {
      window.fiveDiceState.scores[msg.player][msg.category] = msg.score;
      update5DiceUI();
      return; // Bonus score doesn't end turn
    } else {
      window.fiveDiceState.scores[msg.player][msg.category] = msg.score;
    }
    
    if (msg.player !== window.myPeerId) {
      const pName = getPeerName(msg.player);
      const pColor = getPeerColor(msg.player);
      const catLabels = {
        'ones': "one's", 'twos': "two's", 'threes': "three's", 'fours': "four's", 'fives': "five's", 'sixes': "six's",
        'chance': "chance", 'three-kind': "3 of a kind", 'four-kind': "4 of a kind", 'full-house': "full house",
        'sm-straight': "small straight", 'lg-straight': "large straight", 'five-dice': "5 dice"
      };
      const catLabel = catLabels[msg.category] || msg.category;
      if (typeof window.showToast === 'function') {
        const ptsWord = msg.score === 1 ? 'point' : 'points';
        window.showToast(`${pName} took ${msg.score} ${ptsWord} on ${catLabel}.`, pColor);
      }
    }
    
    update5DiceUI();
    
    if (check5DiceGameOver()) {
      handle5DiceGameOver();
    } else {
      window.fiveDiceState.rollsLeft = 3;
      window.fiveDiceState.held = [false, false, false, false, false];
      window.fiveDiceState.dice = [1,1,1,1,1];
      if (window.sync5DiceState) {
        window.sync5DiceState(window.fiveDiceState);
      }
      if (window.updateGameBackground) window.updateGameBackground();
      update5DiceUI();
    }
  }
};

window.cleanup5DiceGame = function() {
  if (window.dice3d) {
    window.dice3d.destroy();
    window.dice3d = null;
  }
  // Never leave the chrome swept away for the next screen — you'd come back to
  // a game with no header and no way to reach the ☰ menu.
  showGameChrome();
  fdFitKey = null;   // next game measures itself once, fresh
};

// ---------------------------------------------------------------------------
// SCREEN FIT
// Two related things, both about the board being boxed in on a phone: sweeping
// the header and footer out of the way on a tap, and shrinking a board that is
// only just too tall so the last row isn't behind a scroll.
// ---------------------------------------------------------------------------

// How far the board may be squeezed. Below this it stops being "nearly fits"
// and starts being unreadable, so it is left alone and scrolls as before.
const FD_MIN_SQUEEZE = 0.82;

// The viewport the current squeeze was worked out for. The board is sized ONCE,
// when it first comes up with its rows in place, and then left alone — a board
// that re-measured on every repaint visibly wiggled as scores went in. Only a
// genuine change of viewport (rotating the phone) earns a fresh measurement.
let fdFitKey = null;

function fdGameScreen() { return document.getElementById('screen-game'); }
function fdScrollBox() {
  const s = fdGameScreen();
  return s ? s.querySelector('.game-container') : null;
}
function fdOnFiveDice() {
  const c = document.getElementById('five-dice-container');
  const s = fdGameScreen();
  return !!c && !c.classList.contains('hidden') && !!s && !s.classList.contains('hidden');
}

// Shrink the board by just enough to clear the overflow, or leave it be.
// Runs once per viewport; see fdFitKey.
function fitFiveDiceBoard() {
  const board = document.getElementById('fd-board');
  const box = fdScrollBox();
  if (!board || !box || !fdOnFiveDice()) return;
  if (board.classList.contains('hidden')) return;   // opponent's turn: scorecard is up

  const key = window.innerWidth + 'x' + window.innerHeight;
  if (key === fdFitKey) return;                     // already sized for this screen

  // Measure unsqueezed: the previous fit is not a starting point, or the board
  // would ratchet smaller every time this runs.
  board.style.setProperty('--fd-sq', '1');
  board.style.setProperty('--fd-shrink', '0px');

  // Don't let a half-built board set the size for the whole game — its rows
  // have to be in before the measurement means anything.
  const natural = board.offsetHeight;
  if (natural < 200) return;

  fdFitKey = key;                                   // measured: this is the one

  const over = box.scrollHeight - box.clientHeight;
  if (over <= 0) return;                            // already fits

  const needed = (natural - over) / natural;
  if (needed < FD_MIN_SQUEEZE) return;              // too far off to rescue

  board.style.setProperty('--fd-sq', String(needed));
  board.style.setProperty('--fd-shrink', (natural * (1 - needed)) + 'px');
}

// Collapsed into one call per frame: update5DiceUI, resize and the chrome
// toggle can all ask for a fit in the same tick.
let fdFitPending = false;
window.scheduleFiveDiceFit = function() {
  if (fdFitPending) return;
  fdFitPending = true;
  requestAnimationFrame(() => {
    fdFitPending = false;
    fitFiveDiceBoard();
  });
};

function showGameChrome() {
  const s = fdGameScreen();
  if (s) s.classList.remove('chrome-hidden');
}

function toggleGameChrome() {
  const s = fdGameScreen();
  if (!s) return;
  // Measure each bar so it collapses by exactly its own height, whatever the
  // breakpoint or skin has made of it.
  const header = s.querySelector('.top-header');
  const footer = s.querySelector('.app-footer');
  if (header) s.style.setProperty('--chrome-top', header.offsetHeight + 'px');
  if (footer) s.style.setProperty('--chrome-bottom', footer.offsetHeight + 'px');
  s.classList.toggle('chrome-hidden');
  // Deliberately NOT re-fitting here. The board keeps the size it was given;
  // re-measuring would resize it every time the bars moved, which is the
  // wiggling this is meant to avoid. Hiding the bars just gives it more room.
}

// A tap on the BACKGROUND toggles the chrome. Anything you could be aiming at
// is excluded, and a drag is not a tap — without the slop test, flicking the
// scorecard up and down would flap the bars on every scroll.
(function bindChromeTap() {
  const box = fdScrollBox();
  if (!box) return;
  // The whole play area is off limits, not just the dice themselves. A 3D die
  // is drawn on an overlay canvas and spills past the .fd-die box it tracks, so
  // tapping the die you can SEE often lands in the gap beside it — which used to
  // read as a background tap and flap the bars on every hold.
  const IGNORE = '.fd-play-area, .fd-cat, .fd-die, .fd-roll-btn, .fd-commit-overlay,' +
                 ' button, a, input, select, textarea, #fd-scorecard, #backgammon-container';
  let sx = 0, sy = 0, moved = false;
  box.addEventListener('pointerdown', (e) => {
    sx = e.clientX; sy = e.clientY; moved = false;
  });
  box.addEventListener('pointermove', (e) => {
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (dx * dx + dy * dy > 196) moved = true;   // same slop as the board drag
  });
  box.addEventListener('click', (e) => {
    if (moved) return;
    if (!fdOnFiveDice()) return;
    if (e.target.closest && e.target.closest(IGNORE)) return;
    toggleGameChrome();
  });
})();

window.addEventListener('resize', () => window.scheduleFiveDiceFit());
window.addEventListener('orientationchange', () => window.scheduleFiveDiceFit());

window.reset5DiceGame = function(firstTurnId = null) {
  window._fd_celebrated = false; // new game → a fresh celebration is allowed
  const selectedFirstTurn = firstTurnId || window.gameHost;
  window.currentFirstTurn = selectedFirstTurn;
  window.currentTurnPlayerId = selectedFirstTurn;
  window.myTurn = (window.myPeerId === selectedFirstTurn);

  window.fiveDiceState = {
    dice: [1, 1, 1, 1, 1],
    held: [false, false, false, false, false],
    rollsLeft: 3,
    turnsLeft: 13,
    isGameOver: false,
    scores: {},
    firstTurn: selectedFirstTurn
  };

  const players = (window.gamePlayers && window.gamePlayers.length > 0) ? window.gamePlayers : [window.myPeerId];
  players.forEach(p => {
    window.fiveDiceState.scores[p] = {
      'ones': null, 'twos': null, 'threes': null, 'fours': null, 'fives': null, 'sixes': null,
      'chance': null, 'sm-straight': null, 'lg-straight': null, 'three-kind': null, 'four-kind': null,
      'five-dice': null, 'full-house': null, 'bonus-5s': null
    };
  });

  const btnPlayAgain = document.getElementById('btn-play-again');
  if (btnPlayAgain) btnPlayAgain.classList.add('hidden');
  const winsEl = document.getElementById('fd-wins');
  if (winsEl) winsEl.classList.add('hidden');

  // Clear the previous game's winner/tie background so the new game returns to
  // the normal turn-colored board.
  const gs = document.getElementById('screen-game');
  if (gs) { gs.classList.remove('tie-background'); gs.style.backgroundColor = ''; }

  const elStatus = document.getElementById('game-status');
  if (elStatus) {
    elStatus.innerText = window.myTurn ? 'Your turn!' : `${getPeerName(selectedFirstTurn)}'s turn`;
  }

  update5DiceUI();
  if (typeof window.updateGameBackground === 'function') {
    window.updateGameBackground();
  }
};

window.sync5DiceState = function(incomingState) {
  if (!incomingState || !incomingState.scores) return;
  
  const getScoreCount = (state, peerId) => {
    let count = 0;
    const pScores = state && state.scores ? state.scores[peerId] : null;
    if (pScores) {
      const turnCats = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes', 'chance', 'three-kind', 'four-kind', 'full-house', 'sm-straight', 'lg-straight', 'five-dice'];
      for (const cat of turnCats) {
        if (typeof pScores[cat] === 'number') count++;
      }
    }
    return count;
  };

  let totalCurrentScores = 0;
  let totalIncomingScores = 0;
  if (window.fiveDiceState && window.fiveDiceState.scores) {
    window.gamePlayers.forEach(p => {
      totalCurrentScores += getScoreCount(window.fiveDiceState, p);
      totalIncomingScores += getScoreCount(incomingState, p);
    });
  }

  const isIncomingComplete = incomingState.isGameOver || (window.gamePlayers.length > 0 && window.gamePlayers.every(p => getScoreCount(incomingState, p) >= 13));
  const isLocalFresh = window.fiveDiceState && !window.fiveDiceState.isGameOver && totalCurrentScores === 0;

  // Determine if incoming state should update our local state
  let shouldUpdateState = false;

  if (!window.fiveDiceState) {
    shouldUpdateState = true;
  } else if (isLocalFresh && isIncomingComplete) {
    // Ignore stale completed game snapshots arriving right after a game reset!
    shouldUpdateState = false;
  } else if (totalIncomingScores > totalCurrentScores) {
    // New score recorded! Always accept
    shouldUpdateState = true;
  } else if (totalIncomingScores === totalCurrentScores) {
    if (!window.myTurn) {
      // Not my turn: accept opponent's state updates (unless stale completed game)
      shouldUpdateState = !isIncomingComplete;
    } else {
      // My turn: local player is authoritative for active turn (rolls, held dice).
      // Do not allow Firebase state echoes to overwrite local held/dice state.
      shouldUpdateState = false;
    }
  }

  if (shouldUpdateState) {
    // Preserve accumulated Yahtzee bonuses (bonus-5s). They only ever increase and
    // are NOT reflected in the score-count used above, so an equal-count incoming
    // state that happens to lack a just-awarded bonus would otherwise silently wipe
    // it. Take the max per player so a bonus can never be reduced by a sync.
    const prevBonus = {};
    if (window.fiveDiceState && window.fiveDiceState.scores) {
      for (const p in window.fiveDiceState.scores) {
        const b = window.fiveDiceState.scores[p] && window.fiveDiceState.scores[p]['bonus-5s'];
        if (typeof b === 'number') prevBonus[p] = b;
      }
    }
    window.fiveDiceState = incomingState;
    if (window.fiveDiceState.scores) {
      for (const p in prevBonus) {
        if (!window.fiveDiceState.scores[p]) continue;
        const inc = window.fiveDiceState.scores[p]['bonus-5s'];
        window.fiveDiceState.scores[p]['bonus-5s'] = Math.max(prevBonus[p], typeof inc === 'number' ? inc : 0);
      }
    }
  }

  // Adopt the persisted turn-order anchor so a reloaded client agrees with
  // everyone else about who goes first (the local-only variable is just a
  // fallback for old game states that predate firstTurn).
  if (window.fiveDiceState && window.fiveDiceState.firstTurn) {
    window.currentFirstTurn = window.fiveDiceState.firstTurn;
  }

  // Recalculate turn order robustly
  const getCount = p => getScoreCount(window.fiveDiceState, p);
  const counts = window.gamePlayers.map(p => getCount(p));
  const minCount = counts.length > 0 ? Math.min(...counts) : 0;

  // Find turn order starting from the shared anchor
  const firstPlayer = (window.fiveDiceState && window.fiveDiceState.firstTurn) || window.currentFirstTurn || window.gameHost;
  let firstIdx = window.gamePlayers.indexOf(firstPlayer);
  if (firstIdx === -1) firstIdx = 0;
  
  const turnOrder = [];
  for (let i = 0; i < window.gamePlayers.length; i++) {
    turnOrder.push(window.gamePlayers[(firstIdx + i) % window.gamePlayers.length]);
  }
  
  // The person whose turn it is, is the first person in turnOrder who has the minCount
  let currentTurnId = turnOrder.find(p => getCount(p) === minCount) || window.gameHost;

  // No turns until the room is full and the game has started (gameStarted === false
  // only when app.js has explicitly told us the room isn't full yet).
  const notStarted = (window.gameStarted === false);
  window.myTurn = !notStarted && (window.myPeerId === currentTurnId);
  window.currentTurnPlayerId = currentTurnId;

  if (notStarted) {
    const elStatus = document.getElementById('game-status');
    if (elStatus) {
      const cnt = (window.gamePlayers || []).length;
      const maxP = window.gameMaxPlayers || cnt;
      elStatus.innerText = `Waiting for players... (${cnt}/${maxP})`;
    }
    update5DiceUI();
  } else if (window.check5DiceGameOver()) {
    window.handle5DiceGameOver();
  } else {
    const elStatus = document.getElementById('game-status');
    if (elStatus) {
      if (window.myTurn) {
        elStatus.innerText = 'Your turn!';
      } else {
        const turnName = getPeerName(currentTurnId);
        elStatus.innerText = `${turnName}'s turn`;
      }
    }
    update5DiceUI();
  }

  if (typeof window.updateGameBackground === 'function') {
    window.updateGameBackground();
  }
};

window.check5DiceGameOver = function() {
  if (!window.fiveDiceState || !window.fiveDiceState.scores) return false;
  if (window.fiveDiceState.isGameOver) return true;
  const roomPlayers = (window.gamePlayers && window.gamePlayers.length > 0) ? window.gamePlayers : Object.keys(window.fiveDiceState.scores);
  if (roomPlayers.length === 0) return false;
  const requiredCats = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes', 'chance', 'sm-straight', 'lg-straight', 'three-kind', 'four-kind', 'five-dice', 'full-house'];
  for (const p of roomPlayers) {
    const pScores = window.fiveDiceState.scores[p];
    if (!pScores) return false;
    for (const cat of requiredCats) {
      if (typeof pScores[cat] !== 'number') return false;
    }
  }
  return true;
};

// Winner(s) of the current game = highest grand total (ties return >1).
function compute5DiceWinners() {
  const state = window.fiveDiceState;
  const players = (window.gamePlayers && window.gamePlayers.length > 0) ? window.gamePlayers : Object.keys(state.scores || {});
  let maxScore = -1, winners = [];
  players.forEach(p => {
    const total = fdGrand(state, p);
    if (total > maxScore) { maxScore = total; winners = [p]; }
    else if (total === maxScore) winners.push(p);
  });
  return winners;
}

// Render the persistent per-room win tally at the bottom of the screen.
window.renderWinsTally = function() {
  const el = document.getElementById('fd-wins');
  if (!el) return;
  const wins = window.roomWins || {};
  const ties = window.roomTies || {};
  let players = (window.gamePlayers && window.gamePlayers.length > 0) ? window.gamePlayers.slice() : Object.keys(wins);

  const vsComputer = typeof window.isVsComputerGame === 'function' && window.isVsComputerGame();
  if (vsComputer) {
    // Vs-computer games (tic-tac-toe, backgammon): the computer is a tally column.
    if (window.AI_PLAYER_ID && !players.includes(window.AI_PLAYER_ID)) players.push(window.AI_PLAYER_ID);
  } else if (window.gameMaxPlayers === 1) {
    // Solo 5 Dice: there's no opponent, so a running win tally is meaningless.
    el.classList.add('hidden');
    return;
  }

  if (players.length === 0) { el.classList.add('hidden'); return; }
  players.sort((a, b) => ((wins[b] || 0) - (wins[a] || 0)) || ((ties[b] || 0) - (ties[a] || 0)));

  let html = `<div class="fd-wins-title">Room record</div>`;

  // A backgammon game always produces a winner — someone bears off all fifteen
  // checkers, or a double is dropped. There is no draw in the rules, so a Ties
  // row there is a permanent zero taking up space.
  const canTie = (typeof window.getCurrentGameType !== 'function') ||
    window.getCurrentGameType() !== 'Backgammon';

  if (players.length <= 2) {
    // 2 players (or solo): a tie is shared by everyone, so listing it on each
    // player just duplicates the same number. Show a single wins column plus one
    // "Ties" row instead.
    html += players.map(p =>
      `<div class="fd-win-row"><span class="fd-win-dot" style="background:${getPeerColor(p)}"></span>`
      + `<span class="fd-win-name">${fdEsc(getPeerName(p))}</span>`
      + `<span class="fd-win-count">${wins[p] || 0}</span></div>`
    ).join('');
    if (canTie) {
      const tieCount = Math.max(0, ...players.map(p => ties[p] || 0));
      html += `<div class="fd-win-row fd-win-tie"><span class="fd-win-dot" style="visibility:hidden"></span>`
        + `<span class="fd-win-name">Ties</span>`
        + `<span class="fd-win-count">${tieCount}</span></div>`;
    }
  } else {
    // 3+ players: a tie can be between only some players, so keep the per-player
    // Win / Tie columns.
    html += `<div class="fd-win-row fd-win-head"><span class="fd-win-dot" style="visibility:hidden"></span>`
      + `<span class="fd-win-name"></span><span class="fd-win-count">W</span><span class="fd-win-count">T</span></div>`;
    html += players.map(p =>
      `<div class="fd-win-row"><span class="fd-win-dot" style="background:${getPeerColor(p)}"></span>`
      + `<span class="fd-win-name">${fdEsc(getPeerName(p))}</span>`
      + `<span class="fd-win-count">${wins[p] || 0}</span>`
      + `<span class="fd-win-count">${ties[p] || 0}</span></div>`
    ).join('');
  }

  el.innerHTML = html;
  el.classList.remove('hidden');
};

// Paint the game screen in the winner's color at game over (a tie uses two-color
// stripes, mirroring the tic-tac-toe tie background).
window.apply5DiceWinnerBackground = function() {
  const gameScreen = document.getElementById('screen-game');
  if (!gameScreen || !window.fiveDiceState || !window.fiveDiceState.isGameOver) return;
  const winners = compute5DiceWinners();
  if (winners.length === 1) {
    gameScreen.classList.remove('tie-background');
    gameScreen.style.backgroundColor = getPeerColor(winners[0]);
  } else if (winners.length > 1) {
    gameScreen.style.setProperty('--color-1', getPeerColor(winners[0]));
    gameScreen.style.setProperty('--color-2', getPeerColor(winners[1] || winners[0]));
    gameScreen.style.backgroundColor = '';
    gameScreen.classList.add('tie-background');
  }
};

window.handle5DiceGameOver = function() {
  window.fiveDiceState.isGameOver = true;
  update5DiceUI();
  const winners = compute5DiceWinners();
  window.apply5DiceWinnerBackground();

  const elStatus = document.getElementById('game-status');

  // handle5DiceGameOver re-runs on every later state echo (win-tally writes,
  // lastUpdated bumps); celebrate only once per game.
  const firstCelebration = !window._fd_celebrated;
  window._fd_celebrated = true;

  // Solo game: no opponents to beat, just the final score (with confetti).
  if ((window.gamePlayers || []).length <= 1) {
    const finalScore = fdGrand(window.fiveDiceState, window.myPeerId);
    if (elStatus) elStatus.innerText = `Game Over! You scored ${finalScore}.`;
    if (firstCelebration) {
      const gcSolo = document.querySelector('.game-container');
      if (gcSolo) gcSolo.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(() => {
        if (window.confetti) {
          const config = { spread: 100, startVelocity: 50, scalar: 1.2 };
          window.confetti({ ...config, particleCount: 150, origin: { x: 0.2, y: 0.8 } });
          window.confetti({ ...config, particleCount: 150, origin: { x: 0.8, y: 0.8 } });
        }
      }, 300);
    }
    const btnAgainSolo = document.getElementById('btn-play-again');
    if (btnAgainSolo) btnAgainSolo.classList.remove('hidden');
    window.renderWinsTally();
    return;
  }

  if (winners.includes(window.myPeerId)) {
    if (winners.length > 1) {
      if (elStatus) elStatus.innerText = "It's a Tie!";
    } else {
      if (elStatus) elStatus.innerText = "You Win!";

      const gc = document.querySelector('.game-container');
      if (gc) gc.scrollTo({ top: 0, behavior: 'smooth' });

      if (firstCelebration) setTimeout(() => {
        if (window.confetti) {
          const config = { spread: 100, startVelocity: 50, scalar: 1.2 };
          window.confetti({ ...config, particleCount: 150, origin: { x: 0.2, y: 0.8 } });
          window.confetti({ ...config, particleCount: 150, origin: { x: 0.8, y: 0.8 } });
          setTimeout(() => window.confetti({ ...config, particleCount: 200, origin: { x: 0.5, y: 0.6 } }), 300);
        }
      }, 300); // Give it a tiny bit of time to scroll before confetti fires
    }
  } else {
    const gc = document.querySelector('.game-container');
    if (gc) gc.scrollTo({ top: 0, behavior: 'smooth' });
    const winnerName = getPeerName(winners[0]);
    if (elStatus) elStatus.innerText = `${winnerName} Wins!`;
  }
  const btnPlayAgain = document.getElementById('btn-play-again');
  if (btnPlayAgain) btnPlayAgain.classList.remove('hidden');
  window.renderWinsTally();
};
