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
    this._offColor = 'w';        // local player's seat; set via setPlayerColor
    this.needsRender = true;

    // --- Camera tilt ---
    // 0 = the seated three-quarter view, 1 = flat overhead. The board tips up to
    // face the player on their turn and leans back when it isn't. _resize()
    // computes a fitted pose for each end and _applyCamera() interpolates.
    this._tilt = 0;              // where the camera is now
    this._tiltGoal = 0;          // where it's heading
    this._camSeated = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
    this._camFlat = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
    this.TILT_MS = 650;

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
    // Bumped by setCheckerColors(). The dice bake the checker colours into
    // their face textures, so they need to know when those colours went stale.
    this._skinRev = 0;
    const geo = new THREE.CylinderGeometry(this.CHK_R, this.CHK_R, this.CHK_H, 28);
    // Kept on `this` and SHARED by every checker of a side, so setCheckerColors()
    // can recolour a whole side by touching two materials.
    const matW = this.faceMatW = this._mat(0xf2e9d8);
    const matB = this.faceMatB = this._mat(0x3b2f2f);
    const rimW = this.rimMatW = this._mat(0xd8c9a8);
    const rimB = this.rimMatB = this._mat(0x241c1c);
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

  // Recolour the two sides. Each argument is any THREE-parsable colour (hex
  // string or number); pass null to leave that side alone. The rim is a
  // darkened copy of the face so a checker still reads as a disc, not a blob.
  setCheckerColors(wCol, bCol) {
    const apply = (face, rim, col) => {
      if (col == null) return;
      face.color.set(col);
      rim.color.copy(face.color).multiplyScalar(0.62);
    };
    apply(this.faceMatW, this.rimMatW, wCol);
    apply(this.faceMatB, this.rimMatB, bCol);
    // Each side's dice are painted that side's checker colour, and the pips are
    // baked into a canvas texture — so a recolour has to throw the cached skins
    // away and repaint, not just tint a material.
    this._skinRev++;
    if (this.dice) {
      this.dice.forEach(d => this._setDieSkin(d, d.side || 'w'));
      // Re-run the last placement so the spent-die dimming survives the repaint.
      const l = this._lastDice;
      if (l && !this.rollAnim && this.dice[0].mesh.visible) {
        this._placeDiceStatic(l.d1, l.d2, l.movesLeft, l.sides);
      }
    }
    this.needsRender = true;
  }

  _buildDice() {
    // Two dice with pip textures, tumbled by a local cannon world. Each die is
    // skinned in the colour of whoever is rolling it — see _setDieSkin().
    this.diceSize = 0.62;
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
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(this.diceSize, this.diceSize, this.diceSize), []);
      mesh.visible = false;
      this.group.add(mesh);
      const body = new CANNON.Body({ mass: 1, material: mat });
      body.addShape(new CANNON.Box(new CANNON.Vec3(this.diceSize / 2, this.diceSize / 2, this.diceSize / 2)));
      body.position.set(100, 100, 100);
      this.world.addBody(body);
      const die = { mesh, body, skins: {}, skinRev: this._skinRev, side: null };
      this._setDieSkin(die, 'w');
      this.dice.push(die);
    }
    this.rollAnim = null;
  }

  // The body/pip/border colours for one side's dice, derived from that side's
  // CURRENT checker colour so custom roster colours carry through.
  //
  // Two guards keep the numbers readable at any hue. The pips flip dark-on-light
  // or light-on-dark from the body's luminance rather than being fixed; and a
  // body close to pure black is lifted slightly first, since Lambert shading
  // gives it no visible edges and it reads as a hole in the felt rather than a
  // cube. The lift threshold is deliberately below the default dark checker
  // (#3b2f2f, ~0.19) so the classic set is left exactly as it is.
  //
  // The luminance formula matches bg-game.js's relLuminance(), which is what
  // decides how far a custom roster colour gets darkened — so the two agree.
  _dieSkin(side) {
    const body = (side === 'b' ? this.faceMatB : this.faceMatW).color.clone();
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    if (lum(body) < 0.06) body.lerp(new THREE.Color(1, 1, 1), 0.18);
    const light = lum(body) > 0.45;
    const border = body.clone().lerp(new THREE.Color(light ? 0 : 1, light ? 0 : 1, light ? 0 : 1), 0.22);
    return {
      body: '#' + body.getHexString(),
      border: '#' + border.getHexString(),
      pip: light ? '#22252b' : '#f6f1e6',
      // How hard a spent die may be darkened. A cream die can take the full
      // knock-down and still read; a dark one would go to near-black, so it
      // gets a gentler one.
      dim: light ? 0x6b6b6b : 0x9c9c9c
    };
  }

  // Point a die at its side's material set, building it on first use. Skins are
  // cached per die (never shared) because _placeDiceStatic dims a spent die by
  // tinting its materials — shared ones dimmed both dice at once.
  _setDieSkin(die, side) {
    side = (side === 'b') ? 'b' : 'w';
    if (die.skinRev !== this._skinRev) {
      // Drop the stale materials but KEEP the texture cache — a player toggling
      // between two colours should not repaint six canvases every time.
      Object.keys(die.skins).forEach(k => die.skins[k].forEach(m => m.dispose()));
      die.skins = {}; die.skinRev = this._skinRev; die.side = null;
    }
    if (!die.skins[side]) {
      const s = this._dieSkin(side);
      const faces = [];
      for (let v = 1; v <= 6; v++) faces.push(this._dieFace(v, s.body, s.pip, s.border));
      // BoxGeometry order: +x,-x,+y,-y,+z,-z → faces 3,4,1,6,2,5 (opposite faces sum 7)
      die.skins[side] = [2, 3, 0, 5, 1, 4].map(f => faces[f]);
      (die.dims || (die.dims = {}))[side] = s.dim;
    }
    if (die.side === side) return;
    die.side = side;
    die.dimHex = die.dims[side];
    die.mesh.material = die.skins[side];
    this.needsRender = true;
  }

  // One face of a die, painted in a given colour scheme. The canvas texture is
  // cached per (value, scheme) — there are only ever a handful of schemes in
  // play — but a FRESH material is returned each call so the two dice can be
  // dimmed independently while still sharing the underlying texture.
  _dieFace(v, bodyHex, pipHex, borderHex) {
    const key = v + '|' + bodyHex + '|' + pipHex + '|' + borderHex;
    if (!this._faceTex) this._faceTex = new Map();
    let tex = this._faceTex.get(key);
    if (!tex) {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d');
      ctx.fillStyle = bodyHex; ctx.fillRect(0, 0, 128, 128);
      ctx.strokeStyle = borderHex; ctx.lineWidth = 6; ctx.strokeRect(3, 3, 122, 122);
      ctx.fillStyle = pipHex;
      const dot = (x, y) => { ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill(); };
      const m = 64, d = 32;
      if (v % 2 === 1) dot(m, m);
      if (v > 1) { dot(m - d, m - d); dot(m + d, m + d); }
      if (v > 3) { dot(m + d, m - d); dot(m - d, m + d); }
      if (v === 6) { dot(m - d, m); dot(m + d, m); }
      tex = new THREE.CanvasTexture(c);
      this._faceTex.set(key, tex);
    }
    return new THREE.MeshLambertMaterial({ map: tex });
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
    // Markers for zones. Cyan = a legal destination for the checker you've got
    // selected; amber = a checker that still has a move to play.
    //
    // These used to be flat green discs — on a GREEN felt, which is about the
    // worst colour you could pick for "look here". Each marker is now a filled
    // disc inside a bright ring, in a cool colour that nothing else on the
    // board uses, and it pulses while it's up.
    this.highlightMeshes = [];
    const discGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.04, 24);
    const ringGeo = new THREE.TorusGeometry(0.36, 0.055, 10, 30);
    this.targetMat = new THREE.MeshBasicMaterial({ color: 0x6ef2ff, transparent: true, opacity: 0.45 });
    this.targetRingMat = new THREE.MeshBasicMaterial({ color: 0x9dfaff, transparent: true, opacity: 0.95 });
    this.sourceMat = new THREE.MeshBasicMaterial({ color: 0xffc83d, transparent: true, opacity: 0.25 });
    this.sourceRingMat = new THREE.MeshBasicMaterial({ color: 0xffd76b, transparent: true, opacity: 0.75 });
    for (let i = 0; i < 28; i++) {
      const g = new THREE.Group();
      const disc = new THREE.Mesh(discGeo, this.targetMat);
      const ring = new THREE.Mesh(ringGeo, this.targetRingMat);
      ring.rotation.x = Math.PI / 2;
      g.add(disc);
      g.add(ring);
      g.visible = false;
      this.group.add(g);
      this.highlightMeshes.push({ group: g, disc, ring });
    }
    this._hlOn = false;

    // Ring around the checker you have selected.
    this.selectRingMat = new THREE.MeshBasicMaterial({ color: 0xffd54a });
    this.selectRing = new THREE.Mesh(
      new THREE.TorusGeometry(this.CHK_R + 0.09, 0.055, 10, 28),
      this.selectRingMat
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
      // Dice on the felt belong to whoever is on roll, so they wear that side's
      // colour — EXCEPT the opening pair, which stays on the felt for the whole
      // first turn and is literally one die from each player.
      const sides = state.diceFromOpening ? ['w', 'b'] : state.turn;
      this._placeDiceStatic(state.dice[0], state.dice[1], state.movesLeft, sides);
    } else if (!state.dice && !this.rollAnim) {
      this.dice.forEach(d => { d.mesh.visible = false; });
    }
    this.needsRender = true;
  }

  // `sides` is the colour to skin the dice in: a single 'w'/'b' for a normal
  // roll, or a two-element array for the opening roll, where each player throws
  // one die. Omit it to leave the current skins alone.
  _placeDiceStatic(d1, d2, movesLeft, sides) {
    const used = (v) => {
      // Dim a die whose value has been fully consumed this turn.
      if (!movesLeft) return false;
      return movesLeft.indexOf(v) === -1;
    };
    // Remembered so setCheckerColors() can repaint and then restore this exact
    // presentation — rebuilding a skin hands back fresh, untinted materials, so
    // a recolour mid-turn would otherwise un-dim an already-played die.
    this._lastDice = { d1, d2, movesLeft, sides };
    const xs = [this.FELT_HALF_X * 0.45, this.FELT_HALF_X * 0.72];
    [d1, d2].forEach((v, i) => {
      const die = this.dice[i];
      const side = Array.isArray(sides) ? sides[i] : sides;
      if (side) this._setDieSkin(die, side);
      die.mesh.visible = true;
      die.mesh.position.set(xs[i], this.diceSize / 2 + 0.02, 0.4 - i * 0.9);
      die.mesh.quaternion.copy(this._dieQuatFor(v));
      const dim = used(v) && (d1 !== d2 || used(v));
      // Dim by DARKENING, not by going translucent. At 35% opacity you could
      // see the felt and the die's own far faces through it, which read as a
      // flat tile with no sides — the top number became unreadable on the die
      // furthest from the camera. Tinting the texture keeps the cube solid.
      die.mesh.material.forEach(m => {
        if (m.transparent) { m.transparent = false; m.needsUpdate = true; }
        m.opacity = 1;
        m.color.setHex(dim ? (die.dimHex || 0x6b6b6b) : 0xffffff);
      });
      die.body.position.set(100, 100 + i, 100);
    });
    this.needsRender = true;
  }

  // Physics tumble ending on known values; calls done() when settled.
  // A hidden tab pauses requestAnimationFrame, which would stall the whole
  // game flow behind this animation — so when the page is hidden (or becomes
  // hidden mid-roll: the watchdog below), skip straight to the result.
  //
  // `sides` skins the dice: 'w'/'b' for a normal roll, or ['w','b'] for the
  // opening roll so each player's single die shows in their own colour.
  animateRoll(d1, d2, done, sides) {
    const finishInstantly = () => {
      this.rollAnim = null;
      this._placeDiceStatic(d1, d2, null, sides);
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
      const side = Array.isArray(sides) ? sides[i] : sides;
      if (side) this._setDieSkin(die, side);
      die.mesh.visible = true;
      die.mesh.material.forEach(m => {
        if (m.transparent) { m.transparent = false; m.needsUpdate = true; }
        m.opacity = 1;
        m.color.setHex(0xffffff);
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
    this._paintZones(zones, 'target');
  }

  // Amber markers on the checkers that still have a legal move — shown while
  // nothing is picked up so it's never a mystery what the game is waiting for.
  highlightSources(zones) {
    this.legalTargets = [];
    this._paintZones(zones, 'source');
  }

  _stackCount(zone) {
    let n = 0;
    for (const c of this.checkers) if (c.visible && c.userData.zone === zone) n++;
    return n;
  }

  // Which slot an arriving checker would occupy. A lone opponent checker gets
  // hit and sent to the bar, so we'd land on an empty point.
  _landingSlot(zone) {
    const n = this._stackCount(zone);
    if (!n) return 0;
    const mine = this._offColor || 'w';
    let topColor = null;
    for (const c of this.checkers) {
      if (c.visible && c.userData.zone === zone) { topColor = c.userData.checkerColor; break; }
    }
    return topColor !== mine ? 0 : n;
  }

  _paintZones(zones, kind) {
    const isTarget = kind !== 'source';
    const discMat = isTarget ? this.targetMat : this.sourceMat;
    const ringMat = isTarget ? this.targetRingMat : this.sourceRingMat;
    this.highlightMeshes.forEach(h => { h.group.visible = false; });
    zones.forEach((z, i) => {
      if (i >= this.highlightMeshes.length) return;
      const h = this.highlightMeshes[i];
      h.disc.material = discMat;
      h.ring.material = ringMat;
      let p;
      if (z === 'off') p = new THREE.Vector3(this.trayX, 0.25, this._offSideZ());
      else if (z === 'bar') p = new THREE.Vector3(0, 0.55, 0);
      else {
        // Put the marker where the checker would actually LAND, on top of any
        // stack already there. The old fixed spot near the point's base sat
        // UNDER the second checker onwards — so the clearest moves of all,
        // stacking onto your own points, showed no visible dot whatsoever.
        const slot = isTarget ? this._landingSlot(z) : Math.max(0, this._stackCount(z) - 1);
        p = this._slotPos(z, slot, this._offColor || 'w');
        p.y += this.CHK_H + (isTarget ? 0.08 : 0.02);
      }
      h.group.position.copy(p);
      h.group.scale.set(1, 1, 1);
      h.group.visible = true;
    });
    // Only the cyan destination markers pulse. The amber "these can move" hints
    // are up for most of your turn, and pulsing those would keep the renderer
    // awake continuously — a real battery cost on a phone for no benefit.
    this._hlOn = isTarget && zones.length > 0;
    this.needsRender = true;
  }

  _offSideZ() {
    return this._offColor === 'b' ? -(this.DEPTH_HALF / 2 + 0.15) : this.DEPTH_HALF / 2 + 0.15;
  }

  // Which seat the LOCAL player occupies. Black sits opposite white, so their
  // board is the same board turned around: spin the whole group 180° and every
  // checker, point, highlight and tray follows, because they are all children
  // of it and all positioned in group-local space. The camera stays put.
  setPlayerColor(c) {
    this._offColor = c;
    this._applyBoardRotation();
    this.needsRender = true;
  }

  _applyBoardRotation() {
    const portraitTurn = this.portrait ? Math.PI / 2 : 0;
    const seatTurn = this._offColor === 'b' ? Math.PI : 0;
    this.group.rotation.y = portraitTurn + seatTurn;
  }

  showSelectRing(zone) {
    if (zone == null) { this.selectRing.visible = false; this.needsRender = true; return; }
    this.selectRingMat.color.set(0xffd54a);   // clear any leftover red flash
    this._blockedUntil = 0;
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
    this.highlightMeshes.forEach(h => { h.group.visible = false; });
    this.selectRing.visible = false;
    this._hlOn = false;
    this.needsRender = true;
  }

  // "This checker can't go anywhere." Flashes the ring red on the tapped point
  // so a dead checker gets an explicit answer instead of silence.
  flashBlocked(zone) {
    this.showSelectRing(zone);
    if (!this.selectRing.visible) return;
    this.selectRingMat.color.set(0xff5a5a);
    this._blockedUntil = performance.now() + 700;
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
      this.drag = {
        zone: hit.zone,
        mesh: hit.checker,
        homePos: hit.checker.position.clone(),
        targets,
        startX: e.clientX,
        startY: e.clientY,
        moved: false
      };
      // Capture AFTER drag is armed, and never let it throw: if this failed
      // (stale pointerId on some touch stacks) the press used to be swallowed
      // whole — no drag, no tap, no dots.
      try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch (err) {}
      // Do NOT paint this zone's targets yet. A press is not yet a drag, and if
      // it turns out to be a tap we may be completing a move into this zone —
      // repainting here would flash away the dots for the checker already
      // selected. _pointerMove paints them the moment a real drag begins.
      this.needsRender = true;
    } else {
      // Not draggable: treat as a tap (tap-to-move flow handled by controller).
      if (this.cb.onTap) this.cb.onTap(hit.zone);
    }
  }

  _pointerMove(e) {
    if (!this.drag) return;
    if (!this.drag.moved) {
      // Fingers and shaky mice emit pointermove during an intended tap. Below
      // this slop radius the press is still a tap, so don't promote it to a
      // drag (which would hand the press to onDrop and lose the tap-to-move).
      // Sized for touch: a thumb tap routinely wanders 10px+, and 6px was tight
      // enough that real taps were still being read as drags.
      const dx = e.clientX - this.drag.startX, dy = e.clientY - this.drag.startY;
      if (dx * dx + dy * dy < 196) return;
      this.drag.moved = true;
      // A real drag begins: it supersedes any tap-selection, and only now do
      // the green dots belong to the checker in hand.
      if (this.cb.onDragStart) this.cb.onDragStart(this.drag.zone);
      this.highlightTargets(this.drag.targets);
      this.selectRing.visible = false;
    }
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
      // Any press that did NOT complete a move falls back to a tap on its own
      // zone — so it selects that checker and lights its dots. Previously this
      // was gated on `!d.moved`, which meant a touch that wandered past the
      // slop radius and was released again over its own point produced no
      // dots at all: the drag highlights were cleared and nothing re-selected.
      if (this.cb.onTap) this.cb.onTap(d.zone);
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
    this._applyBoardRotation();
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
    this._camSeated.pos.set(0, dist * 0.86, dist * 0.62);
    this._camSeated.look.set(0, 0, this.portrait ? 0 : 0.4);

    // Overhead pose. Straight down means nothing is foreshortened any more, so
    // the short axis of the board suddenly needs its full height on screen —
    // fit BOTH axes here rather than reusing the seated distance, or the top
    // and bottom rails get cropped as the board tips up.
    const halfLong = long / 2;
    const halfShort = this.DEPTH_HALF + 0.6;
    const halfV = this.portrait ? halfLong : halfShort;  // screen vertical
    const halfH = this.portrait ? halfShort : halfLong;  // screen horizontal
    const hFovFlat = 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect);
    const flatDist = Math.max(halfV / Math.tan(fov / 2), halfH / Math.tan(hFovFlat / 2)) * 1.08;
    this._camFlat.pos.set(0, Math.max(flatDist, 13), 0);
    this._camFlat.look.set(0, 0, 0);

    this.camera.updateProjectionMatrix();
    this._applyCamera();
  }

  // Place the camera for the current _tilt. Positions are swung along an arc
  // rather than lerped in a straight line — a straight line would dive the
  // camera toward the felt halfway through and the board would lurch bigger.
  _applyCamera() {
    const a = this._camSeated, b = this._camFlat;
    const t = this._tilt;
    if (t <= 0) {
      this.camera.position.copy(a.pos);
      this.camera.lookAt(a.look);
    } else if (t >= 1) {
      this.camera.position.copy(b.pos);
      this.camera.lookAt(b.look);
    } else {
      const p = new THREE.Vector3().lerpVectors(a.pos, b.pos, t);
      p.setLength(a.pos.length() + (b.pos.length() - a.pos.length()) * t);
      this.camera.position.copy(p);
      this.camera.lookAt(
        a.look.x + (b.look.x - a.look.x) * t,
        a.look.y + (b.look.y - a.look.y) * t,
        a.look.z + (b.look.z - a.look.z) * t
      );
    }
    this.needsRender = true;
  }

  // Called by bg-game.js whenever the turn changes. `on` = it's this player's
  // turn, so lay the board flat and look straight down at it.
  setFlat(on) {
    const goal = on ? 1 : 0;
    if (goal === this._tiltGoal) return;
    this._tiltGoal = goal;
    // Start from wherever the camera actually is, so a turn that changes
    // mid-swing reverses smoothly instead of snapping.
    this._tiltFrom = this._tilt;
    this._tiltStart = performance.now();
  }

  _animate() {
    if (this.destroyed) return;
    requestAnimationFrame(() => this._animate());
    const now = performance.now();
    let busy = false;

    // Camera tilt toward the current goal
    if (this._tilt !== this._tiltGoal) {
      const raw = Math.min(1, (now - this._tiltStart) / this.TILT_MS);
      const e = raw * raw * (3 - 2 * raw);   // smoothstep: ease in and out
      this._tilt = this._tiltFrom + (this._tiltGoal - this._tiltFrom) * e;
      if (raw >= 1) this._tilt = this._tiltGoal;
      this._applyCamera();
      busy = true;
    }

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

    // Breathe the move markers so they read as "live" rather than as painted-on
    // board decoration. Only runs while markers are actually up.
    if (this._hlOn) {
      const s = 1 + Math.sin(now / 240) * 0.11;
      for (const h of this.highlightMeshes) {
        if (h.group.visible) h.group.scale.set(s, 1, s);
      }
      busy = true;
    }

    // Return the select ring to amber after a "no moves" flash.
    if (this._blockedUntil) {
      if (now >= this._blockedUntil) {
        this._blockedUntil = 0;
        this.selectRingMat.color.set(0xffd54a);
        this.selectRing.visible = false;
        this.needsRender = true;
      } else busy = true;
    }

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
