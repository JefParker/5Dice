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
      // Right-hand rail: my dice above, the Auto-Roll and Flat switches below.
      // Kept in one column so the group stays centred on the board edge as the
      // dice count changes between two and four.
      '<div class="bg-rail">' +
        '<div id="bg-dice-readout" class="bg-dice-readout hidden"></div>' +
        // The input is nested inside the label, which is association enough — a
        // `for` as well makes a click on the input itself get forwarded back by
        // the label and toggle twice in some browsers.
        '<label class="bg-rail-toggle" title="Roll automatically at the start of your turn">' +
          '<span class="bg-rail-toggle-label">AUTO<br>ROLL</span>' +
          '<span class="bg-switch">' +
            '<input type="checkbox" id="bg-autoroll-toggle">' +
            '<span class="bg-switch-slider"></span>' +
          '</span>' +
        '</label>' +
        '<label class="bg-rail-toggle" title="Keep the board flat between turns">' +
          '<span class="bg-rail-toggle-label">FLAT</span>' +
          '<span class="bg-switch">' +
            '<input type="checkbox" id="bg-flat-toggle">' +
            '<span class="bg-switch-slider"></span>' +
          '</span>' +
        '</label>' +
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
    const arEl = el('bg-autoroll-toggle');
    if (arEl) {
      arEl.checked = autoRollPref();
      arEl.addEventListener('change', e => setBgAutoRoll(e.target.checked));
    }
    const flEl = el('bg-flat-toggle');
    if (flEl) {
      flEl.checked = flatPref();
      flEl.addEventListener('change', e => setBgFlat(e.target.checked));
    }
  }

  function show(id, on) { const e = el(id); if (e) e.classList.toggle('hidden', !on); }

  function refreshUi() {
    if (!state || !uiRoot) return;
    applyCheckerColors();   // roster details often arrive after enter()
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

    // "Play again?" belongs to the game-over screen only. gameOverUi() showed it
    // but nothing ever hid it again on the OTHER player's client when they
    // adopted a fresh state, so both players were left staring at the button
    // after a rematch had already begun.
    // Both of these belong to the game-over screen only. reset() hid the button
    // but not the tally, so after Play Again the room record stayed parked over
    // the board — on a phone that's directly on top of your home board.
    if (state.phase !== 'over') {
      const againBtn = el('btn-play-again');
      if (againBtn) againBtn.classList.add('hidden');
      const winsBtn = el('fd-wins');
      if (winsBtn) winsBtn.classList.add('hidden');
    }

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

    // Cube display. With the cube switched off for the room there is nothing to
    // show: the stake is always 1 and Double never appears.
    const cubeOn = state.cube.enabled !== false;
    if (view) {
      const showCube = state.match.target === 1 || !state.match.crawford;
      view.setCube(state.cube.value, state.cube.owner, cubeOn && showCube && !state.match.crawford);
    }

    // The board's Auto-Roll switch always shows the value actually in force —
    // this board's own override if it has one, otherwise the Settings value.
    const arEl = el('bg-autoroll-toggle');
    if (arEl) arEl.checked = autoRollPref();
    const flEl = el('bg-flat-toggle');
    if (flEl) flEl.checked = flatPref();

    renderDiceReadout();

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
      status(autoRollAllowed() ? 'Your turn — rolling...' : 'Your turn — roll!');
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

    // Tip the board flat to face you on your turn, and lean it back when it
    // isn't yours — a wordless "you're up". With the Flat switch on (default)
    // the board never leans: you keep looking straight down at it.
    if (view && typeof view.setFlat === 'function') {
      view.setFlat(flatPref() ||
        (started && myTurn && state.phase !== 'over' && state.phase !== 'opening'));
    }

    window.myTurn = myTurn && (moving || rolling);
    window.currentTurnPlayerId = myTurn ? window.myPeerId : (isAi() ? AI : otherPeerId());
    if (typeof window.updateGameBackground === 'function') window.updateGameBackground();

    maybeAutoRoll();
  }

  // ---------------------------------------------------------------------------
  // Dice readout (right-hand rail)
  // ---------------------------------------------------------------------------
  // My dice for this turn, mirrored beside the board and crossed off as they
  // are played. The felt only ever holds two dice, so on doubles it cannot show
  // how many of the four moves are left — here all four appear and darken one
  // at a time. Spent dice are DARKENED rather than removed, so the roll you got
  // stays readable for the whole turn.
  const DIE_PIPS = {
    1: [[50, 50]],
    2: [[28, 28], [72, 72]],
    3: [[28, 28], [50, 50], [72, 72]],
    4: [[28, 28], [72, 28], [28, 72], [72, 72]],
    5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
    6: [[28, 28], [72, 28], [28, 50], [72, 50], [28, 72], [72, 72]]
  };
  let lastDiceReadout = null;

  function renderDiceReadout() {
    const box = el('bg-dice-readout');
    if (!box) return;
    const mine = !!state && !!state.dice && state.turn === myColor &&
      state.phase === 'moving' && window.gameStarted !== false;
    if (!mine || !view || typeof view.dieSkinCss !== 'function') {
      if (lastDiceReadout !== null) { box.innerHTML = ''; lastDiceReadout = null; }
      box.classList.add('hidden');
      return;
    }

    const d1 = state.dice[0], d2 = state.dice[1];
    const doubles = d1 === d2;
    const values = doubles ? [d1, d1, d1, d1] : [d1, d2];
    const left = state.movesLeft || [];
    // Which dice are spent. On doubles all four read the same, so the count of
    // moves still owed is what decides and the top ones cross off first. On a
    // normal roll each die is spent once its own value has left movesLeft.
    const spent = doubles
      ? values.map((_, i) => i < values.length - left.length)
      : values.map(v => left.indexOf(v) === -1);

    // Always my own colour, even on the opening turn — the felt shows one die
    // per player there, but both of them are mine to play, and this rail says
    // "yours". applyCheckerColors() ran at the top of refreshUi, so the skin is
    // current; it goes in the signature so a roster recolour repaints.
    const skin = view.dieSkinCss(myColor);
    const sig = values.join(',') + '|' + spent.join(',') + '|' + skin.body + skin.pip;
    box.classList.remove('hidden');
    if (sig === lastDiceReadout) return;   // refreshUi runs on every render
    lastDiceReadout = sig;

    box.innerHTML = values.map((v, i) => {
      const off = spent[i];
      const pips = (DIE_PIPS[v] || []).map(([x, y]) =>
        `<i style="left:${x}%;top:${y}%;background:${off ? skin.dimPip : skin.pip}"></i>`).join('');
      return `<span class="bg-die${off ? ' bg-die-spent' : ''}" aria-label="${v}" ` +
        `style="background:${off ? skin.dimBody : skin.body};` +
        `border-color:${off ? skin.dimBorder : skin.border}">${pips}</span>`;
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Auto-roll
  // ---------------------------------------------------------------------------
  // With the Auto-Roll setting on (app.js, default ON), a turn starts by itself —
  // no Roll press. The short delay is just so the roll doesn't land in the same
  // frame the board finishes painting.
  //
  // The hard rule: if the Double button is on screen, we do NOT roll for you.
  // The cube only exists in this 'rolling' window and vanishes the moment the
  // dice land, so auto-rolling would silently take the decision away. Whenever
  // doubling is on the table, the turn waits for a deliberate tap — Roll or
  // Double. This mirrors refreshUi's condition for showing bg-btn-double.
  //
  // The board carries its own Auto-Roll switch (far right). Until it is touched
  // there is no stored key and the board simply follows the global Settings
  // toggle. The first flip writes 'bgAutoRoll' and from then on backgammon keeps
  // its own answer — Settings still governs 5 Dice, but no longer this board.
  const AUTO_ROLL_DELAY = 350;
  let autoRollTimer = null;
  let autoRollArmedFor = null;

  function autoRollPref() {
    let v = null;
    try { v = localStorage.getItem('bgAutoRoll'); } catch (e) {}
    if (v === 'true') return true;
    if (v === 'false') return false;
    return window.autoRollEnabled !== false;
  }

  function setBgAutoRoll(on) {
    try { localStorage.setItem('bgAutoRoll', on ? 'true' : 'false'); } catch (e) {}
    if (!on) cancelAutoRoll();
    refreshUi();   // repaints the status line and picks up a waiting roll
  }

  // ---------------------------------------------------------------------------
  // Flat board
  // ---------------------------------------------------------------------------
  // The board normally tips flat on your turn and leans back into the seated
  // three-quarter view when it isn't yours. That swing is handsome but it moves
  // the whole board under your hands twice a turn, so the Flat switch (below
  // Auto-Roll) pins it flat: you stay looking straight down for the whole game.
  // Default ON; the answer is remembered per device.
  function flatPref() {
    let v = null;
    try { v = localStorage.getItem('bgFlatBoard'); } catch (e) {}
    return v !== 'false';
  }

  function setBgFlat(on) {
    try { localStorage.setItem('bgFlatBoard', on ? 'true' : 'false'); } catch (e) {}
    refreshUi();   // swings the camera to match straight away
  }

  function autoRollAllowed() {
    return autoRollPref() &&
      !!state && !busy &&
      state.turn === myColor &&
      state.phase === 'rolling' &&
      window.gameStarted !== false &&
      !window.BG.canOfferCube(state, myColor);
  }

  function cancelAutoRoll() {
    clearTimeout(autoRollTimer);
    autoRollTimer = null;
    autoRollArmedFor = null;
  }

  function maybeAutoRoll() {
    if (!autoRollAllowed()) return cancelAutoRoll();
    // refreshUi() runs on every render, several times per turn. Arm once per
    // turn rather than restarting the countdown on each repaint — otherwise a
    // chatty opponent's state updates could hold the roll off indefinitely.
    const key = String(state.seq || 0) + ':' + state.turn;
    if (autoRollTimer && autoRollArmedFor === key) return;
    clearTimeout(autoRollTimer);
    autoRollArmedFor = key;
    autoRollTimer = setTimeout(() => {
      autoRollTimer = null;
      autoRollArmedFor = null;
      // Re-check: the player may have doubled, or the turn may have moved on,
      // while the timer was pending.
      if (autoRollAllowed()) onRollClick();
    }, AUTO_ROLL_DELAY);
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

  // Peer id of whoever won, or null if we can't say for sure. Never guesses.
  function winnerPeerId() {
    if (!state || !state.winner) return null;
    if (state.winner === myColor) return window.myPeerId || null;
    if (isAi()) return AI;
    const other = (window.roomPlayerDetails || [])
      .find(p => p.peerId && p.peerId !== window.myPeerId);
    return other ? other.peerId : null;
  }

  // Checker colours. The host seat ('w') keeps classic cream; the other seat
  // uses that player's chosen profile colour instead of generic brown. Both
  // clients derive the SAME pair, so the board looks identical to everyone —
  // which matters the moment players start saying "your dark one on the 8".
  // BROWN is a warm mid-brown rather than the near-black it used to be — a
  // stained-cherry tone, like a real wooden set. Its luminance (~0.44) has to
  // stay under 0.45: above that the dice logic flips this side's pips to dark,
  // and above 0.5 it stops reading as "the dark side" against CREAM at all.
  // AI_RED is the computer's own colour in solo play — it has no roster entry
  // to draw from, so it gets a deliberate one instead of the neutral fallback.
  // Its luminance (~0.064) clears both dice guards: above 0.06, so the die
  // isn't lifted toward grey, and below 0.45, so the pips stay cream. That
  // lower guard is why this is as dark as the colour goes — one more step down
  // and the dice get lightened while the checkers don't, so the two stop
  // matching. Anything darker wanted here needs the guard in
  // backgammon3d.js#_dieSkin revisited, not just this constant.
  const CREAM = '#f2e9d8', BROWN = '#a9633a', AI_RED = '#4d0000';
  let appliedCheckerCols = null;

  function relLuminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * ((n >> 16 & 255) / 255) + 0.7152 * ((n >> 8 & 255) / 255) + 0.0722 * ((n & 255) / 255);
  }

  // Accept #abc as well as #aabbcc — getPeerColor's own fallback is '#333', and
  // the 6-digit-only test used to throw that (and any short hex a player had
  // saved) away, which is one of the ways the dark side ended up generic brown.
  function normHex(c) {
    if (typeof c !== 'string') return null;
    if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(c)) return ('#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toLowerCase();
    return null;
  }

  // Darken a colour until it reads against the cream side, instead of throwing
  // it out. Rejecting pale colours meant a player who picked, say, a light blue
  // silently got brown checkers and none of her chosen colour at all — now she
  // gets a deeper blue, which still identifies her.
  function readableOnCream(hex) {
    let c = hex;
    for (let i = 0; i < 12 && relLuminance(c) >= 0.5; i++) {
      const n = parseInt(c.slice(1), 16);
      const r = Math.round((n >> 16 & 255) * 0.82);
      const g = Math.round((n >> 8 & 255) * 0.82);
      const b = Math.round((n & 255) * 0.82);
      c = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    }
    return c;
  }

  function applyCheckerColors() {
    if (!view) return;
    let bHex = isAi() ? AI_RED : BROWN;
    if (!isAi()) {
      const bPeer = (myColor === 'b') ? window.myPeerId : otherPeerId();
      // otherPeerId() falls back to MY id when the roster has no opponent yet;
      // using it then would paint the dark side with the white player's colour.
      const usable = bPeer && !(myColor !== 'b' && bPeer === window.myPeerId);
      const c = (usable && typeof window.getPeerColor === 'function') ? window.getPeerColor(bPeer) : null;
      // '#333' is getPeerColor's "roster hasn't loaded" placeholder, not a
      // choice — keep classic brown until the real colour arrives.
      const hex = (c === '#333') ? null : normHex(c);
      if (hex) bHex = readableOnCream(hex);
    }
    const key = CREAM + '|' + bHex;
    if (key === appliedCheckerCols) return;   // roster updates fire constantly
    appliedCheckerCols = key;
    view.setCheckerColors(CREAM, bHex);
  }

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
    }, state.turn);
  }

  function checkNoMoves() {
    if (state.phase === 'moving' && window.BG.legalMoves(state).length === 0 && state.movesLeft.length > 0 && state.turnMoves.length === 0) {
      if (window.showToast) window.showToast('No legal moves — turn passes.', '#8a4a25');
      setTimeout(() => { commitTurn(); }, 1100);
    }
  }

  function onUndoClick() {
    if (!state || state.turn !== myColor || state.turnMoves.length === 0) return;
    // Grab the move being taken back BEFORE undoMove pops it — it is what says
    // where the checker has to fly home to.
    const m = state.turnMoves[state.turnMoves.length - 1];
    state = window.BG.undoMove(state);
    selected = null;
    if (view) view.clearHighlights();
    // Previewed moves are provisional, so an undo has to reach the opponent too
    // — otherwise their board keeps a checker we've already taken back, and only
    // snaps into line when the turn is finally committed.
    broadcast('UNDO');

    // Rewind the hop instead of repainting: the checker flies back the way it
    // came and anything it hit comes off the bar at the same moment, so an undo
    // reads as the move running backwards. Same deal as applyMyMoves — the
    // state is already correct, only the repaint waits for the checker to land.
    const gen = ++myAnimGen;
    const settle = () => { if (gen === myAnimGen) render(); };
    if (!view || typeof view.animateMove !== 'function') return settle();
    if (typeof view.finishMoveAnims === 'function') view.finishMoveAnims();

    // Slot to land in: the post-undo stack already counts the returning
    // checker, so it takes the top of it.
    const homeZone = m.from === 'bar' ? 'bar' : m.from;
    const homeSlot = Math.max(0, (m.from === 'bar'
      ? (myColor === 'w' ? state.barW : state.barB)
      : Math.abs(state.points[m.from] || 0)) - 1);

    // Counted up front: a hop can call back synchronously (hidden tab, or no
    // checker found), which would otherwise settle before the second is armed.
    let waiting = m.hit ? 2 : 1;
    const oneDone = () => { if (--waiting === 0) settle(); };
    view.animateMove(m.to === 'off' ? 'off' : m.to, homeZone, myColor, homeSlot, oneDone);
    if (m.hit) {
      // The blot goes back where it was standing, alone — undoMove puts the
      // point at exactly one checker of theirs.
      view.animateMove('bar', m.to, window.BG.opp(myColor), 0, oneDone);
    }
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
    // `streamed` tells the opponent they have ALREADY watched these moves land
    // one by one, so they adopt the committed state without replaying them.
    // The AI path and auto-passes never preview, so those still animate.
    broadcast('TURN', { moves, streamed: previewedThisTurn });
    previewedThisTurn = false;
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
      // The offerer rolls next. If that's the computer, it needs a nudge —
      // without this the game sat forever on "Computer's turn".
      maybeRunAi();
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

  // Commit my own move(s) and let the checker be SEEN travelling, the way an
  // opponent's move arrives, instead of the board blinking into its new shape.
  //
  // The engine state and the broadcast go out immediately, so a second tap
  // landing mid-hop is still computed against the real position and the
  // opponent isn't kept waiting on an animation running on my device. Only the
  // REPAINT is held back: render() is the one thing that repositions checkers,
  // so not calling it leaves the pre-move board standing for the hop to happen
  // against, and the hop itself is what shows the change.
  //
  // `animate` is false for drags — the checker is already under your finger at
  // the destination, so flying it anywhere would undo what you just did.
  let myAnimGen = 0;

  function applyMyMoves(moves, animate) {
    if (!moves || !moves.length) return;
    const before = state;                   // the position still on screen
    for (const m of moves) state = window.BG.applyMove(state, m);
    selected = null;
    if (view) view.clearHighlights();
    // Show the opponent this move NOW rather than making them wait for Done.
    streamMove(moves);

    const gen = ++myAnimGen;
    const settle = () => { if (gen === myAnimGen) { render(); autoDoneCheck(); } };
    if (!animate || !view || typeof view.animateMove !== 'function') return settle();

    // A tap arriving while the last checker is still flying: drop it on its
    // target and let this newer move animate. `state` already holds both.
    if (typeof view.finishMoveAnims === 'function') view.finishMoveAnims();

    let s = before, i = 0;
    const step = () => {
      if (gen !== myAnimGen) return;        // superseded by a later move
      if (i >= moves.length) return settle();
      const m = moves[i++];
      // Count from the running position, not the starting one, so the second
      // hop of a two-die move stacks onto the right height. A hit clears the
      // point on the way in, so the checker lands on the bottom of it.
      const countAtTarget = (m.to === 'off' || m.hit) ? 0 : Math.abs(s.points[m.to] || 0);
      s = window.BG.applyMove(s, m);
      view.animateMove(m.from === 'bar' ? 'bar' : m.from, m.to === 'off' ? 'off' : m.to,
        myColor, countAtTarget, step);
    };
    step();
  }

  function onDrop(from, to) {
    const opt = legalFromZone(from).find(o => String(o.to) === String(to));
    if (!opt) return false;
    applyMyMoves(opt.moves, false);
    return true;
  }

  function onTap(zone) {
    if (!state || state.turn !== myColor || state.phase !== 'moving') return;
    if (zone === null) { selected = null; view.clearHighlights(); return; }
    if (selected !== null && String(selected) !== String(zone)) {
      const opt = legalFromZone(selected).find(o => String(o.to) === String(zone));
      if (opt) {
        applyMyMoves(opt.moves, true);
        return;
      }
    }
    const opts = legalFromZone(zone);

    // Bearing off when that is this checker's ONLY move: one tap on the checker
    // does it. Asking for a second tap on the tray added a step that could not
    // have gone any other way. If the checker can also move within the board
    // (say a 3 bears off and a 1 is still live) the choice is real, so fall
    // through and let the player pick a destination as usual.
    if (opts.length === 1 && opts[0].to === 'off') {
      applyMyMoves(opts[0].moves, true);
      return;
    }

    if (opts.length && String(selected) !== String(zone)) {
      selected = zone;
      view.highlightTargets(opts.map(o => o.to));
      view.showSelectRing(zone);
    } else {
      const wasSelected = String(selected) === String(zone);
      selected = null;
      view.clearHighlights();
      // Tapping one of your own checkers that simply cannot move used to do
      // nothing at all — indistinguishable from a missed tap. Say so.
      if (!wasSelected && !opts.length && ownsZone(zone)) {
        view.flashBlocked(zone);
        if (window.showToast) window.showToast(noMoveReason(zone), '#8a4a25');
      }
    }
  }

  // Is `zone` occupied by MY checkers (i.e. something I could expect to move)?
  function ownsZone(zone) {
    if (!state || state.turn !== myColor || state.phase !== 'moving') return false;
    if (zone === 'bar') return (myColor === 'w' ? state.barW : state.barB) > 0;
    if (zone === 'off' || zone == null) return false;
    const n = state.points[zone];
    return myColor === 'w' ? n > 0 : n < 0;
  }

  // Why can't this checker move? The bar rule is the one that genuinely
  // confuses people, so name it rather than saying "no moves".
  function noMoveReason(zone) {
    const onBar = (myColor === 'w' ? state.barW : state.barB) > 0;
    if (onBar && zone !== 'bar') return 'You must enter from the bar first.';
    if (!state.movesLeft.length) return 'No dice left to play — tap Done.';
    return 'That checker has no legal move with ' +
      (state.movesLeft.length === 1 ? 'a ' + state.movesLeft[0] : 'these dice') + '.';
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
      // One die per player, each in that player's colour — the opening roll is
      // the one throw where the two dice do not belong to the same side.
    }, ['w', 'b']);
  }

  // Animate `moves` one at a time against the CURRENT board, then adopt
  // `finalState`. Used for both a live PREVIEW and a replayed committed TURN.
  //
  // These are QUEUED rather than run immediately. Live previews can land while
  // an earlier one is still animating, and two overlapping runs fought over the
  // board: each read `mover` and the hop's target stack from whatever `state`
  // happened to be mid-flight, and whichever finished LAST won the final
  // `state = finalState` — so a slower first animation could stomp a newer
  // position back onto the board.
  let animQueue = [], animRunning = false, queuedSeq = 0, animGen = 0;

  // Highest seq we've either adopted or already have waiting in the queue.
  // Without counting the queue, a second event arriving mid-animation compares
  // itself against a state that hasn't caught up yet.
  function latestSeq() {
    return Math.max((state && state.seq) || 0, queuedSeq);
  }

  function playMoves(moves, finalState, done) {
    queuedSeq = Math.max(queuedSeq, (finalState && finalState.seq) || 0);
    animQueue.push({ moves, finalState, done });
    pumpAnimQueue();
  }

  function pumpAnimQueue() {
    if (animRunning || !animQueue.length) return;
    animRunning = true;
    const job = animQueue.shift();
    const gen = animGen;             // a clear during flight invalidates this run
    const mover = state ? state.turn : null;
    let i = 0;
    const finish = () => {
      if (gen !== animGen) return;
      state = job.finalState;
      render();
      animRunning = false;
      if (state.phase === 'over') gameOverUi();
      else if (job.done) job.done();
      pumpAnimQueue();               // drain anything that arrived meanwhile
    };
    const step = () => {
      if (gen !== animGen) return;
      if (i >= job.moves.length || !view) return finish();
      const m = job.moves[i++];
      // A hit sends the blot to the bar first, so the arriving checker is alone
      // on the point — landing it at height 1 left it hovering over nothing.
      const countAtTarget = (m.to === 'off' || m.hit) ? 0 : Math.abs((state && state.points[m.to]) || 0);
      view.animateMove(m.from === 'bar' ? 'bar' : m.from, m.to === 'off' ? 'off' : m.to,
        mover || 'b', countAtTarget, () => setTimeout(step, 140));
    };
    step();
  }

  // Drop everything pending AND orphan any callback chain already in flight, so
  // a stale job can't land its old finalState on top of a newer board.
  function clearAnimQueue() {
    animQueue = [];
    animRunning = false;
    queuedSeq = 0;
    animGen++;
    // My own hop chain is held back from repainting until it lands, so it has
    // to be abandoned by the same paths — otherwise its settle() would render
    // over the newer board that caused the clear.
    myAnimGen++;
  }

  // Set whenever we've streamed at least one provisional move this turn.
  let previewedThisTurn = false;

  // Push a provisional mid-turn move to the opponent. The state we send is a
  // real, legal position (the mover's board after the move), it just isn't the
  // END of the turn — Undo can still take it back, and commitTurn() sends the
  // authoritative version. Peers reconcile on seq either way.
  function streamMove(moves) {
    previewedThisTurn = true;
    broadcast('PREVIEW', { moves });
  }

  // A freshly-adopted 'opening' state needs somebody to actually roll for first
  // turn. runOpening() itself decides whether THIS client is the one (host, or
  // solo-vs-computer), so it is safe to call from every adoption path.
  //
  // Without this, Play Again only worked when the HOST pressed it: a guest
  // pressing it reset the board and broadcast BG_RESET, but their own
  // runOpening() bailed on the host check while the host merely adopted the new
  // state and never started it. The rematch hung in 'opening' forever.
  let openingTimer = null;
  function maybeStartOpening() {
    if (!state || state.phase !== 'opening') return;
    if (window.gameStarted === false) return;
    // Adoption paths can fire several times in a row; collapse them to one
    // pending roll rather than stacking timers.
    clearTimeout(openingTimer);
    openingTimer = setTimeout(runOpening, 700);
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
      }, aiColor);
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
        const winPid = winnerPeerId();
        // otherPeerId() falls back to MY id when the roster is empty, so a loss
        // that I committed (bearing off is not the only way to end a game — a
        // dropped double ends it on the LOSER's client) could credit the win to
        // me. Skip the tally rather than record it to the wrong player; the
        // number is permanent and there's no UI to correct it.
        if (winPid && typeof window.recordRoomWin === 'function') window.recordRoomWin(winPid);
        else if (!winPid) state._recorded = false;   // retry when the roster lands
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

    // Enter a backgammon room.
    // opts: { container, isHost, aiLevel, matchTarget, cubeEnabled, existingJson }
    enter(opts) {
      this.cleanup();
      this.active = true;
      myColor = opts.isHost ? 'w' : 'b';
      appliedCheckerCols = null;   // force a repaint for the new room's roster
      lastDiceReadout = null;      // the rail belongs to the old uiRoot
      previewedThisTurn = false;
      clearAnimQueue();
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
      if (!adopted) state = window.BG.initialState(opts.matchTarget || 1, opts.cubeEnabled);

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
      if (state && latestSeq() >= (inc.seq || 0)) return;
      clearAnimQueue();   // a wholesale sync supersedes anything mid-flight
      state = inc;
      selected = null;
      if (view) view.clearHighlights();
      render();
      if (state.phase === 'over') gameOverUi();
      else { checkNoMoves(); maybeRunAi(); maybeStartOpening(); }
    },

    // Remote events: animate, then adopt the attached state.
    handleEvent(evt) {
      if (!this.active || !evt || !evt.bgState) return;
      let inc;
      try { inc = JSON.parse(evt.bgState); } catch (e) { return; }
      if (!inc || !inc.points) return;
      if (state && latestSeq() >= (inc.seq || 0)) return;

      const kind = (evt.type || '').replace(/^BG_/, '');
      if (kind === 'ROLL' || kind === 'OPENING') {
        const a = kind === 'OPENING' ? evt.dW : evt.d1;
        const b = kind === 'OPENING' ? evt.dB : evt.d2;
        clearAnimQueue();            // a new roll supersedes any pending previews
        state = inc; // adopt now; animation is cosmetic
        if (view && a && b) {
          // `state` is already the post-roll position, and rolling does not
          // change whose turn it is, so state.turn IS the roller.
          const sides = kind === 'OPENING' ? ['w', 'b'] : state.turn;
          view.animateRoll(a, b, () => { render(); if (state.phase === 'over') gameOverUi(); else maybeRunAi(); }, sides);
          refreshUi();
          return;
        }
      } else if (kind === 'PREVIEW' && view && Array.isArray(evt.moves) && evt.moves.length) {
        // A provisional mid-turn move: animate it right now so the turn unfolds
        // in front of us instead of arriving as a burst at Done. Adopt the
        // attached state — it is a legal position, just not the end of the turn,
        // and commitTurn() will send the authoritative one with a higher seq.
        playMoves(evt.moves, inc, () => refreshUi());
        return;
      } else if (kind === 'UNDO' || (kind === 'TURN' && evt.streamed)) {
        // Both of these carry a state we should adopt WITHOUT animating, but
        // they must not jump the queue: a fast Done (or a quick undo) arriving
        // while the last preview is still mid-hop would otherwise clear it and
        // snap the checker. An empty move list just adopts, in order.
        playMoves([], inc, () => refreshUi());
        return;
      } else if (kind === 'TURN' && !evt.streamed && view && Array.isArray(evt.moves) && evt.moves.length) {
        // Animate the opponent's moves against our CURRENT board, then adopt.
        // `streamed` turns were already watched move-by-move via PREVIEW, so
        // they fall through and adopt silently rather than replaying.
        playMoves(evt.moves, inc, () => refreshUi());
        return;
      }
      // Undo, cube events and streamed commits land here: they carry the newest
      // state outright, so anything still animating is stale by definition.
      clearAnimQueue();
      state = inc;
      render();
      if (state.phase === 'over') gameOverUi();
      else maybeStartOpening();
    },

    // Play again: next game (carrying match score) or a fresh single game.
    reset() {
      if (!this.active || !state) return;
      const BGE = window.BG;
      const prevSeq = state.seq || 0;
      // The cube setting belongs to the room, not the game — carry it into the
      // rematch rather than silently handing the cube back.
      const cubeOn = state.cube.enabled !== false;
      if (state.match.target > 1 && !state.match.winner) {
        state = BGE.nextGame(state);
      } else if (state.match.target > 1) {
        state = BGE.initialState(state.match.target, cubeOn); // new match
      } else {
        state = BGE.initialState(1, cubeOn);
      }
      // seq has to stay monotonic ACROSS games. Both syncState() and
      // handleEvent() drop any incoming state whose seq isn't newer than the one
      // they hold, and initialState()/nextGame() restart it at 0 — so a rematch
      // broadcast seq 1 to peers sitting on seq 40+ and was silently discarded.
      // Play Again then did nothing at all for the other player.
      state.seq = prevSeq;
      selected = null;
      clearAnimQueue();
      // A game that ended mid-turn can leave `busy` set, and every roll path
      // bails on it — so the rematch would never roll.
      busy = false;
      clearTimeout(aiTimer);
      cancelAutoRoll();
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

    // Settings flipped Auto-Roll: repaint the board switch (it follows Settings
    // until it has been overridden here) and pick up any roll already waiting.
    maybeAutoRoll() { if (this.active && state) refreshUi(); },

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
      clearTimeout(openingTimer);
      cancelAutoRoll();
      clearAnimQueue();
      previewedThisTurn = false;
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
