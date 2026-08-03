// bg-game.js
// Backgammon game controller: owns the engine state, drives the 3D view,
// runs the computer opponent, and syncs multiplayer rooms through the same
// Firebase channels the other games use (events + persisted state).
//
// Multiplayer model: the acting client generates dice, applies the engine
// transition, and broadcasts a BG_* event carrying the resulting state JSON
// (with a seq counter). Remotes animate the event, then adopt the state.
// The state is also persisted on the games/ node so reloads resume cleanly.

(function () {
  'use strict';

  let view = null;          // Backgammon3D instance
  let state = null;         // engine state (+ .seq)
  let myColor = null;       // 'w' | 'b'
  let aiLevel = null;       // null (multiplayer) | 'easy' | 'normal'
  let selected = null;      // tap-to-move source zone
  let uiRoot = null;        // DOM overlay
  let busy = false;         // an animation/AI turn is in flight
  let aiTimer = null;

  const AI = 'computer';
  const rollDie = () => 1 + Math.floor(Math.random() * 6);

  const el = id => document.getElementById(id);
  const status = txt => { const s = el('game-status'); if (s) s.innerText = txt; };
  const isAi = () => aiLevel !== null;
  const oppName = () => (isAi() ? 'Computer' : (window.getOpponentName ? window.getOpponentName() : 'Opponent'));

  function colorName(c) {
    if (c === myColor) return 'You';
    return oppName();
  }

  // ---------------------------------------------------------------------------
  // DOM overlay (buttons, pips, match score, cube dialog)
  // ---------------------------------------------------------------------------

  function buildUi(container) {
    uiRoot = document.createElement('div');
    uiRoot.className = 'bg-ui';
    uiRoot.innerHTML =
      '<div class="bg-topbar">' +
        '<span id="bg-pips-me"></span>' +
        '<span id="bg-match" class="bg-match"></span>' +
        '<span id="bg-pips-op"></span>' +
      '</div>' +
      '<div class="bg-actions">' +
        '<button id="bg-btn-double" class="bg-btn bg-btn-double hidden">Double</button>' +
        '<button id="bg-btn-roll" class="bg-btn bg-btn-roll hidden">Roll</button>' +
        '<button id="bg-btn-undo" class="bg-btn hidden">Undo</button>' +
        '<button id="bg-btn-done" class="bg-btn bg-btn-done hidden">Done</button>' +
      '</div>' +
      '<div id="bg-cube-dialog" class="bg-cube-dialog hidden">' +
        '<div id="bg-cube-text"></div>' +
        '<div class="bg-cube-btns">' +
          '<button id="bg-btn-take" class="bg-btn bg-btn-done">Take</button>' +
          '<button id="bg-btn-drop" class="bg-btn bg-btn-danger">Drop</button>' +
        '</div>' +
      '</div>';
    container.appendChild(uiRoot);
    el('bg-btn-roll').addEventListener('click', onRollClick);
    el('bg-btn-undo').addEventListener('click', onUndoClick);
    el('bg-btn-done').addEventListener('click', onDoneClick);
    el('bg-btn-double').addEventListener('click', onDoubleClick);
    el('bg-btn-take').addEventListener('click', () => onCubeAnswer(true));
    el('bg-btn-drop').addEventListener('click', () => onCubeAnswer(false));
  }

  function show(id, on) { const e = el(id); if (e) e.classList.toggle('hidden', !on); }

  function refreshUi() {
    if (!state || !uiRoot) return;
    const BGE = window.BG;
    const myTurn = state.turn === myColor;
    const moving = state.phase === 'moving';
    const rolling = state.phase === 'rolling';
    const started = window.gameStarted !== false;

    show('bg-btn-roll', started && myTurn && rolling);
    show('bg-btn-double', started && myTurn && rolling && BGE.canOfferCube(state, myColor) && !busy);
    show('bg-btn-undo', started && myTurn && moving && state.turnMoves.length > 0);
    const doneReady = started && myTurn && moving && BGE.canEndTurn(state);
    show('bg-btn-done', doneReady);
    const doneBtn = el('bg-btn-done');
    if (doneBtn) doneBtn.classList.toggle('bg-pulse', doneReady);

    // Pips + match score
    const meP = el('bg-pips-me'), opP = el('bg-pips-op'), match = el('bg-match');
    if (meP) meP.innerText = 'You: ' + BGE.pipCount(state, myColor) + ' pips';
    if (opP) opP.innerText = oppName() + ': ' + BGE.pipCount(state, BGE.opp(myColor)) + ' pips';
    if (match) {
      if (state.match.target > 1) {
        const me = myColor === 'w' ? state.match.scoreW : state.match.scoreB;
        const op = myColor === 'w' ? state.match.scoreB : state.match.scoreW;
        match.innerText = `Match to ${state.match.target} — You ${me} : ${op} ${oppName()}` +
          (state.match.crawford ? ' (Crawford)' : '');
      } else {
        match.innerText = '';
      }
    }

    // Cube display
    if (view) {
      const showCube = state.match.target === 1 || !state.match.crawford;
      view.setCube(state.cube.value === 1 ? 1 : state.cube.value, state.cube.owner, showCube && !state.match.crawford);
    }

    // Cube offer dialog (shown to the player being doubled)
    const offered = state.phase === 'cube-offered';
    const iAmAsked = offered && state.cube.offeredBy !== myColor;
    show('bg-cube-dialog', iAmAsked && !isAiTurnColor(state.cube ? BGE.opp(state.cube.offeredBy) : null));
    if (iAmAsked) {
      const t = el('bg-cube-text');
      if (t) t.innerText = `${colorName(state.cube.offeredBy)} doubles to ${state.cube.value * 2}. Take or drop?`;
    }

    // Status text. While moving, say exactly which dice still HAVE to be
    // played — backgammon forces you to use every die you legally can, so the
    // Done button stays hidden until then and that needs explaining.
    if (!started) {
      status('Waiting for players...');
    } else if (state.phase === 'over') {
      // handled by gameOverUi
    } else if (state.phase === 'opening') {
      status('Rolling for first turn...');
    } else if (offered) {
      status(state.cube.offeredBy === myColor ? `Double offered — waiting for ${oppName()}...` : 'You have been doubled!');
    } else if (myTurn && rolling) {
      status('Your turn — roll!');
    } else if (myTurn && moving) {
      if (doneReady) {
        status(state.movesLeft.length ? 'No moves left — tap Done' : 'Tap Done to end your turn');
      } else {
        const left = state.movesLeft.slice().sort((a, b) => b - a);
        const onBar = (myColor === 'w' ? state.barW : state.barB) > 0;
        if (onBar) {
          status(`Enter from the bar — play your ${left.join(' and ')}`);
        } else if (left.length === 1) {
          status(`You must still play your ${left[0]}`);
        } else {
          status(`Play your ${left.join(' and ')}`);
        }
      }
    } else {
      status(`${oppName()}'s turn`);
    }

    showIdleHints();

    window.myTurn = myTurn && (moving || rolling);
    window.currentTurnPlayerId = myTurn ? window.myPeerId : (isAi() ? AI : otherPeerId());
    if (typeof window.updateGameBackground === 'function') window.updateGameBackground();
  }

  // With nothing picked up, mark every checker that still has a legal move in
  // amber. Combined with the status line this answers "why is only Undo
  // showing?" — there are still dice you're required to play, and these are
  // the checkers that can play them.
  function showIdleHints() {
    if (!view || !state) return;
    if (selected !== null) return;                       // targets are showing instead
    if (state.turn !== myColor || state.phase !== 'moving' || window.gameStarted === false) {
      view.clearHighlights();
      return;
    }
    const sources = [...new Set(window.BG.legalMoves(state).map(m => String(m.from)))]
      .map(s => (s === 'bar' ? 'bar' : parseInt(s, 10)));
    if (sources.length) view.highlightSources(sources);
    else view.clearHighlights();
  }

  function otherPeerId() {
    const other = (window.roomPlayerDetails || []).find(p => p.peerId !== window.myPeerId);
    return other ? other.peerId : window.myPeerId;
  }

  function isAiTurnColor(c) { return isAi() && c !== myColor; }

  // ---------------------------------------------------------------------------
  // State + sync plumbing
  // ---------------------------------------------------------------------------

  function stamp() { state.seq = (state.seq || 0) + 1; }

  function toJson() { return state ? JSON.stringify(state) : null; }

  function render() {
    if (view && state) view.setState(state);
    refreshUi();
  }

  function broadcast(kind, data) {
    stamp();
    if (typeof window.sendGameAction === 'function' && !isAi()) {
      window.sendGameAction(Object.assign({ type: 'BG_' + kind, bgState: toJson() }, data || {}));
    } else if (isAi() && typeof window.sendGameAction === 'function') {
      // Solo vs computer: no events needed, but persist for resume.
      window.sendGameAction({ type: 'BG_SAVE', bgState: toJson() });
    }
  }

  // ---------------------------------------------------------------------------
  // Turn flow — local player
  // ---------------------------------------------------------------------------

  function onRollClick() {
    if (!state || busy || state.turn !== myColor || state.phase !== 'rolling') return;
    if (window.gameStarted === false) return;
    busy = true;
    const d1 = rollDie(), d2 = rollDie();
    show('bg-btn-roll', false);
    show('bg-btn-double', false);
    view.animateRoll(d1, d2, () => {
      state = window.BG.rollDice(state, d1, d2);
      busy = false;
      broadcast('ROLL', { d1, d2 });
      render();
      checkNoMoves();
    });
  }

  function checkNoMoves() {
    if (state.phase === 'moving' && window.BG.legalMoves(state).length === 0 && state.movesLeft.length > 0 && state.turnMoves.length === 0) {
      if (window.showToast) window.showToast('No legal moves — turn passes.', '#8a4a25');
      setTimeout(() => { commitTurn(); }, 1100);
    }
  }

  function onUndoClick() {
    if (!state || state.turn !== myColor || state.turnMoves.length === 0) return;
    state = window.BG.undoMove(state);
    selected = null;
    view.clearHighlights();
    render();
  }

  function onDoneClick() {
    if (!state || state.turn !== myColor || !window.BG.canEndTurn(state)) return;
    commitTurn();
  }

  function commitTurn() {
    const moves = state.turnMoves.slice();
    state = window.BG.endTurn(state);
    if (state.phase === 'over') state._endedBy = window.myPeerId;
    selected = null;
    view.clearHighlights();
    broadcast('TURN', { moves });
    render();
    if (state.phase === 'over') return gameOverUi();
    maybeRunAi();
  }

  function onDoubleClick() {
    if (!state || !window.BG.canOfferCube(state, myColor) || busy) return;
    state = window.BG.offerCube(state);
    broadcast('CUBE_OFFER');
    render();
    if (isAi()) {
      setTimeout(() => {
        if (!state || state.phase !== 'cube-offered') return;
        const takes = window.BG.aiAcceptsDouble(state, window.BG.opp(myColor), aiLevel);
        if (takes) {
          state = window.BG.acceptCube(state);
          if (window.showToast) window.showToast('Computer takes the double.', '#333');
          broadcast('CUBE_TAKE');
          render();
        } else {
          state = window.BG.dropCube(state);
          state._endedBy = window.myPeerId;
          if (window.showToast) window.showToast('Computer drops — you win this game.', '#28c76f');
          broadcast('CUBE_DROP');
          render();
          gameOverUi();
        }
      }, 900);
    }
  }

  function onCubeAnswer(take) {
    if (!state || state.phase !== 'cube-offered' || state.cube.offeredBy === myColor) return;
    if (take) {
      state = window.BG.acceptCube(state);
      broadcast('CUBE_TAKE');
      render();
    } else {
      state = window.BG.dropCube(state);
      state._endedBy = window.myPeerId;
      broadcast('CUBE_DROP');
      render();
      gameOverUi();
    }
  }

  // View callbacks -------------------------------------------------------------

  function legalFromZone(zone) {
    // Single-die targets from this zone, plus two-step targets using the SAME
    // checker (drag convenience). Returns [{to, moves:[...]}, ...]
    if (!state || state.turn !== myColor || state.phase !== 'moving') return [];
    if (window.gameStarted === false) return [];
    const from = zone;
    const singles = window.BG.legalMoves(state).filter(m => m.from === from);
    const out = [];
    const seenTo = new Set();
    for (const m of singles) {
      const key = String(m.to);
      if (!seenTo.has(key)) { seenTo.add(key); out.push({ to: m.to, moves: [m] }); }
    }
    // Two-step combos with the same checker
    for (const m1 of singles) {
      if (m1.to === 'off') continue;
      const mid = window.BG.applyMove(state, m1);
      for (const m2 of window.BG.legalMoves(mid).filter(m => m.from === m1.to)) {
        const key = String(m2.to);
        if (!seenTo.has(key)) { seenTo.add(key); out.push({ to: m2.to, moves: [m1, m2] }); }
      }
    }
    return out;
  }

  // Pure query: "what could this zone move to?" The view asks this on every
  // press, including presses that turn out to be taps, so it must NOT touch
  // `selected`. It used to clear it here, which meant tapping a destination
  // that held your own movable checkers wiped the selection and re-picked-up
  // that point instead of completing the move — tap-to-move worked onto empty
  // points and blots but silently failed onto your own points.
  function onPickup(zone) {
    const opts = legalFromZone(zone);
    if (opts.length === 0) return null;
    return opts.map(o => o.to);
  }

  // Only an actual drag supersedes a tap-selection.
  function onDragStart() {
    selected = null;
  }

  function onDrop(from, to) {
    const opt = legalFromZone(from).find(o => String(o.to) === String(to));
    if (!opt) return false;
    for (const m of opt.moves) state = window.BG.applyMove(state, m);
    selected = null;
    render();
    autoDoneCheck();
    return true;
  }

  function onTap(zone) {
    if (!state || state.turn !== myColor || state.phase !== 'moving') return;
    if (zone === null) { selected = null; view.clearHighlights(); return; }
    if (selected !== null && String(selected) !== String(zone)) {
      const opt = legalFromZone(selected).find(o => String(o.to) === String(zone));
      if (opt) {
        for (const m of opt.moves) state = window.BG.applyMove(state, m);
        selected = null;
        view.clearHighlights();
        render();
        autoDoneCheck();
        return;
      }
    }
    const opts = legalFromZone(zone);
    if (opts.length && String(selected) !== String(zone)) {
      selected = zone;
      view.highlightTargets(opts.map(o => o.to));
      view.showSelectRing(zone);
    } else {
      selected = null;
      view.clearHighlights();
    }
  }

  function autoDoneCheck() {
    // Out of dice (or stuck): light up Done. Fully played turns still require
    // an explicit Done so Undo stays possible.
    refreshUi();
    if (state.phase === 'moving' && state.movesLeft.length > 0 && window.BG.legalMoves(state).length === 0 && state.turnMoves.length > 0) {
      if (window.showToast) window.showToast('No more legal moves with the remaining dice.', '#8a4a25');
    }
  }

  // ---------------------------------------------------------------------------
  // Opening roll
  // ---------------------------------------------------------------------------

  function runOpening() {
    // The host (or the solo player) rolls for both sides.
    if (!state || state.phase !== 'opening' || busy) return;
    if (!isAi() && window.gameHost !== window.myPeerId) return; // guest waits
    if (window.gameStarted === false) return;
    busy = true;
    const dW = rollDie(), dB = rollDie();
    status('Rolling for first turn...');
    view.animateRoll(dW, dB, () => {
      state = window.BG.applyOpeningRoll(state, dW, dB);
      busy = false;
      broadcast('OPENING', { dW, dB });
      if (state.phase === 'opening') {
        if (window.showToast) window.showToast(`Both rolled ${dW} — rolling again.`, '#333');
        setTimeout(runOpening, 900);
        return;
      }
      if (window.showToast) {
        const first = state.turn === myColor ? 'You go' : `${oppName()} goes`;
        window.showToast(`${first} first (${dW}-${dB}).`, '#235880');
      }
      render();
      checkNoMoves();
      maybeRunAi();
    });
  }

  // ---------------------------------------------------------------------------
  // Computer opponent
  // ---------------------------------------------------------------------------

  function maybeRunAi() {
    if (!isAi() || !state || state.phase === 'over') return;
    const aiColor = window.BG.opp(myColor);
    if (state.turn !== aiColor) return;
    clearTimeout(aiTimer);
    aiTimer = setTimeout(runAiTurn, 850);
  }

  function runAiTurn() {
    if (!state || state.phase === 'over') return;
    const BGE = window.BG;
    const aiColor = BGE.opp(myColor);
    if (state.turn !== aiColor) return;

    if (state.phase === 'rolling') {
      // Cube first?
      if (BGE.aiWantsDouble(state, aiColor, aiLevel)) {
        state = BGE.offerCube(state);
        broadcast('CUBE_OFFER');
        render(); // shows the Take/Drop dialog to the human
        return;
      }
      busy = true;
      const d1 = rollDie(), d2 = rollDie();
      view.animateRoll(d1, d2, () => {
        state = BGE.rollDice(state, d1, d2);
        busy = false;
        render();
        setTimeout(runAiTurn, 500);
      });
      return;
    }

    if (state.phase !== 'moving') return;
    const choice = BGE.aiChooseTurn(state, aiLevel);
    if (!choice || choice.moves.length === 0) {
      if (window.showToast) window.showToast('Computer has no moves.', '#333');
      state = BGE.endTurn(BGE.clone(state));
      broadcast('TURN', { moves: [] });
      render();
      if (state.phase === 'over') return gameOverUi();
      return;
    }
    // Animate the chosen moves one by one, then commit.
    let i = 0;
    const stepState = () => {
      if (i >= choice.moves.length) {
        state = BGE.endTurn(choice.state);
        if (state.phase === 'over') state._endedBy = window.myPeerId;
        broadcast('TURN', { moves: choice.moves });
        render();
        if (state.phase === 'over') return gameOverUi();
        refreshUi();
        return;
      }
      const m = choice.moves[i++];
      const fromZone = m.from === 'bar' ? 'bar' : m.from;
      const toZone = m.to === 'off' ? 'off' : m.to;
      const countAtTarget = m.to === 'off'
        ? (aiColor === 'w' ? state.offW : state.offB)
        : Math.abs(state.points[m.to] || 0);
      state = BGE.applyMove(state, m);
      view.animateMove(fromZone, toZone, aiColor, countAtTarget, () => {
        view.setState(state);
        setTimeout(stepState, 160);
      });
    };
    stepState();
  }

  // ---------------------------------------------------------------------------
  // Game over / play again
  // ---------------------------------------------------------------------------

  function gameOverUi() {
    if (!state) return;
    refreshUi();
    const BGE = window.BG;
    const iWon = state.winner === myColor;
    const kind = state.winKind === 'single' ? '' : ` (${state.winKind}!)`;
    const pts = state.match.target > 1 ? ` +${state.gamePoints} point${state.gamePoints === 1 ? '' : 's'}` : '';
    status(iWon ? `You win${kind}${pts}!` : `${oppName()} wins${kind}${pts}.`);

    // Records: single-game rooms tally every game; match rooms tally match wins.
    const shouldRecord = state.match.target === 1 || state.match.winner;
    const winnerJustDecided = state.match.target === 1 || !!state.match.winner;
    if (winnerJustDecided && shouldRecord && !state._recorded) {
      state._recorded = true;
      // The client whose action ended the game records (winner's committer =
      // whoever ran the final transition = this client if we made it end).
      if (state._endedBy === window.myPeerId || isAi()) {
        const winPid = state.winner === myColor ? window.myPeerId : (isAi() ? AI : otherPeerId());
        if (typeof window.recordRoomWin === 'function') window.recordRoomWin(winPid);
      }
    }
    if (state.match.target > 1 && state.match.winner) {
      const mw = state.match.winner === myColor ? 'You win the match!' : `${oppName()} wins the match!`;
      status(mw);
    }
    if (iWon && window.confetti && !state._confettied) {
      state._confettied = true;
      const config = { spread: 100, startVelocity: 50, scalar: 1.2 };
      window.confetti({ ...config, particleCount: 150, origin: { x: 0.3, y: 0.8 } });
      window.confetti({ ...config, particleCount: 150, origin: { x: 0.7, y: 0.8 } });
    }
    const again = el('btn-play-again');
    if (again) again.classList.remove('hidden');
    if (typeof window.renderWinsTally === 'function') window.renderWinsTally();
    broadcast('SAVE');
  }

  // ---------------------------------------------------------------------------
  // Public API (used by app.js)
  // ---------------------------------------------------------------------------

  window.BGGame = {
    active: false,

    // Enter a backgammon room. opts: { container, isHost, aiLevel, matchTarget, existingJson }
    enter(opts) {
      this.cleanup();
      this.active = true;
      myColor = opts.isHost ? 'w' : 'b';
      aiLevel = opts.aiLevel || null;
      selected = null;
      busy = false;

      const container = opts.container;
      container.classList.remove('hidden');
      view = new Backgammon3D(container, {
        onPickup, onDrop, onTap, onDragStart,
        onIdle: showIdleHints,
        onCubeTap: () => { if (window.BG.canOfferCube(state, myColor)) onDoubleClick(); }
      });
      view.setPlayerColor(myColor);
      buildUi(container);

      let adopted = false;
      if (opts.existingJson) {
        try {
          const inc = JSON.parse(opts.existingJson);
          if (inc && inc.points) { state = inc; adopted = true; }
        } catch (e) {}
      }
      if (!adopted) state = window.BG.initialState(opts.matchTarget || 1);

      render();
      if (state.phase === 'opening') setTimeout(runOpening, 700);
      else { checkNoMoves(); maybeRunAi(); }
      if (state.phase === 'over') gameOverUi();
    },

    // Adopt a state from Firebase (games node or event payload) if newer.
    syncState(json) {
      if (!this.active || !json) return;
      let inc;
      try { inc = JSON.parse(json); } catch (e) { return; }
      if (!inc || !inc.points) return;
      if (state && (state.seq || 0) >= (inc.seq || 0)) return;
      state = inc;
      selected = null;
      if (view) view.clearHighlights();
      render();
      if (state.phase === 'over') gameOverUi();
      else { checkNoMoves(); maybeRunAi(); }
    },

    // Remote events: animate, then adopt the attached state.
    handleEvent(evt) {
      if (!this.active || !evt || !evt.bgState) return;
      let inc;
      try { inc = JSON.parse(evt.bgState); } catch (e) { return; }
      if (!inc || !inc.points) return;
      if (state && (state.seq || 0) >= (inc.seq || 0)) return;

      const kind = (evt.type || '').replace(/^BG_/, '');
      if (kind === 'ROLL' || kind === 'OPENING') {
        const a = kind === 'OPENING' ? evt.dW : evt.d1;
        const b = kind === 'OPENING' ? evt.dB : evt.d2;
        state = inc; // adopt now; animation is cosmetic
        if (view && a && b) {
          view.animateRoll(a, b, () => { render(); if (state.phase === 'over') gameOverUi(); else maybeRunAi(); });
          refreshUi();
          return;
        }
      } else if (kind === 'TURN' && view && Array.isArray(evt.moves) && evt.moves.length) {
        // Animate the opponent's moves against our CURRENT board, then adopt.
        const mover = state ? state.turn : null;
        const finalState = inc;
        let i = 0;
        const step = () => {
          if (i >= evt.moves.length || !view) {
            state = finalState;
            render();
            if (state.phase === 'over') gameOverUi(); else refreshUi();
            return;
          }
          const m = evt.moves[i++];
          const countAtTarget = m.to === 'off' ? 0 : Math.abs((state && state.points[m.to]) || 0);
          view.animateMove(m.from === 'bar' ? 'bar' : m.from, m.to === 'off' ? 'off' : m.to,
            mover || 'b', countAtTarget, () => setTimeout(step, 140));
        };
        step();
        return;
      }
      state = inc;
      render();
      if (state.phase === 'over') gameOverUi();
    },

    // Play again: next game (carrying match score) or a fresh single game.
    reset() {
      if (!this.active || !state) return;
      const BGE = window.BG;
      if (state.match.target > 1 && !state.match.winner) {
        state = BGE.nextGame(state);
      } else if (state.match.target > 1) {
        state = BGE.initialState(state.match.target); // new match
      } else {
        state = BGE.initialState(1);
      }
      selected = null;
      const again = el('btn-play-again');
      if (again) again.classList.add('hidden');
      const gs = el('screen-game');
      if (gs) { gs.classList.remove('tie-background'); gs.style.backgroundColor = ''; }
      broadcast('RESET');
      render();
      setTimeout(runOpening, 700);
    },

    getStateJson: toJson,

    // Programmatic move (same path as drag/tap) — used by tests and available
    // for future keyboard control. Returns true if the move applied.
    tryMove(from, to) { return onDrop(from, to); },
    tryRoll() { onRollClick(); },
    tryDone() { onDoneClick(); },
    legalFrom(zone) { return legalFromZone(zone); },

    // Called on every room/game state update: refresh turn UI, and fire the
    // opening roll once a waiting room actually starts (2-player rooms create
    // the board before the second player arrives).
    poke() {
      if (!this.active || !state) return;
      refreshUi();
      if (state.phase === 'opening' && window.gameStarted !== false && !busy) {
        setTimeout(runOpening, 500);
      }
    },

    hasProgress() {
      return !!(state && state.phase !== 'opening' &&
        (state.turnMoves.length > 0 || state.seq > 2) && state.phase !== 'over');
    },

    markEndedByMe() { if (state) state._endedBy = window.myPeerId; },

    cleanup() {
      this.active = false;
      clearTimeout(aiTimer);
      if (view) { view.destroy(); view = null; }
      if (uiRoot && uiRoot.parentNode) uiRoot.parentNode.removeChild(uiRoot);
      uiRoot = null;
      state = null;
      myColor = null;
      aiLevel = null;
      selected = null;
      busy = false;
    }
  };
})();
