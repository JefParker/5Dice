// backgammon.js
// Backgammon rules engine + computer opponent. Pure logic, no DOM: the same
// file runs in the browser (window.BG) and under Node for the test suite.
//
// Board model:
//   points[0..23]  — point N (white's numbering) is index N-1.
//                    value > 0: that many WHITE checkers; < 0: BLACK checkers.
//   White home = indices 0-5, white moves DOWN (24 -> 1), bears off past 1.
//   Black home = indices 18-23, black moves UP (1 -> 24), bears off past 24.
//   barW/barB  — checkers on the bar; offW/offB — borne off.
//
// Moves are {from, to, die, hit} where from/to are 0-23, 'bar', or 'off'.
//
// The engine enforces the forced-move rules: a turn must play as many dice as
// possible, and when only one die can be played it must be the larger when
// either (alone) is playable. legalMoves() only ever returns first steps that
// keep a maximal sequence reachable, so the UI can simply offer what it says.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 'w', B = 'b';
  const opp = c => (c === W ? B : W);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  function initialPoints() {
    const p = new Array(24).fill(0);
    // White: 24-point x2, 13-point x5, 8-point x3, 6-point x5
    p[23] = 2; p[12] = 5; p[7] = 3; p[5] = 5;
    // Black mirrors: 1-point x2, 12-point x5, 17-point x3, 19-point x5
    p[0] = -2; p[11] = -5; p[16] = -3; p[18] = -5;
    return p;
  }

  // matchTarget 1 = independent single games (room-record style);
  // 3/5/7 = match play with gammons/backgammons and the Crawford rule.
  function initialState(matchTarget) {
    return {
      points: initialPoints(),
      barW: 0, barB: 0, offW: 0, offB: 0,
      turn: null,
      phase: 'opening',            // opening | rolling | moving | cube-offered | over
      dice: null,                  // the rolled pair [d1, d2]
      movesLeft: [],               // die values still to be played this turn
      turnMoves: [],               // moves made this turn (for undo)
      cube: { value: 1, owner: null, offeredBy: null },
      opening: { w: null, b: null },
      winner: null, winKind: null, // single | gammon | backgammon
      gamePoints: 0,               // points the winner earned for THIS game
      match: {
        target: matchTarget || 1,
        scoreW: 0, scoreB: 0,
        crawford: false,           // THIS game is the Crawford game
        crawfordDone: false,
        winner: null
      }
    };
  }

  // Start the next game of a match, carrying scores + Crawford bookkeeping.
  function nextGame(state) {
    const s = initialState(state.match.target);
    s.match = {
      target: state.match.target,
      scoreW: state.match.scoreW,
      scoreB: state.match.scoreB,
      crawford: false,
      crawfordDone: state.match.crawfordDone,
      winner: state.match.winner
    };
    // Crawford rule: the first game where a player reaches target-1 is played
    // without the cube; afterwards doubling resumes.
    const t = s.match.target;
    if (t > 1 && !s.match.crawfordDone &&
        (s.match.scoreW === t - 1 || s.match.scoreB === t - 1)) {
      s.match.crawford = true;
      s.match.crawfordDone = true;
    }
    return s;
  }

  function clone(state) { return JSON.parse(JSON.stringify(state)); }

  // ---------------------------------------------------------------------------
  // Opening roll: each side rolls one die; higher plays first with both dice.
  // ---------------------------------------------------------------------------

  function applyOpeningRoll(state, dW, dB) {
    const s = clone(state);
    s.opening = { w: dW, b: dB };
    if (dW === dB) return s; // tie: caller rerolls (opening values kept to show)
    s.turn = dW > dB ? W : B;
    s.dice = [dW, dB];
    s.movesLeft = [dW, dB];
    s.turnMoves = [];
    s.phase = 'moving';
    return s;
  }

  function rollDice(state, d1, d2) {
    const s = clone(state);
    s.dice = [d1, d2];
    s.movesLeft = d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
    s.turnMoves = [];
    s.phase = 'moving';
    return s;
  }

  // ---------------------------------------------------------------------------
  // Move legality
  // ---------------------------------------------------------------------------

  function ptOwner(v) { return v > 0 ? W : v < 0 ? B : null; }
  function myCount(state, idx, c) {
    const v = state.points[idx];
    return c === W ? Math.max(0, v) : Math.max(0, -v);
  }
  function isBlocked(state, idx, c) {
    const v = state.points[idx];
    return c === W ? v <= -2 : v >= 2;
  }
  function bar(state, c) { return c === W ? state.barW : state.barB; }

  function allInHome(state, c) {
    if (bar(state, c) > 0) return false;
    if (c === W) {
      for (let i = 6; i < 24; i++) if (state.points[i] > 0) return false;
    } else {
      for (let i = 0; i < 18; i++) if (state.points[i] < 0) return false;
    }
    return true;
  }

  // All single moves color c could make with `die` in `state` (no maximality —
  // that's layered on by legalMoves()).
  function singleMoves(state, c, die) {
    const moves = [];
    if (bar(state, c) > 0) {
      // Must enter from the bar and nothing else.
      const idx = c === W ? 24 - die : die - 1;
      if (!isBlocked(state, idx, c)) {
        moves.push({ from: 'bar', to: idx, die, hit: myCount(state, idx, opp(c)) === 1 });
      }
      return moves;
    }
    const home = allInHome(state, c);
    for (let i = 0; i < 24; i++) {
      if (myCount(state, i, c) === 0) continue;
      const target = c === W ? i - die : i + die;
      if (target >= 0 && target < 24) {
        if (!isBlocked(state, target, c)) {
          moves.push({ from: i, to: target, die, hit: myCount(state, target, opp(c)) === 1 });
        }
      } else if (home) {
        // Bear-off. Distance to off: white idx i -> i+1 pips; black -> 24-i.
        const dist = c === W ? i + 1 : 24 - i;
        if (die === dist) {
          moves.push({ from: i, to: 'off', die, hit: false });
        } else if (die > dist) {
          // Allowed only when no checker sits farther from the edge.
          let farther = false;
          if (c === W) { for (let j = i + 1; j < 6; j++) if (state.points[j] > 0) farther = true; }
          else { for (let j = 17; j < i; j++) if (state.points[j] < 0) farther = true; }
          if (!farther) moves.push({ from: i, to: 'off', die, hit: false });
        }
      }
    }
    return moves;
  }

  // Apply a single move without turn bookkeeping (used by the search).
  function applyRaw(state, c, m) {
    if (m.from === 'bar') {
      if (c === W) state.barW--; else state.barB--;
    } else {
      state.points[m.from] += c === W ? -1 : 1;
    }
    if (m.to === 'off') {
      if (c === W) state.offW++; else state.offB++;
    } else {
      if (m.hit) {
        state.points[m.to] = 0;
        if (c === W) state.barB++; else state.barW++;
      }
      state.points[m.to] += c === W ? 1 : -1;
    }
  }

  // Depth of the longest playable sequence from `state` with `dice` remaining.
  function maxPlayable(state, c, dice) {
    if (dice.length === 0) return 0;
    // Distinct die orderings to try (both orders for non-doubles).
    const orders = [];
    if (dice.length >= 2 && dice[0] !== dice[1]) orders.push(dice, [dice[1], dice[0]]);
    else orders.push(dice);
    let best = 0;
    for (const order of orders) {
      const die = order[0];
      const rest = order.slice(1);
      const ms = singleMoves(state, c, die);
      for (const m of ms) {
        const s2 = clone(state);
        applyRaw(s2, c, m);
        const depth = 1 + maxPlayable(s2, c, rest);
        if (depth > best) best = depth;
        if (best === dice.length) return best; // can't beat using them all
      }
    }
    return best;
  }

  // Legal NEXT moves for the player to move, enforcing forced-move rules.
  function legalMoves(state) {
    if (state.phase !== 'moving' || !state.turn) return [];
    const c = state.turn;
    const dice = state.movesLeft;
    if (dice.length === 0) return [];

    const total = maxPlayable(state, c, dice);
    if (total === 0) return [];

    const candidates = [];
    const dieValues = [...new Set(dice)];
    for (const die of dieValues) {
      const rest = dice.slice();
      rest.splice(rest.indexOf(die), 1);
      for (const m of singleMoves(state, c, die)) {
        const s2 = clone(state);
        applyRaw(s2, c, m);
        // Keep only first-steps from which the maximal total stays reachable.
        if (1 + maxPlayable(s2, c, rest) === total) candidates.push(m);
      }
    }

    // Larger-die rule: if only ONE die can be played this whole turn and both
    // dice are individually playable, the larger must be chosen. The maximality
    // filter above handles this implicitly only when playing the larger die
    // still yields total 1 — which is exactly this case; but both dice may
    // yield total 1, so filter explicitly.
    if (total === 1 && dice.length >= 2 && dice[0] !== dice[1]) {
      const hi = Math.max(...dice);
      const hiMoves = candidates.filter(m => m.die === hi);
      if (hiMoves.length > 0) return hiMoves;
    }
    return candidates;
  }

  // Apply a legal move as part of the current turn (with undo bookkeeping).
  function applyMove(state, m) {
    const s = clone(state);
    applyRaw(s, s.turn, m);
    const i = s.movesLeft.indexOf(m.die);
    s.movesLeft.splice(i, 1);
    s.turnMoves.push(m);
    return s;
  }

  function undoMove(state) {
    if (state.turnMoves.length === 0) return state;
    const s = clone(state);
    const c = s.turn;
    const m = s.turnMoves.pop();
    // Reverse of applyRaw.
    if (m.to === 'off') {
      if (c === W) s.offW--; else s.offB--;
    } else {
      s.points[m.to] += c === W ? -1 : 1;
      if (m.hit) {
        if (c === W) { s.barB--; s.points[m.to] = -1; }
        else { s.barW--; s.points[m.to] = 1; }
      }
    }
    if (m.from === 'bar') {
      if (c === W) s.barW++; else s.barB++;
    } else {
      s.points[m.from] += c === W ? 1 : -1;
    }
    s.movesLeft.push(m.die);
    return s;
  }

  function canEndTurn(state) {
    return state.phase === 'moving' &&
      (state.movesLeft.length === 0 || legalMoves(state).length === 0);
  }

  // Points this game is worth for `winner` given the loser's position.
  function computeGamePoints(state, winner) {
    const loser = opp(winner);
    const loserOff = loser === W ? state.offW : state.offB;
    let mult = 1;
    if (loserOff === 0) {
      mult = 2; // gammon
      // Backgammon: loser still has a checker on the bar or in winner's home.
      const onBar = loser === W ? state.barW : state.barB;
      let inWinnersHome = false;
      if (winner === W) { for (let i = 0; i < 6; i++) if (state.points[i] < 0) inWinnersHome = true; }
      else { for (let i = 18; i < 24; i++) if (state.points[i] > 0) inWinnersHome = true; }
      if (onBar > 0 || inWinnersHome) mult = 3;
    }
    return mult * state.cube.value;
  }

  function endTurn(state) {
    const s = clone(state);
    const c = s.turn;
    const off = c === W ? s.offW : s.offB;
    if (off === 15) {
      s.winner = c;
      const pts = computeGamePoints(s, c);
      s.gamePoints = pts;
      s.winKind = pts / s.cube.value === 3 ? 'backgammon' : pts / s.cube.value === 2 ? 'gammon' : 'single';
      s.phase = 'over';
      if (s.match.target > 1) {
        if (c === W) s.match.scoreW += pts; else s.match.scoreB += pts;
        if (s.match.scoreW >= s.match.target) s.match.winner = W;
        if (s.match.scoreB >= s.match.target) s.match.winner = B;
      }
      return s;
    }
    s.turn = opp(c);
    s.phase = 'rolling';
    s.dice = null;
    s.movesLeft = [];
    s.turnMoves = [];
    return s;
  }

  // Concede (drop a double, or resign): the opponent wins at the CURRENT stake.
  function concede(state, loser) {
    const s = clone(state);
    const winner = opp(loser);
    s.winner = winner;
    s.winKind = 'single';
    s.gamePoints = s.cube.value;
    s.phase = 'over';
    if (s.match.target > 1) {
      if (winner === W) s.match.scoreW += s.gamePoints; else s.match.scoreB += s.gamePoints;
      if (s.match.scoreW >= s.match.target) s.match.winner = W;
      if (s.match.scoreB >= s.match.target) s.match.winner = B;
    }
    return s;
  }

  // ---------------------------------------------------------------------------
  // Doubling cube
  // ---------------------------------------------------------------------------

  function canOfferCube(state, c) {
    return state.phase === 'rolling' &&
      state.turn === c &&
      !state.match.crawford &&
      state.cube.value < 64 &&
      (state.cube.owner === null || state.cube.owner === c);
  }

  function offerCube(state) {
    const s = clone(state);
    s.cube.offeredBy = s.turn;
    s.phase = 'cube-offered';
    return s;
  }

  function acceptCube(state) {
    const s = clone(state);
    s.cube.value *= 2;
    s.cube.owner = opp(s.cube.offeredBy); // taker owns the cube
    s.cube.offeredBy = null;
    s.phase = 'rolling';                  // offerer now rolls
    return s;
  }

  function dropCube(state) {
    // Dropping loses the game at the PRE-double stake.
    return concede(state, opp(state.cube.offeredBy));
  }

  // ---------------------------------------------------------------------------
  // Evaluation helpers + computer opponent
  // ---------------------------------------------------------------------------

  function pipCount(state, c) {
    let pips = 0;
    for (let i = 0; i < 24; i++) {
      const n = myCount(state, i, c);
      if (n) pips += n * (c === W ? i + 1 : 24 - i);
    }
    pips += bar(state, c) * 25;
    return pips;
  }

  // Enumerate every distinct maximal full turn (sequence of moves) available.
  function enumerateTurns(state) {
    const c = state.turn;
    const results = [];
    const seen = new Set();
    function dfs(s, seq) {
      const ms = legalMoves(s);
      if (ms.length === 0) {
        const key = JSON.stringify([s.points, s.barW, s.barB, s.offW, s.offB]);
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ moves: seq.slice(), state: s });
        }
        return;
      }
      for (const m of ms) dfs(applyMove(s, m), seq.concat([m]));
    }
    dfs(clone(state), []);
    return results;
  }

  // Count how many of the opponent's 6 die faces directly hit one of c's blots
  // (path blocking ignored — an intentionally rough danger measure).
  function directShotFaces(state, c) {
    const o = opp(c);
    let faces = 0;
    for (let die = 1; die <= 6; die++) {
      let hits = false;
      for (let i = 0; i < 24 && !hits; i++) {
        if (myCount(state, i, c) !== 1) continue; // not a blot of ours
        // Opponent checker exactly `die` behind the blot (in their direction)?
        const src = o === W ? i + die : i - die;
        if (src >= 0 && src < 24 && myCount(state, src, o) > 0) hits = true;
        // From their bar:
        const entry = o === W ? 24 - die : die - 1;
        if (bar(state, o) > 0 && entry === i) hits = true;
      }
      if (hits) faces++;
    }
    return faces;
  }

  function evaluate(state, c, weights) {
    const o = opp(c);
    const wgt = weights;
    let score = 0;

    const myPips = pipCount(state, c), opPips = pipCount(state, o);
    score += wgt.race * (opPips - myPips);

    score += wgt.off * (c === W ? state.offW : state.offB) * 10;
    score += wgt.bar * bar(state, o) * 12;
    score -= wgt.bar * bar(state, c) * 12;

    let myBlots = 0, points = 0, homePoints = 0, oppHomePoints = 0, anchors = 0, prime = 0, run = 0;
    for (let i = 0; i < 24; i++) {
      const n = myCount(state, i, c);
      if (n === 1) myBlots++;
      if (n >= 2) {
        points++;
        run++;
        if (run > prime) prime = run;
        const inMyHome = c === W ? i < 6 : i >= 18;
        const inOppHome = c === W ? i >= 18 : i < 6;
        if (inMyHome) homePoints++;
        if (inOppHome) anchors++;
      } else {
        run = 0;
      }
      if (myCount(state, i, o) >= 2 && (o === W ? i < 6 : i >= 18)) oppHomePoints++;
    }

    score += wgt.points * points * 3;
    score += wgt.home * homePoints * 4;
    score += wgt.prime * Math.max(0, prime - 1) * 5;
    if (myPips > opPips) score += wgt.anchor * anchors * 6; // anchors matter when behind

    // Blot danger: rough shot count, scarier when their home board is strong.
    const shotFaces = directShotFaces(state, c);
    score -= wgt.blot * shotFaces * (3 + oppHomePoints);
    score -= wgt.blot * myBlots * 1.5;

    // Being on the bar against a closing board is disastrous.
    score -= wgt.bar * bar(state, c) * oppHomePoints * 3;

    return score;
  }

  const AI_WEIGHTS = {
    easy:   { race: 0.9, off: 1.0, bar: 0.8, points: 0.6, home: 0.5, prime: 0.4, anchor: 0.5, blot: 0.45, noise: 9 },
    normal: { race: 1.0, off: 1.2, bar: 1.0, points: 1.0, home: 1.0, prime: 1.0, anchor: 1.0, blot: 1.0, noise: 1.5 }
  };

  // Pick a full turn for the side to move. Returns {moves, state} or null.
  function aiChooseTurn(state, level, rng) {
    const wgt = AI_WEIGHTS[level] || AI_WEIGHTS.normal;
    const rand = rng || Math.random;
    const turns = enumerateTurns(state);
    if (turns.length === 0) return null;
    let best = null, bestScore = -Infinity;
    for (const t of turns) {
      const sc = evaluate(t.state, state.turn, wgt) + (rand() - 0.5) * 2 * wgt.noise;
      if (sc > bestScore) { bestScore = sc; best = t; }
    }
    return best;
  }

  // Very rough winning-probability estimate for cube decisions.
  function winEstimate(state, c) {
    const my = pipCount(state, c), op = pipCount(state, opp(c));
    let wp = 0.5 + (op - my) / (my + op + 1) * 1.6;
    // Structural nudges.
    wp += 0.05 * (bar(state, opp(c)) - bar(state, c));
    if (state.turn === c) wp += 0.03;
    return Math.max(0.02, Math.min(0.98, wp));
  }

  function aiWantsDouble(state, c, level) {
    if (!canOfferCube(state, c)) return false;
    const wp = winEstimate(state, c);
    const threshold = level === 'easy' ? 0.75 : 0.68;
    return wp >= threshold && wp <= 0.93; // too good: play on for the gammon
  }

  function aiAcceptsDouble(state, c, level) {
    const wp = winEstimate(state, c);
    const threshold = level === 'easy' ? 0.30 : 0.25;
    return wp >= threshold;
  }

  // ---------------------------------------------------------------------------

  return {
    W, B, opp,
    initialState, nextGame, clone,
    applyOpeningRoll, rollDice,
    singleMoves, legalMoves, applyMove, undoMove, canEndTurn, endTurn,
    concede, computeGamePoints,
    canOfferCube, offerCube, acceptCube, dropCube,
    pipCount, allInHome, enumerateTurns, evaluate, directShotFaces,
    aiChooseTurn, aiWantsDouble, aiAcceptsDouble, winEstimate
  };
});
