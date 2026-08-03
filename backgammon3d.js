// backgammon3d.js
// The 3D backgammon board: three.js scene with a modeled board, draggable
// checkers, physics dice that tumble onto the felt, and the doubling cube.
//
// This file is VIEW ONLY. It renders a BG engine state and reports player
// intent (picked up / dropped / tapped) through callbacks; all rules live in
// backgammon.js and all game flow in bg-game.js.
//
// Zones: point indices 0..23 (engine numbering), 'bar', 'off'.
//
// Layout (white seated at the bottom):
//   points 1-6   bottom right (white home)     points 7-12  bottom left
//   points 13-18 top left                      points 19-24 top right
//   Bear-off trays sit past the right rail: white's bottom, black's top.
// In portrait containers the whole board group rotates 90° to fit.

class Backgammon3D {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.cb = callbacks; // { onPickup(zone), onDrop(from,to), onTap(zone), onCubeTap() }
    this.destroyed = false;

    // --- Scene ---
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.domElement.style.touchAction = 'none'; // we own all gestures
    container.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xfff3e0, 0.9);
    sun.position.set(6, 18, 8);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbcd4ff, 0.25);
    fill.position.set(-8, 10, -6);
    this.scene.add(fill);

    this.group = new THREE.Group(); // everything board-local lives in here
    this.scene.add(this.group);

    // --- Geometry constants ---
    this.PW = 1.0;               // point width
    this.BAR_W = 1.15;
    this.TRAY_W = 1.35;
    this.FELT_HALF_X = 6 * this.PW + this.BAR_W / 2; // felt half-width per side
    this.DEPTH_HALF = 5.4;       // felt half-depth
    this.CHK_R = 0.42;
    this.CHK_H = 0.14;

    this._buildBoard();
    this._buildCheckers();
    this._buildDice();
    this._buildCube();
    this._buildHighlights();

    // --- Interaction state ---
    this.ray = new THREE.Raycaster();
    this.pointerNDC = new THREE.Vector2();
    this.drag = null;            // { zone, mesh, plane }
    this.legalTargets = [];
    this.portrait = false;
    this.needsRender = true;

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    // The container is often display:none when we're constructed (the screen
    // becomes visible a beat later) — observe it so the canvas sizes itself
    // the moment it actually has dimensions.
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(container);
    } else {
      setTimeout(() => this._resize(), 150);
    }
    this._pd = e => this._pointerDown(e);
    this._pm = e => this._pointerMove(e);
    this._pu = e => this._pointerUp(e);
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this._pd);
    el.addEventListener('pointermove', this._pm);
    el.addEventListener('pointerup', this._pu);
    el.addEventListener('pointercancel', this._pu);

    this._resize();
    this._animate();
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  _mat(color, opts = {}) {
    return new THREE.MeshLambertMaterial(Object.assign({ color }, opts));
  }

  _buildBoard() {
    const g = this.group;
    const fhx = this.FELT_HALF_X, dh = this.DEPTH_HALF;
    const frameCol = 0x5b3a1e, feltCol = 0x1f5c3d;
    const ptColA = 0xd9c49a, ptColB = 0x8a4a25;

    // Base slab + felt
    const base = new THREE.Mesh(new THREE.BoxGeometry((fhx + this.TRAY_W + 0.5) * 2, 0.5, dh * 2 + 1.0), this._mat(frameCol));
    base.position.y = -0.27;
    g.add(base);
    const felt = new THREE.Mesh(new THREE.BoxGeometry(fhx * 2, 0.06, dh * 2), this._mat(feltCol));
    felt.position.y = -0.03;
    g.add(felt);

    // Rails
    const railH = 0.42, railT = 0.5;
    const mkRail = (w, d, x, z) => {
      const r = new THREE.Mesh(new THREE.BoxGeometry(w, railH, d), this._mat(frameCol));
      r.position.set(x, railH / 2 - 0.05, z);
      g.add(r);
    };
    mkRail(fhx * 2 + railT * 2, railT, 0, dh + railT / 2);
    mkRail(fhx * 2 + railT * 2, railT, 0, -(dh + railT / 2));
    mkRail(railT, dh * 2 + railT * 2, -(fhx + railT / 2), 0);
    // Right rail sits between felt and the bear-off trays
    mkRail(railT, dh * 2 + railT * 2, fhx + railT / 2, 0);

    // Bar
    const barMesh = new THREE.Mesh(new THREE.BoxGeometry(this.BAR_W, 0.34, dh * 2), this._mat(0x6b4423));
    barMesh.position.y = 0.14;
    g.add(barMesh);

    // Bear-off trays (right of the right rail)
    const trayX = fhx + railT + this.TRAY_W / 2;
    const mkTray = (z) => {
      const t = new THREE.Mesh(new THREE.BoxGeometry(this.TRAY_W, 0.1, dh - 0.4), this._mat(0x3a2513));
      t.position.set(trayX, 0.0, z);
      g.add(t);
    };
    mkTray(dh / 2 + 0.15);   // white tray (front/bottom)
    mkTray(-dh / 2 - 0.15);  // black tray (back/top)
    this.trayX = trayX;

    // Points: 24 extruded triangles
    this.pointMeshes = [];
    const triShape = (w, len) => {
      const s = new THREE.Shape();
      s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, len); s.closePath();
      return s;
    };
    const ptLen = dh - 0.75;
    for (let i = 0; i < 24; i++) {
      const { x, side } = this._pointBase(i);
      const geo = new THREE.ExtrudeGeometry(triShape(this.PW * 0.92, ptLen), { depth: 0.03, bevelEnabled: false });
      const mesh = new THREE.Mesh(geo, this._mat(i % 2 === 0 ? ptColA : ptColB));
      // Shape is drawn in XY; lay it flat (rotate about X), then flip for top row.
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 0.005, side * dh);
      if (side === -1) mesh.rotation.z = Math.PI; // top row triangles point down (toward center)
      mesh.userData.zone = i;
      g.add(mesh);
      this.pointMeshes.push(mesh);
    }

    // Invisible hit zones: one slab per point + bar + both trays
    this.hitZones = [];
    const mkZone = (zone, x, z, w, d) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.9, d), this._mat(0xffffff, { transparent: true, opacity: 0 }));
      m.position.set(x, 0.3, z);
      m.userData.zone = zone;
      m.visible = true; // must be visible for raycast; it's fully transparent
      g.add(m);
      this.hitZones.push(m);
    };
    for (let i = 0; i < 24; i++) {
      const { x, side } = this._pointBase(i);
      mkZone(i, x, side * (dh / 2 + 0.15), this.PW, dh - 0.3);
    }
    mkZone('bar', 0, 0, this.BAR_W, dh * 2);
    mkZone('offW', trayX, dh / 2 + 0.15, this.TRAY_W, dh - 0.4);
    mkZone('offB', trayX, -dh / 2 - 0.15, this.TRAY_W, dh - 0.4);
  }

  // Board position of a point's base: x center and which side (1 = front/bottom
  // row = points 1-12, -1 = back/top row = points 13-24).
  _pointBase(i) {
    const p = i + 1; // 1..24
    const off = this.BAR_W / 2;
    let x, side;
    if (p <= 6) { side = 1; x = off + (6 - p) * this.PW + this.PW / 2; }
    else if (p <= 12) { side = 1; x = -(off + (p - 7) * this.PW + this.PW / 2); }
    else if (p <= 18) { side = -1; x = -(off + (18 - p) * this.PW + this.PW / 2); }
    else { side = -1; x = off + (p - 19) * this.PW + this.PW / 2; }
    return { x, side };
  }

  // World (group-local) position for checker #k on a zone.
  _slotPos(zone, k, color) {
    const dh = this.DEPTH_HALF;
    if (zone === 'bar') {
      const dir = color === 'w' ? -1 : 1; // white waits on top half? put white bar checkers toward top (they enter far side)
      return new THREE.Vector3(0, 0.31 + Math.floor(k / 3) * (this.CHK_H + 0.01), dir * (1.0 + (k % 3) * 0.9));
    }
    if (zone === 'off') {
      const z = color === 'w' ? dh / 2 + 0.15 : -dh / 2 - 0.15;
      // Stack borne-off checkers lying in the tray in two columns.
      const col = Math.floor(k / 8), row = k % 8;
      return new THREE.Vector3(this.trayX + (col === 0 ? -0.25 : 0.25), 0.12 + 0.0, z - (dh / 2 - 0.7) + row * 0.55 * (color === 'w' ? 1 : 1) * (color === 'w' ? 1 : 1) - 0);
    }
    const { x, side } = this._pointBase(zone);
    const layer = Math.floor(k / 5);
    const slot = k % 5;
    const z = side * (dh - 0.75 - this.CHK_R - slot * (this.CHK_R * 2 * 0.92)) * 1 + side * 0.3;
    return new THREE.Vector3(x, this.CHK_H / 2 + layer * (this.CHK_H + 0.005), z);
  }

  _buildCheckers() {
    this.checkers = [];
    const geo = new THREE.CylinderGeometry(this.CHK_R, this.CHK_R, this.CHK_H, 28);
    const matW = this._mat(0xf2e9d8), matB = this._mat(0x3b2f2f);
    const rimW = this._mat(0xd8c9a8), rimB = this._mat(0x241c1c);
    for (let i = 0; i < 30; i++) {
      const isW = i < 15;
      const mesh = new THREE.Mesh(geo, [isW ? rimW : rimB, isW ? matW : matB, isW ? matW : matB]);
      mesh.userData.checkerColor = isW ? 'w' : 'b';
      mesh.userData.zone = null;
      mesh.visible = false;
      this.group.add(mesh);
      this.checkers.push(mesh);
    }
  }

  _buildDice() {
    // Two dice with pip textures, tumbled by a local cannon world.
    this.diceSize = 0.62;
    const mats = [];
    for (let v = 1; v <= 6; v++) mats.push(this._dieFace(v));
    // BoxGeometry order: +x,-x,+y,-y,+z,-z → faces 3,4,1,6,2,5 (standard die: opposite faces sum 7)
    const order = [2, 3, 0, 5, 1, 4];
    this.dice = [];
    this.world = new CANNON.World();
    this.world.allowSleep = true;
    // cannon.js 0.6.2 (what index.html loads) has NO options-object
    // constructor — `new World({gravity})` silently left gravity at ZERO, so
    // dice never actually settled and the solver could leave one embedded in
    // the felt (it read as a flat, thin square slab). Set it on the instance,
    // which works in both cannon.js and cannon-es.
    this.world.gravity.set(0, -34, 0);
    const mat = new CANNON.Material();
    this.world.addContactMaterial(new CANNON.ContactMaterial(mat, mat, { friction: 0.25, restitution: 0.42 }));
    const floor = new CANNON.Body({ mass: 0, material: mat });
    floor.addShape(new CANNON.Plane());
    floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(floor);
    // Low walls keep dice on the right half of the felt.
    const wall = (x, z, ry) => {
      const b = new CANNON.Body({ mass: 0, material: mat });
      b.addShape(new CANNON.Plane());
      b.position.set(x, 0, z);
      b.quaternion.setFromEuler(0, ry, 0);
      this.world.addBody(b);
    };
    wall(this.BAR_W / 2 + 0.2, 0, Math.PI / 2);
    wall(this.FELT_HALF_X - 0.2, 0, -Math.PI / 2);
    wall(0, -this.DEPTH_HALF + 0.3, 0);
    wall(0, this.DEPTH_HALF - 0.3, Math.PI);

    for (let i = 0; i < 2; i++) {
      // Each die needs its OWN materials: sharing them meant dimming the die
      // whose value had been played also dimmed the other one.
      const dieMats = order.map(f => mats[f].clone());
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(this.diceSize, this.diceSize, this.diceSize), dieMats);
      mesh.visible = false;
      this.group.add(mesh);
      const body = new CANNON.Body({ mass: 1, material: mat });
      body.addShape(new CANNON.Box(new CANNON.Vec3(this.diceSize / 2, this.diceSize / 2, this.diceSize / 2)));
      body.position.set(100, 100, 100);
      this.world.addBody(body);
      this.dice.push({ mesh, body });
    }
    this.rollAnim = null;
  }

  _dieFace(v) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f8f4ea'; ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = '#d8cfb8'; ctx.lineWidth = 6; ctx.strokeRect(3, 3, 122, 122);
    ctx.fillStyle = '#22252b';
    const dot = (x, y) => { ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill(); };
    const m = 64, d = 32;
    if (v % 2 === 1) dot(m, m);
    if (v > 1) { dot(m - d, m - d); dot(m + d, m + d); }
    if (v > 3) { dot(m + d, m - d); dot(m - d, m + d); }
    if (v === 6) { dot(m - d, m); dot(m + d, m); }
    return new THREE.MeshLambertMaterial({ map: new THREE.CanvasTexture(c) });
  }

  // Orientation that shows `v` on top (matches the face order above).
  _dieQuatFor(v) {
    const e = new THREE.Euler();
    switch (v) {
      case 1: e.set(0, 0, 0); break;
      case 6: e.set(Math.PI, 0, 0); break;
      case 2: e.set(-Math.PI / 2, 0, 0); break;
      case 5: e.set(Math.PI / 2, 0, 0); break;
      case 3: e.set(0, 0, Math.PI / 2); break;
      case 4: e.set(0, 0, -Math.PI / 2); break;
    }
    return new THREE.Quaternion().setFromEuler(e);
  }

  // Distance from a die's CENTRE down to its lowest corner for a given
  // orientation. Flat on a face this is diceSize/2; balanced on a corner it is
  // diceSize*sqrt(3)/2 (~0.54 at our size). Clamping the centre to diceSize/2 —
  // which is what this used to do — therefore still let a tilted die sink up to
  // a quarter of its body under the felt, and a half-buried cube renders as a
  // flat tile with no visible sides. Always clamp on the support point instead.
  _supportY(quat) {
    const h = this.diceSize / 2;
    const v = this._supportVec || (this._supportVec = new THREE.Vector3());
    let s = 0;
    s += Math.abs(v.set(1, 0, 0).applyQuaternion(quat).y);
    s += Math.abs(v.set(0, 1, 0).applyQuaternion(quat).y);
    s += Math.abs(v.set(0, 0, 1).applyQuaternion(quat).y);
    return h * s;
  }

  _buildCube() {
    const size = 0.78;
    const faces = [2, 4, 8, 16, 32, 64].map(n => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#efe6d0'; ctx.fillRect(0, 0, 128, 128);
      ctx.strokeStyle = '#b9ad90'; ctx.lineWidth = 6; ctx.strokeRect(3, 3, 122, 122);
      ctx.fillStyle = '#7a1f1f';
      ctx.font = 'bold 64px Georgia, serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(n), 64, 68);
      return new THREE.MeshLambertMaterial({ map: new THREE.CanvasTexture(c) });
    });
    this.cubeMesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), faces);
    this.cubeMesh.userData.zone = 'cube';
    this.cubeMesh.visible = false;
    this.group.add(this.cubeMesh);
  }

  // Show the cube: value on top, at center-left (centered) or near an owner.
  setCube(value, owner, visible) {
    const m = this.cubeMesh;
    m.visible = !!visible;
    if (!visible) { this.needsRender = true; return; }
    // Face index for value: faces order [2,4,8,16,32,64] mapped to box sides
    // (+x,-x,+y,-y,+z,-z). Put the value on +y (top) by rotating.
    const idx = Math.max(0, [2, 4, 8, 16, 32, 64].indexOf(value === 1 ? 64 : value));
    // Which box side holds this material: side idx directly.
    const target = [
      new THREE.Euler(0, 0, Math.PI / 2),   // +x -> top
      new THREE.Euler(0, 0, -Math.PI / 2),  // -x -> top
      new THREE.Euler(0, 0, 0),             // +y already top
      new THREE.Euler(Math.PI, 0, 0),       // -y -> top
      new THREE.Euler(-Math.PI / 2, 0, 0),  // +z -> top
      new THREE.Euler(Math.PI / 2, 0, 0)    // -z -> top
    ][idx];
    m.quaternion.setFromEuler(target);
    const x = -(this.FELT_HALF_X + 0.5 + this.TRAY_W / 2 - 0.6);
    const z = owner === 'w' ? this.DEPTH_HALF - 0.6 : owner === 'b' ? -(this.DEPTH_HALF - 0.6) : 0;
    m.position.set(-(this.FELT_HALF_X + 0.95), 0.42, z);
    this.needsRender = true;
  }

  _buildHighlights() {
    // Glowing discs marking zones. Green = a legal destination for the
    // checker you're holding; amber = a checker you still have to move.
    this.highlightMeshes = [];
    const geo = new THREE.CylinderGeometry(0.36, 0.36, 0.03, 20);
    this.targetMat = new THREE.MeshBasicMaterial({ color: 0x39e07a, transparent: true, opacity: 0.65 });
    this.sourceMat = new THREE.MeshBasicMaterial({ color: 0xffc83d, transparent: true, opacity: 0.5 });
    for (let i = 0; i < 28; i++) {
      const m = new THREE.Mesh(geo, this.targetMat);
      m.visible = false;
      this.group.add(m);
      this.highlightMeshes.push(m);
    }
    // Source ring under a selected checker
    this.selectRing = new THREE.Mesh(
      new THREE.TorusGeometry(this.CHK_R + 0.08, 0.045, 10, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd54a })
    );
    this.selectRing.rotation.x = Math.PI / 2;
    this.selectRing.visible = false;
    this.group.add(this.selectRing);
  }

  // ---------------------------------------------------------------------------
  // State rendering
  // ---------------------------------------------------------------------------

  // Lay out all 30 checkers to match an engine state.
  setState(state) {
    let iW = 0, iB = 15;
    const place = (mesh, zone, k, color) => {
      mesh.visible = true;
      mesh.userData.zone = zone;
      const p = this._slotPos(zone, k, color);
      mesh.position.copy(p);
      mesh.rotation.set(0, 0, 0);
      if (zone === 'off') { mesh.rotation.x = Math.PI / 2; mesh.position.y = 0.3; }
    };
    for (let pt = 0; pt < 24; pt++) {
      const v = state.points[pt];
      const n = Math.abs(v);
      for (let k = 0; k < n; k++) {
        if (v > 0) place(this.checkers[iW++], pt, k, 'w');
        else place(this.checkers[iB++], pt, k, 'b');
      }
    }
    for (let k = 0; k < state.barW; k++) place(this.checkers[iW++], 'bar', k, 'w');
    for (let k = 0; k < state.barB; k++) place(this.checkers[iB++], 'bar', k, 'b');
    for (let k = 0; k < state.offW; k++) place(this.checkers[iW++], 'off', k, 'w');
    for (let k = 0; k < state.offB; k++) place(this.checkers[iB++], 'off', k, 'b');
    while (iW < 15) this.checkers[iW++].visible = false;
    while (iB < 30) this.checkers[iB++].visible = false;

    // Static dice display for the current roll.
    if (state.dice && !this.rollAnim) {
      this._placeDiceStatic(state.dice[0], state.dice[1], state.movesLeft);
    } else if (!state.dice && !this.rollAnim) {
      this.dice.forEach(d => { d.mesh.visible = false; });
    }
    this.needsRender = true;
  }

  _placeDiceStatic(d1, d2, movesLeft) {
    const used = (v) => {
      // Dim a die whose value has been fully consumed this turn.
      if (!movesLeft) return false;
      return movesLeft.indexOf(v) === -1;
    };
    const xs = [this.FELT_HALF_X * 0.45, this.FELT_HALF_X * 0.72];
    [d1, d2].forEach((v, i) => {
      const die = this.dice[i];
      die.mesh.visible = true;
      die.mesh.position.set(xs[i], this.diceSize / 2 + 0.02, 0.4 - i * 0.9);
      die.mesh.quaternion.copy(this._dieQuatFor(v));
      const dim = used(v) && (d1 !== d2 || used(v));
      // Only flag the material transparent while it is actually dimmed. Leaving
      // transparent=true at full opacity pushes the die into three.js's
      // transparent pass for good, where it stops depth-sorting reliably
      // against the board.
      die.mesh.material.forEach(m => {
        if (m.transparent !== dim) { m.transparent = dim; m.needsUpdate = true; }
        m.opacity = dim ? 0.35 : 1;
      });
      die.body.position.set(100, 100 + i, 100);
    });
    this.needsRender = true;
  }

  // Physics tumble ending on known values; calls done() when settled.
  // A hidden tab pauses requestAnimationFrame, which would stall the whole
  // game flow behind this animation — so when the page is hidden (or becomes
  // hidden mid-roll: the watchdog below), skip straight to the result.
  animateRoll(d1, d2, done) {
    const finishInstantly = () => {
      this.rollAnim = null;
      this._placeDiceStatic(d1, d2, null);
      if (done) done();
    };
    if (typeof document !== 'undefined' && document.hidden) { finishInstantly(); return; }
    const values = [d1, d2];
    this.rollAnim = { values, start: performance.now(), settling: false, done };
    const anim = this.rollAnim;
    setTimeout(() => {
      if (this.rollAnim === anim) finishInstantly(); // rAF never progressed
    }, 3200);
    this.dice.forEach((die, i) => {
      die.mesh.visible = true;
      die.mesh.material.forEach(m => {
        if (m.transparent) { m.transparent = false; m.needsUpdate = true; }
        m.opacity = 1;
      });
      die.body.position.set(this.FELT_HALF_X * 0.4 + i * 0.3, 3 + i * 1.2, (i ? 1 : -1) * 1.2);
      die.body.velocity.set(2 + Math.random() * 3, -2, (Math.random() - 0.5) * 6);
      die.body.angularVelocity.set(Math.random() * 18, Math.random() * 18, Math.random() * 18);
      die.body.type = CANNON.Body.DYNAMIC;
      die.body.wakeUp();
    });
  }

  // Animate a single checker hop from zone to zone; view-only, then done().
  animateMove(fromZone, toZone, color, countsAtTarget, done) {
    if (typeof document !== 'undefined' && document.hidden) { if (done) done(); return; }
    // Find the top checker of `color` on fromZone.
    let mesh = null;
    for (const c of this.checkers) {
      if (c.visible && c.userData.zone === fromZone && c.userData.checkerColor === color) {
        mesh = c; // last placed = topmost by construction order
      }
    }
    if (!mesh) { if (done) done(); return; }
    const from = mesh.position.clone();
    const to = this._slotPos(toZone === 'off' ? 'off' : toZone, countsAtTarget, color);
    const anim = { mesh, from, to, start: performance.now(), dur: 260, done, toZone };
    this.moveAnims = this.moveAnims || [];
    this.moveAnims.push(anim);
    // Watchdog: rAF can be paused (occluded window) even when document.hidden
    // is false — never let a cosmetic hop stall the game flow behind it.
    setTimeout(() => {
      const idx = this.moveAnims ? this.moveAnims.indexOf(anim) : -1;
      if (idx >= 0) {
        this.moveAnims.splice(idx, 1);
        anim.mesh.position.copy(anim.to);
        this.needsRender = true;
        if (anim.done) anim.done();
      }
    }, 1400);
  }

  // ---------------------------------------------------------------------------
  // Highlights
  // ---------------------------------------------------------------------------

  highlightTargets(zones) {
    this.legalTargets = zones.slice();
    this._paintZones(zones, this.targetMat);
  }

  // Amber markers on the checkers that still have a legal move — shown while
  // nothing is picked up so it's never a mystery what the game is waiting for.
  highlightSources(zones) {
    this.legalTargets = [];
    this._paintZones(zones, this.sourceMat);
  }

  _paintZones(zones, material) {
    this.highlightMeshes.forEach(m => { m.visible = false; });
    zones.forEach((z, i) => {
      if (i >= this.highlightMeshes.length) return;
      const m = this.highlightMeshes[i];
      m.material = material;
      let p;
      if (z === 'off') p = new THREE.Vector3(this.trayX, 0.25, this._offSideZ());
      else if (z === 'bar') p = new THREE.Vector3(0, 0.55, 0);
      else {
        const { x, side } = this._pointBase(z);
        p = new THREE.Vector3(x, 0.08, side * (this.DEPTH_HALF - 1.2));
      }
      m.position.copy(p);
      m.visible = true;
    });
    this.needsRender = true;
  }

  _offSideZ() {
    return this._offColor === 'b' ? -(this.DEPTH_HALF / 2 + 0.15) : this.DEPTH_HALF / 2 + 0.15;
  }
  setPlayerColor(c) { this._offColor = c; }

  showSelectRing(zone) {
    if (zone == null) { this.selectRing.visible = false; this.needsRender = true; return; }
    let top = null;
    for (const c of this.checkers) if (c.visible && c.userData.zone === zone) top = c;
    if (top) {
      this.selectRing.position.copy(top.position);
      this.selectRing.position.y += this.CHK_H;
      this.selectRing.visible = true;
    }
    this.needsRender = true;
  }

  clearHighlights() {
    this.legalTargets = [];
    this.highlightMeshes.forEach(m => { m.visible = false; });
    this.selectRing.visible = false;
    this.needsRender = true;
  }

  // ---------------------------------------------------------------------------
  // Pointer interaction
  // ---------------------------------------------------------------------------

  _ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointerNDC.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    return this.pointerNDC;
  }

  _zoneAt(e, includeCheckers) {
    this.ray.setFromCamera(this._ndc(e), this.camera);
    if (includeCheckers) {
      const hit = this.ray.intersectObjects(this.checkers.filter(c => c.visible), false)[0];
      if (hit) return { zone: hit.object.userData.zone, checker: hit.object };
    }
    const cubeHit = this.ray.intersectObject(this.cubeMesh, false)[0];
    if (cubeHit && this.cubeMesh.visible) return { zone: 'cube' };
    const zh = this.ray.intersectObjects(this.hitZones, false)[0];
    if (zh) {
      let z = zh.object.userData.zone;
      if (z === 'offW' || z === 'offB') z = 'off';
      return { zone: z };
    }
    return null;
  }

  _pointerDown(e) {
    if (this.destroyed) return;
    const hit = this._zoneAt(e, true);
    if (!hit) { if (this.cb.onTap) this.cb.onTap(null); return; }
    if (hit.zone === 'cube') { if (this.cb.onCubeTap) this.cb.onCubeTap(); return; }

    // Ask the controller whether this zone is a legal pickup right now.
    const targets = this.cb.onPickup ? this.cb.onPickup(hit.zone) : null;
    if (targets && targets.length && hit.checker) {
      this.renderer.domElement.setPointerCapture(e.pointerId);
      this.drag = {
        zone: hit.zone,
        mesh: hit.checker,
        homePos: hit.checker.position.clone(),
        moved: false
      };
      this.highlightTargets(targets);
      this.needsRender = true;
    } else {
      // Not draggable: treat as a tap (tap-to-move flow handled by controller).
      if (this.cb.onTap) this.cb.onTap(hit.zone);
    }
  }

  _pointerMove(e) {
    if (!this.drag) return;
    this.drag.moved = true;
    // Project onto the lifted drag plane (y = 0.55), in GROUP-local coords.
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.55);
    const world = new THREE.Vector3();
    if (this.ray.ray.intersectPlane(plane, world)) {
      const local = this.group.worldToLocal(world.clone());
      this.drag.mesh.position.set(local.x, 0.55, local.z);
      this.needsRender = true;
    }
  }

  _pointerUp(e) {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    const hit = this._zoneAt(e, false);
    let applied = false;
    if (d.moved && hit && this.legalTargets.includes(hit.zone) && this.cb.onDrop) {
      applied = this.cb.onDrop(d.zone, hit.zone);
    }
    this.clearHighlights();
    if (!applied) {
      // Snap home (controller will re-setState on success, so only failures matter).
      d.mesh.position.copy(d.homePos);
      if (!d.moved && this.cb.onTap) this.cb.onTap(d.zone); // press without drag = tap
    }
    // Let the controller restore its idle hints, which clearHighlights just wiped.
    if (this.cb.onIdle) this.cb.onIdle();
    this.needsRender = true;
  }

  // ---------------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------------

  _resize() {
    if (this.destroyed) return;
    const w = this.container.clientWidth || 300;
    const h = this.container.clientHeight || 300;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.portrait = h > w * 1.05;
    this.group.rotation.y = this.portrait ? Math.PI / 2 : 0;
    // Fit: pull the camera back until the board's long axis fits the view.
    const long = (this.FELT_HALF_X + this.TRAY_W + 1) * 2;
    const fov = this.camera.fov * Math.PI / 180;
    const fitAxis = this.portrait ? h / w : 1; // rotated board: long axis maps to vertical
    let dist;
    if (!this.portrait) {
      const hFov = 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect);
      dist = (long / 2) / Math.tan(hFov / 2) * 1.12;
    } else {
      dist = (long / 2) / Math.tan(fov / 2) * 1.18;
    }
    dist = Math.max(dist, 13);
    this.camera.position.set(0, dist * 0.86, dist * 0.62);
    this.camera.lookAt(0, 0, this.portrait ? 0 : 0.4);
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  _animate() {
    if (this.destroyed) return;
    requestAnimationFrame(() => this._animate());
    const now = performance.now();
    let busy = false;

    // Dice physics / settle
    if (this.rollAnim) {
      busy = true;
      const a = this.rollAnim;
      if (!a.settling) {
        this.world.step(1 / 60, Math.min(0.1, (now - (this._lastStep || now)) / 1000), 3);
        this._lastStep = now;
        this.dice.forEach(d => {
          // Hard floor: a die must never render below the felt. Without this a
          // solver hiccup leaves a half-buried cube showing as a thin square.
          const rest = this._supportY(d.body.quaternion);
          if (d.body.position.y < rest) {
            d.body.position.y = rest;
            if (d.body.velocity.y < 0) d.body.velocity.y *= -0.35;
          }
          d.mesh.position.copy(d.body.position);
          d.mesh.quaternion.copy(d.body.quaternion);
        });
        if (now - a.start > 1300) {
          a.settling = true;
          a.settleStart = now;
          this.dice.forEach((d, i) => {
            d.body.type = CANNON.Body.KINEMATIC;
            d.body.velocity.set(0, 0, 0);
            d.body.angularVelocity.set(0, 0, 0);
            a['p' + i] = d.mesh.position.clone();
            a['q' + i] = d.mesh.quaternion.clone();
          });
        }
      } else {
        const t = Math.min(1, (now - a.settleStart) / 420);
        const ease = 1 - Math.pow(1 - t, 3);
        const xs = [this.FELT_HALF_X * 0.45, this.FELT_HALF_X * 0.72];
        this.dice.forEach((d, i) => {
          const target = new THREE.Vector3(xs[i], this.diceSize / 2 + 0.02, 0.4 - i * 0.9);
          d.mesh.position.lerpVectors(a['p' + i], target, ease);
          d.mesh.quaternion.slerpQuaternions(a['q' + i], this._dieQuatFor(a.values[i]), ease);
          // The die is still tilted for most of this tween while its centre is
          // already being pulled down to resting height — so without clamping on
          // the rotated support point it dips through the felt and reads as a
          // flat tile until the very last frame.
          const minY = this._supportY(d.mesh.quaternion) + 0.02;
          if (d.mesh.position.y < minY) d.mesh.position.y = minY;
        });
        if (t >= 1) {
          // Land on the exact resting pose rather than trusting the final tween
          // frame, so the two dice are always identically seated.
          this.dice.forEach((d, i) => {
            d.mesh.position.set(xs[i], this.diceSize / 2 + 0.02, 0.4 - i * 0.9);
            d.mesh.quaternion.copy(this._dieQuatFor(a.values[i]));
          });
          const done = a.done;
          this.rollAnim = null;
          if (done) done();
        }
      }
    }

    // Checker hop animations
    if (this.moveAnims && this.moveAnims.length) {
      busy = true;
      const keep = [];
      for (const a of this.moveAnims) {
        const t = Math.min(1, (now - a.start) / a.dur);
        const ease = t * (2 - t);
        a.mesh.position.lerpVectors(a.from, a.to, ease);
        a.mesh.position.y += Math.sin(t * Math.PI) * 0.6; // arc
        if (t >= 1) {
          a.mesh.position.copy(a.to);
          if (a.done) a.done();
        } else keep.push(a);
      }
      this.moveAnims = keep;
    }

    if (this.drag) busy = true;

    if (busy || this.needsRender) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  }

  destroy() {
    this.destroyed = true;
    window.removeEventListener('resize', this._onResize);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this._pd);
    el.removeEventListener('pointermove', this._pm);
    el.removeEventListener('pointerup', this._pu);
    el.removeEventListener('pointercancel', this._pu);
    try {
      this.renderer.dispose();
      if (this.renderer.forceContextLoss) this.renderer.forceContextLoss();
    } catch (e) {}
    if (el.parentNode) el.parentNode.removeChild(el);
  }
}
