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
  
  // Render dice
  for (let i = 0; i < 5; i++) {
    const dieEl = document.querySelector(`.fd-die[data-index="${i}"]`);
    if (dieEl) {
      dieEl.classList.remove('die-1', 'die-2', 'die-3', 'die-4', 'die-5', 'die-6');
      dieEl.classList.add(`die-${state.dice[i]}`);
      dieEl.classList.toggle('held', state.held[i]);
    }
  }
  
  // Render rolls left
  document.getElementById('fd-rolls-left').innerText = state.rollsLeft;
  document.getElementById('fd-turns-count').innerText = state.turnsLeft;
  
  // Render scores for myself for now
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
  document.getElementById('fd-total-par').innerText = upperTotal;
  let bonus = upperTotal >= 63 ? 35 : 0;
  document.getElementById('fd-bonus').innerText = bonus;
  
  document.getElementById('fd-lower-total').innerText = lowerTotal;
  document.getElementById('fd-grand-total').innerText = upperTotal + bonus + lowerTotal;
}

// Bind dice click
document.querySelectorAll('.fd-die').forEach(die => {
  die.addEventListener('click', (e) => {
    if (!window.myTurn) return; // Only hold on your turn
    const idx = parseInt(e.target.getAttribute('data-index'));
    if (window.fiveDiceState.rollsLeft < 3) {
      window.fiveDiceState.held[idx] = !window.fiveDiceState.held[idx];
      update5DiceUI();
      broadcast5DiceState();
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
  
  let animationFrames = 0;
  const maxFrames = 10;
  
  const interval = setInterval(() => {
    for (let i = 0; i < 5; i++) {
      if (!window.fiveDiceState.held[i]) {
        window.fiveDiceState.dice[i] = Math.floor(Math.random() * 6) + 1;
        const dieEl = document.querySelector(`.fd-die[data-index="${i}"]`);
        if (dieEl) dieEl.classList.add('wobble'); // Add CSS class for shaking
      }
    }
    update5DiceUI();
    
    animationFrames++;
    if (animationFrames >= maxFrames) {
      clearInterval(interval);
      // Final roll
      for (let i = 0; i < 5; i++) {
        if (!window.fiveDiceState.held[i]) {
          window.fiveDiceState.dice[i] = Math.floor(Math.random() * 6) + 1;
        }
        const dieEl = document.querySelector(`.fd-die[data-index="${i}"]`);
        if (dieEl) dieEl.classList.remove('wobble');
      }
      window.fiveDiceState.rollsLeft--;
      update5DiceUI();
      broadcast5DiceState();
      btn.classList.remove('is-rolling');
    }
  }, 50);
});

// Bind category click (Scoring)
document.querySelectorAll('.fd-cat').forEach(catEl => {
  catEl.addEventListener('click', () => {
    if (!window.myTurn) return;
    if (window.fiveDiceState.rollsLeft === 3) return; // Must roll at least once
    
    const cat = catEl.getAttribute('data-category');
    if (window.fiveDiceState.scores[window.myPeerId][cat] !== null) return; // Already scored
    
    const score = calculateYahtzeeScore(cat, window.fiveDiceState.dice);
    
    // Show commit dialog
    const commitDiv = document.createElement('div');
    commitDiv.className = 'fd-commit-overlay';
    commitDiv.innerHTML = `
      <div>Score ${score} in ${cat}?</div>
      <button id="btn-fd-undo">Undo</button>
      <button id="btn-fd-commit">Commit</button>
    `;
    document.getElementById('five-dice-board').appendChild(commitDiv);
    
    document.getElementById('btn-fd-undo').onclick = () => {
      commitDiv.remove();
    };
    
    document.getElementById('btn-fd-commit').onclick = () => {
      window.fiveDiceState.scores[window.myPeerId][cat] = score;
      commitDiv.remove();
      
      // Reset for next player
      window.fiveDiceState.rollsLeft = 3;
      window.fiveDiceState.held = [false, false, false, false, false];
      window.fiveDiceState.dice = [1, 1, 1, 1, 1]; // Reset visually
      
      window.fiveDiceState.turnsLeft--; 
      
      update5DiceUI();
      
      // Pass turn
      window.myTurn = false;
      document.getElementById('game-status').innerText = 'Opponent\'s turn...';
      
      broadcast5DiceScore(cat, score);
    };
  });
});

function calculateYahtzeeScore(category, dice) {
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
    case 'full-house': return (hasN(3) && hasN(2)) || hasN(5) ? 25 : 0;
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
    window.fiveDiceState.dice = msg.dice;
    window.fiveDiceState.held = msg.held;
    window.fiveDiceState.rollsLeft = msg.rollsLeft;
    update5DiceUI();
  } else if (msg.type === '5DICE_SCORE') {
    if (!window.fiveDiceState.scores[msg.player]) {
       window.fiveDiceState.scores[msg.player] = {};
    }
    window.fiveDiceState.scores[msg.player][msg.category] = msg.score;
    // When opponent scores, it's my turn
    window.myTurn = true;
    window.fiveDiceState.rollsLeft = 3;
    window.fiveDiceState.held = [false, false, false, false, false];
    window.fiveDiceState.dice = [1,1,1,1,1];
    document.getElementById('game-status').innerText = 'Your turn!';
    update5DiceUI();
  }
};
