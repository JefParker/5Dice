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
  const state = window.fiveDiceState;
  
  if (window.myTurn && !window.fiveDiceState.isGameOver) {
    document.getElementById('fd-board').classList.remove('hidden');
    document.getElementById('fd-scorecard').classList.add('hidden');
    document.getElementById('fd-roll-btn').style.opacity = '1';
    document.getElementById('fd-roll-btn').style.pointerEvents = 'auto';
  } else {
    document.getElementById('fd-board').classList.add('hidden');
    document.getElementById('fd-scorecard').classList.remove('hidden');
    document.getElementById('fd-roll-btn').style.opacity = '0.3';
    document.getElementById('fd-roll-btn').style.pointerEvents = 'none';
    renderScorecard();
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
  document.getElementById('fd-turns-count').innerText = state.turnsLeft;

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
  
  // Par calculation: each upper category should average 3 * the face value.
  let par = 0;
  if (myScores['ones'] !== null) par += (myScores['ones'] - 3);
  if (myScores['twos'] !== null) par += (myScores['twos'] - 6);
  if (myScores['threes'] !== null) par += (myScores['threes'] - 9);
  if (myScores['fours'] !== null) par += (myScores['fours'] - 12);
  if (myScores['fives'] !== null) par += (myScores['fives'] - 15);
  if (myScores['sixes'] !== null) par += (myScores['sixes'] - 18);
  
  const parText = par === 0 ? ' (on par)' : (par > 0 ? ` (+${par})` : ` (${par})`);
  document.getElementById('fd-total-par').innerText = `${upperTotal}${parText}`;
  
  // Final total UI
  const total = upperTotal + lowerTotal + bonus;
  document.getElementById('fd-grand-total').innerText = total;
}

function renderScorecard() {
  const state = window.fiveDiceState;
  let players = Object.keys(state.scores);
  
  if (state.isGameOver) {
    players.sort((a, b) => {
      const getGrandTotal = (p) => {
        let u = ['ones','twos','threes','fours','fives','sixes'].reduce((sum, k) => sum + (state.scores[p][k] || 0), 0);
        let l = ['chance','three-kind','four-kind','full-house','sm-straight','lg-straight','five-dice','bonus-5s'].reduce((sum, k) => sum + (state.scores[p][k] || 0), 0);
        let bonus = u >= 63 ? 35 : 0;
        return u + l + bonus;
      };
      return getGrandTotal(b) - getGrandTotal(a);
    });
  }
  
  const cats = [
    { id: 'ones', label: "1's" },
    { id: 'twos', label: "2's" },
    { id: 'threes', label: "3's" },
    { id: 'fours', label: "4's" },
    { id: 'fives', label: "5's" },
    { id: 'sixes', label: "6's" },
    { id: 'bonus', label: "Bonus (> 62)" },
    { id: 'chance', label: "Chance" },
    { id: 'three-kind', label: "3 of a kind" },
    { id: 'four-kind', label: "4 of a kind" },
    { id: 'full-house', label: "Full House" },
    { id: 'sm-straight', label: "Sm Strt" },
    { id: 'lg-straight', label: "Lg Strt" },
    { id: 'five-dice', label: "5 Dice" },
    { id: 'bonus-5s', label: "Bonus 5s" }
  ];
  
  let html = `<div class="fd-sc-row fd-sc-header"><div class="fd-sc-cat">Categories</div>`;
  players.forEach(p => {
    let pName = p === window.myPeerId ? window.myName : (window.lobbyPeers[p] ? window.lobbyPeers[p].name : 'P');
    let pColor = p === window.myPeerId ? window.myColor : (window.lobbyPeers[p] ? window.lobbyPeers[p].color : '#333');
    html += `<div class="fd-sc-score" style="background-color: ${pColor};">${pName}</div>`;
  });
  html += `</div>`;
  
  cats.forEach(c => {
    html += `<div class="fd-sc-row ${c.id === 'chance' ? 'fd-sc-totals' : ''}"><div class="fd-sc-cat">${c.label}</div>`;
    players.forEach(p => {
      let score = state.scores[p][c.id];
      if (c.id === 'bonus') {
        const u = ['ones','twos','threes','fours','fives','sixes'].reduce((sum, k) => sum + (state.scores[p][k] || 0), 0);
        score = u >= 63 ? 35 : 0;
      }
      let val = (score === null || score === undefined) ? '-' : score;
      let pColor = p === window.myPeerId ? window.myColor : (window.lobbyPeers[p] ? window.lobbyPeers[p].color : '#333');
      html += `<div class="fd-sc-score" style="background-color: ${pColor};">${val}</div>`;
    });
    html += `</div>`;
  });
  
  html += `<div class="fd-sc-row fd-sc-totals"><div class="fd-sc-cat">Upper Tot</div>`;
  players.forEach(p => {
    const u = ['ones','twos','threes','fours','fives','sixes'].reduce((sum, k) => sum + (state.scores[p][k] || 0), 0);
    let pColor = p === window.myPeerId ? window.myColor : (window.lobbyPeers[p] ? window.lobbyPeers[p].color : '#333');
    html += `<div class="fd-sc-score" style="background-color: ${pColor};">${u}</div>`;
  });
  html += `</div>`;
  
  html += `<div class="fd-sc-row"><div class="fd-sc-cat">Lower Tot</div>`;
  players.forEach(p => {
    const l = ['chance','three-kind','four-kind','full-house','sm-straight','lg-straight','five-dice','bonus-5s'].reduce((sum, k) => sum + (state.scores[p][k] || 0), 0);
    let pColor = p === window.myPeerId ? window.myColor : (window.lobbyPeers[p] ? window.lobbyPeers[p].color : '#333');
    html += `<div class="fd-sc-score" style="background-color: ${pColor};">${l}</div>`;
  });
  html += `</div>`;
  
  html += `<div class="fd-sc-row fd-sc-totals"><div class="fd-sc-cat">Total</div>`;
  players.forEach(p => {
    const u = ['ones','twos','threes','fours','fives','sixes'].reduce((sum, k) => sum + (state.scores[p][k] || 0), 0);
    const l = ['chance','three-kind','four-kind','full-house','sm-straight','lg-straight','five-dice','bonus-5s'].reduce((sum, k) => sum + (state.scores[p][k] || 0), 0);
    const bonus = u >= 63 ? 35 : 0;
    let pColor = p === window.myPeerId ? window.myColor : (window.lobbyPeers[p] ? window.lobbyPeers[p].color : '#333');
    html += `<div class="fd-sc-score" style="background-color: ${pColor};">${u + l + bonus}</div>`;
  });
  html += `</div>`;
  
  document.getElementById('fd-scorecard').innerHTML = html;
}

// Bind dice click
document.querySelectorAll('.fd-die').forEach(die => {
  die.addEventListener('click', (e) => {
    if (!window.myTurn) return; // Only hold on your turn
    const idx = parseInt(e.target.getAttribute('data-index'));
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
    if (window.fiveDiceState.rollsLeft === 3) return; // Must roll at least once
    
    const cat = catEl.getAttribute('data-category');
    if (cat === 'bonus-5s') return; // Not a direct user input
    if (window.fiveDiceState.scores[window.myPeerId][cat] !== null) return; // Already scored
    
    const score = calculate5DiceScore(cat, window.fiveDiceState.dice);
    
    // Show commit dialog
    const commitDiv = document.createElement('div');
    commitDiv.className = 'fd-commit-overlay';
    commitDiv.innerHTML = `
      <div>Score ${score} in ${cat}?</div>
      <button id="btn-fd-commit">Commit</button>
      <button id="btn-fd-undo">Undo</button>
    `;
    document.getElementById('five-dice-container').appendChild(commitDiv);
    
    document.getElementById('btn-fd-undo').onclick = () => {
      commitDiv.remove();
    };
    
    document.getElementById('btn-fd-commit').onclick = () => {
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
      
      broadcast5DiceScore(cat, score);

      window.fiveDiceState.rollsLeft = 3;
      window.fiveDiceState.held = [false, false, false, false, false];
      window.fiveDiceState.dice = [1, 1, 1, 1, 1];
      window.fiveDiceState.turnsLeft--; 
      
      if (check5DiceGameOver()) {
        handle5DiceGameOver();
      } else {
        window.myTurn = false;
        document.getElementById('game-status').innerText = `${window.getOpponentName()}'s turn...`;
        if (window.updateGameBackground) window.updateGameBackground();
        update5DiceUI();
      }
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
  if (!window.gamePeers) return;
  const msg = {
    type: '5DICE_ROLL',
    dice: window.fiveDiceState.dice,
    held: window.fiveDiceState.held,
    rollsLeft: window.fiveDiceState.rollsLeft
  };
  for (const peerId in window.gamePeers) {
    const p = window.gamePeers[peerId];
    if (p.dc && p.dc.readyState === 'open') {
      p.dc.send(JSON.stringify(msg));
    }
  }
}

function broadcast5DiceHold() {
  if (!window.gamePeers) return;
  const msg = {
    type: '5DICE_HOLD',
    held: window.fiveDiceState.held
  };
  for (const peerId in window.gamePeers) {
    const p = window.gamePeers[peerId];
    if (p.dc && p.dc.readyState === 'open') {
      p.dc.send(JSON.stringify(msg));
    }
  }
}

function broadcast5DiceScore(category, score) {
  if (!window.gamePeers) return;
  const msg = {
    type: '5DICE_SCORE',
    category: category,
    score: score,
    player: window.myPeerId
  };
  for (const peerId in window.gamePeers) {
    const p = window.gamePeers[peerId];
    if (p.dc && p.dc.readyState === 'open') {
      p.dc.send(JSON.stringify(msg));
    }
  }
}

window.handle5DiceMessage = function(msg) {
  if (msg.type === '5DICE_ROLL') {
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
    
    update5DiceUI();
    
    if (check5DiceGameOver()) {
      handle5DiceGameOver();
    } else {
      window.myTurn = true;
      window.fiveDiceState.rollsLeft = 3;
      window.fiveDiceState.held = [false, false, false, false, false];
      window.fiveDiceState.dice = [1,1,1,1,1];
      document.getElementById('game-status').innerText = 'Your turn!';
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
  window.fiveDiceState = {
    dice: [1, 1, 1, 1, 1],
    held: [false, false, false, false, false],
    rollsLeft: 3,
    turnsLeft: 13,
    scores: {}
  };
  window.gamePlayers.forEach(p => {
    window.fiveDiceState.scores[p] = {
      'ones': null, 'twos': null, 'threes': null, 'fours': null, 'fives': null, 'sixes': null,
      'chance': null, 'sm-straight': null, 'lg-straight': null, 'three-kind': null, 'four-kind': null,
      'five-dice': null, 'full-house': null, 'bonus-5s': null
    };
  });
  if (firstTurnId) {
    window.myTurn = (window.myPeerId === firstTurnId);
  } else {
    window.myTurn = window.currentFirstTurn ? (window.myPeerId === window.currentFirstTurn) : (window.myPeerId === window.gameHost);
  }
  document.getElementById('btn-play-again').classList.add('hidden');
  update5DiceUI();
};

window.sync5DiceState = function(incomingState) {
  if (!incomingState || !incomingState.scores) return;
  
  const getScoreCount = (state, peerId) => {
    let count = 0;
    const pScores = state.scores[peerId];
    if (pScores) {
      for (const cat in pScores) {
        if (pScores[cat] !== null) count++;
      }
    }
    return count;
  };
  
  const opponentId = window.gamePlayers.find(p => p !== window.myPeerId);
  if (!opponentId) return;

  let shouldUpdate = false;

  if (!window.fiveDiceState) {
    shouldUpdate = true;
  } else {
    const myCountCurrent = getScoreCount(window.fiveDiceState, window.myPeerId);
    const myCountIncoming = getScoreCount(incomingState, window.myPeerId);
    const oppCountCurrent = getScoreCount(window.fiveDiceState, opponentId);
    const oppCountIncoming = getScoreCount(incomingState, opponentId);

    const totalCurrent = myCountCurrent + oppCountCurrent;
    const totalIncoming = myCountIncoming + oppCountIncoming;

    // Always accept a state that has more recorded scores than ours
    if (totalIncoming > totalCurrent) {
      shouldUpdate = true;
    } else if (totalIncoming === totalCurrent) {
      // If the scores are identical, accept the state if its rolls are further along
      if (incomingState.turnsLeft < window.fiveDiceState.turnsLeft) {
        shouldUpdate = true;
      } else if (incomingState.turnsLeft === window.fiveDiceState.turnsLeft) {
        if (incomingState.rollsLeft < window.fiveDiceState.rollsLeft) {
          shouldUpdate = true;
        }
      }
    }
  }


  if (shouldUpdate) {
    window.fiveDiceState = incomingState;
  }

  // Recalculate myTurn robustly regardless of whether we updated (to ensure both clients agree)
  const myCountFinal = getScoreCount(window.fiveDiceState, window.myPeerId);
  const oppCountFinal = getScoreCount(window.fiveDiceState, opponentId);
  
  const firstPlayer = window.firstTurnPlayerId || window.gameHost;
  
  if (myCountFinal < oppCountFinal) {
    window.myTurn = true;
  } else if (oppCountFinal < myCountFinal) {
    window.myTurn = false;
  } else {
    // Both have the same number of scores, meaning the round is even. It's the first player's turn again.
    window.myTurn = (window.myPeerId === firstPlayer);
  }

  if (window.check5DiceGameOver()) {
    window.handle5DiceGameOver();
  } else {
    const elStatus = document.getElementById('game-status');
    if (elStatus) {
      elStatus.innerText = window.myTurn ? 'Your turn!' : `${window.getOpponentName()}'s turn`;
    }
    update5DiceUI();
  }
};

window.check5DiceGameOver = function() {
  if (!window.fiveDiceState || !window.fiveDiceState.scores) return false;
  const players = Object.keys(window.fiveDiceState.scores);
  if (players.length === 0) return false;
  const requiredCats = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes', 'chance', 'sm-straight', 'lg-straight', 'three-kind', 'four-kind', 'five-dice', 'full-house'];
  for (const p of players) {
    const pScores = window.fiveDiceState.scores[p];
    if (!pScores) return false;
    for (const cat of requiredCats) {
      if (pScores[cat] === null) return false;
    }
  }
  return true;
};

window.handle5DiceGameOver = function() {
  window.fiveDiceState.isGameOver = true;
  update5DiceUI();
  const players = Object.keys(window.fiveDiceState.scores);
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
  
  if (winners.includes(window.myPeerId)) {
    if (winners.length > 1) {
      document.getElementById('game-status').innerText = "It's a Tie!";
    } else {
      document.getElementById('game-status').innerText = "You Win!";
      if (window.confetti) window.confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
    }
  } else {
    document.getElementById('game-status').innerText = `${window.lobbyPeers[winners[0]]?.name || 'Opponent'} Wins!`;
  }
  document.getElementById('btn-play-again').classList.remove('hidden');
};
