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
  window.fiveDiceState = {
    dice: [1, 1, 1, 1, 1],
    held: [false, false, false, false, false],
    rollsLeft: 3,
    scores: {},
    turnsLeft: 13
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
  
  document.querySelectorAll('.fd-cat').forEach(catEl => {
    const cat = catEl.getAttribute('data-category');
    const scoreEl = catEl.querySelector('.fd-cat-score');
    if (myScores[cat] !== null && myScores[cat] !== undefined) {
      scoreEl.innerText = myScores[cat];
      if (['ones','twos','threes','fours','fives','sixes'].includes(cat)) {
        upperTotal += myScores[cat];
      } else {
        lowerTotal += myScores[cat];
      }
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

// Bind roll click
document.getElementById('fd-roll-btn').addEventListener('click', (e) => {
  if (!window.myTurn) return;
  if (window.fiveDiceState.rollsLeft <= 0) return;
  
  const btn = e.currentTarget;
  if (btn.classList.contains('is-rolling')) return;
  btn.classList.add('is-rolling');
  
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
  } else {
    btn.classList.remove('is-rolling');
    update5DiceUI();
  }
});

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
    
    const score = calculate5DiceScore(cat, window.fiveDiceState.dice);
    
    // Show commit dialog. Remove any existing overlay first so we never have two
    // overlays sharing the same element IDs (which wired handlers to the wrong
    // buttons and could commit the wrong category).
    document.querySelectorAll('.fd-commit-overlay').forEach(el => el.remove());

    const commitDiv = document.createElement('div');
    commitDiv.className = 'fd-commit-overlay';
    commitDiv.innerHTML = `
      <div>Score ${score} in ${cat}?</div>
      <div class="fd-commit-buttons">
        <button id="btn-fd-commit">Commit</button>
        <button id="btn-fd-undo">Undo</button>
      </div>
    `;
    document.getElementById('five-dice-container').appendChild(commitDiv);

    // Bind against THIS overlay's buttons (not getElementById, which returns the
    // first match in the document).
    commitDiv.querySelector('#btn-fd-undo').onclick = () => {
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

function calculate5DiceScore(category, dice) {
  const counts = {1:0, 2:0, 3:0, 4:0, 5:0, 6:0};
  let sum = 0;
  dice.forEach(d => { counts[d]++; sum += d; });
  
  const hasN = (n) => Object.values(counts).some(c => c >= n);
  
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
    case 'full-house': return (Object.values(counts).includes(3) && Object.values(counts).includes(2)) || hasN(5) ? 25 : 0;
    case 'sm-straight': 
      if (counts[1] && counts[2] && counts[3] && counts[4]) return 30;
      if (counts[2] && counts[3] && counts[4] && counts[5]) return 30;
      if (counts[3] && counts[4] && counts[5] && counts[6]) return 30;
      return 0;
    case 'lg-straight':
      if (counts[1] && counts[2] && counts[3] && counts[4] && counts[5]) return 40;
      if (counts[2] && counts[3] && counts[4] && counts[5] && counts[6]) return 40;
      return 0;
    case 'five-dice': return hasN(5) ? 50 : 0;
    case 'bonus-5s': return 0; // Simplified for now
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
};

window.reset5DiceGame = function(firstTurnId = null) {
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
    scores: {}
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
    window.fiveDiceState = incomingState;
  }

  // Recalculate turn order robustly
  const getCount = p => getScoreCount(window.fiveDiceState, p);
  const counts = window.gamePlayers.map(p => getCount(p));
  const minCount = counts.length > 0 ? Math.min(...counts) : 0;
  
  // Find turn order starting from currentFirstTurn
  const firstPlayer = window.currentFirstTurn || window.gameHost;
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

window.handle5DiceGameOver = function() {
  window.fiveDiceState.isGameOver = true;
  update5DiceUI();
  const players = (window.gamePlayers && window.gamePlayers.length > 0) ? window.gamePlayers : Object.keys(window.fiveDiceState.scores);
  let maxScore = -1;
  let winners = [];
  players.forEach(p => {
    let total = 0;
    const pScores = window.fiveDiceState.scores[p] || {};
    let upper = 0;
    ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'].forEach(c => upper += pScores[c] || 0);
    if (upper >= 63) total += 35;
    total += upper;
    ['chance', 'sm-straight', 'lg-straight', 'three-kind', 'four-kind', 'five-dice', 'full-house', 'bonus-5s'].forEach(c => total += pScores[c] || 0);
    if (total > maxScore) {
      maxScore = total;
      winners = [p];
    } else if (total === maxScore) {
      winners.push(p);
    }
  });
  
  const elStatus = document.getElementById('game-status');
  if (winners.includes(window.myPeerId)) {
    if (winners.length > 1) {
      if (elStatus) elStatus.innerText = "It's a Tie!";
    } else {
      if (elStatus) elStatus.innerText = "You Win!";
      
      const gc = document.querySelector('.game-container');
      if (gc) gc.scrollTo({ top: 0, behavior: 'smooth' });
      
      setTimeout(() => {
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
};
