// dice3d.js
// 3D physics-based dice overlay using Three.js and Cannon-es

class Dice3D {
  constructor() {
    this.container = document.createElement('div');
    this.container.style.position = 'absolute';
    this.container.style.top = '0';
    this.container.style.left = '0';
    this.container.style.width = '100%';
    this.container.style.height = '100%';
    this.container.style.pointerEvents = 'none';
    this.container.style.zIndex = '999';
    const screenGame = document.getElementById('screen-game');
    if (screenGame) {
      screenGame.appendChild(this.container);
    } else {
      document.body.appendChild(this.container);
    }

    this.scene = new THREE.Scene();
    
    // Setup camera
    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.position.set(0, 15, 0);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio || 1); // sharp on HiDPI/retina
    this.container.appendChild(this.renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(10, 20, 10);
    this.scene.add(dirLight);

    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -40, 0) // Heavy gravity for snappy rolling
    });
    
    // Physics floor
    const floorShape = new CANNON.Plane();
    const floorBody = new CANNON.Body({ mass: 0 });
    floorBody.addShape(floorShape);
    floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(floorBody);

    // Physics walls to keep dice in a smaller bouncing area
    const wallShape = new CANNON.Plane();
    const wallTop = new CANNON.Body({ mass: 0 });
    wallTop.addShape(wallShape);
    wallTop.position.set(0, 0, -3.5);
    this.world.addBody(wallTop);

    const wallBottom = new CANNON.Body({ mass: 0 });
    wallBottom.addShape(wallShape);
    wallBottom.position.set(0, 0, 3.5);
    wallBottom.quaternion.setFromEuler(0, Math.PI, 0);
    this.world.addBody(wallBottom);

    const wallLeft = new CANNON.Body({ mass: 0 });
    wallLeft.addShape(wallShape);
    wallLeft.position.set(-2.5, 0, 0);
    wallLeft.quaternion.setFromEuler(0, Math.PI / 2, 0);
    this.world.addBody(wallLeft);

    const wallRight = new CANNON.Body({ mass: 0 });
    wallRight.addShape(wallShape);
    wallRight.position.set(2.5, 0, 0);
    wallRight.quaternion.setFromEuler(0, -Math.PI / 2, 0);
    this.world.addBody(wallRight);

    // Bouncy material
    const defaultMaterial = new CANNON.Material();
    const diceContactMaterial = new CANNON.ContactMaterial(defaultMaterial, defaultMaterial, {
      friction: 0.3,
      restitution: 0.5
    });
    this.world.addContactMaterial(diceContactMaterial);

    this.diceMeshes = [];
    this.diceBodies = [];
    this.normalMaterials = this.createDiceMaterials('#f8f8f8', '#e0e0e0', '#222222');
    this.heldMaterials = this.createDiceMaterials('#007BFF', '#0056b3', '#ffffff');
    
    for(let i = 0; i < 5; i++) {
      const size = 1.0;
      const geometry = new THREE.BoxGeometry(size, size, size);
      
      // BoxGeometry face order: right, left, top, bottom, front, back
      const mesh = new THREE.Mesh(geometry, [
        this.normalMaterials[2], // right - 3
        this.normalMaterials[3], // left - 4
        this.normalMaterials[0], // top - 1
        this.normalMaterials[5], // bottom - 6
        this.normalMaterials[1], // front - 2
        this.normalMaterials[4], // back - 5
      ]);
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.diceMeshes.push(mesh);
      
      const shape = new CANNON.Box(new CANNON.Vec3(size/2, size/2, size/2));
      const body = new CANNON.Body({ mass: 1, material: defaultMaterial });
      body.addShape(shape);
      this.world.addBody(body);
      this.diceBodies.push(body);
      
      // Hide initially
      body.position.set(100, 100, 100);
      mesh.position.copy(body.position);
    }
    
    this.rolling = false;
    this.settling = false;
    this.rollData = null;
    
    document.body.classList.add('dice3d-active');

    // Store the bound handler so destroy() can actually remove it (a fresh .bind()
    // can never be removed, which leaked a listener + the whole instance per re-init).
    this._onResize = this.onWindowResize.bind(this);
    window.addEventListener('resize', this._onResize);

    this.animate();
  }
  
  createDiceMaterials(bg = '#f8f8f8', border = '#e0e0e0', pipColor = '#222222') {
    const materials = [];
    for (let i = 1; i <= 6; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d');
      
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 256, 256);
      
      ctx.strokeStyle = border;
      ctx.lineWidth = 8;
      ctx.strokeRect(4, 4, 248, 248);
      
      ctx.fillStyle = pipColor;
      const drawPip = (x, y) => {
        ctx.beginPath();
        ctx.arc(x, y, 22, 0, Math.PI * 2);
        ctx.fill();
      };
      
      const c = 128;
      const d = 64; 
      
      if (i === 1 || i === 3 || i === 5) drawPip(c, c);
      if (i !== 1) {
        drawPip(c - d, c - d);
        drawPip(c + d, c + d);
      }
      if (i === 4 || i === 5 || i === 6) {
        drawPip(c + d, c - d);
        drawPip(c - d, c + d);
      }
      if (i === 6) {
        drawPip(c - d, c);
        drawPip(c + d, c);
      }
      
      const texture = new THREE.CanvasTexture(canvas);
      materials.push(new THREE.MeshLambertMaterial({ map: texture }));
    }
    return materials;
  }
  
  onWindowResize() {
    if (this.destroyed) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
  }
  
  get3DTarget(x, y, targetSize) {
    const ndcX = (x / window.innerWidth) * 2 - 1;
    const ndcY = -(y / window.innerHeight) * 2 + 1;
    
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    
    // Intersect plane at Y = targetSize / 2 so the center perfectly matches the UI
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(targetSize / 2));
    const target = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, target);
    
    return target;
  }
  
  getTargetRotation(value) {
    const rot = new THREE.Euler();
    switch(value) {
      case 1: rot.set(0, 0, 0); break;
      case 6: rot.set(Math.PI, 0, 0); break;
      case 2: rot.set(-Math.PI/2, 0, 0); break;
      case 5: rot.set(Math.PI/2, 0, 0); break;
      case 3: rot.set(0, 0, Math.PI/2); break;
      case 4: rot.set(0, 0, -Math.PI/2); break;
      default: console.warn('getTargetRotation: unexpected die value', value); break;
    }
    return new THREE.Quaternion().setFromEuler(rot);
  }
  
  roll(finalValues, unheldIndices, targetElements, onComplete) {
    this.rolling = true;
    this.settling = false;
    this.rollStartTime = performance.now();
    
    this.rollData = {
      finalValues,
      unheldIndices,
      targets: [],
      onComplete,
      startLerpQuats: [],
      startLerpPos: [],
      // Persist these so the roll-completion path can build a valid snapData.
      // Previously they were omitted, so snapData.targetElements was undefined and
      // _applySnap() threw a TypeError every frame after a roll, freezing the canvas.
      targetElements,
      heldState: [0, 1, 2, 3, 4].map(i => !unheldIndices.includes(i))
    };
    
    for (let i = 0; i < 5; i++) {
      const el = targetElements[i];
      let targetPos = new THREE.Vector3(100, 100, 100);
      let targetSize = 1.0;
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0) {
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          
          // Calculate exact 3D size to match pixel width
          const vFov = (this.camera.fov * Math.PI) / 180;
          const visibleHeight = 2 * Math.tan(vFov / 2) * this.camera.position.y;
          const pixelsPerUnit = window.innerHeight / visibleHeight;
          targetSize = rect.width / pixelsPerUnit;
          
          targetPos = this.get3DTarget(centerX, centerY, targetSize);
        }
      }
      
      this.diceMeshes[i].scale.setScalar(targetSize);
      
      // Update physics shape to match visual scale
      this._resizeBodyShape(this.diceBodies[i], targetSize);

      const targetRot = this.getTargetRotation(finalValues[i]);
      this.rollData.targets.push({ pos: targetPos, rot: targetRot });
      
      if (unheldIndices.includes(i)) {
        // Assign normal materials
        this.diceMeshes[i].material = [
          this.normalMaterials[2], this.normalMaterials[3], this.normalMaterials[0],
          this.normalMaterials[5], this.normalMaterials[1], this.normalMaterials[4]
        ];
        
        // Spawn inside camera view (near Y=8-12) so there's no lag before they appear
        this.diceBodies[i].position.set(
          (Math.random() - 0.5) * 3,
          8 + Math.random() * 4,
          (Math.random() - 0.5) * 3
        );
        this.diceBodies[i].velocity.set(
          (Math.random() - 0.5) * 6,
          -15,
          (Math.random() - 0.5) * 6
        );
        this.diceBodies[i].angularVelocity.set(
          Math.random() * 20,
          Math.random() * 20,
          Math.random() * 20
        );
        this.diceBodies[i].type = CANNON.Body.DYNAMIC;
        this.diceBodies[i].wakeUp();
      } else {
        // Assign held materials (blue tint)
        this.diceMeshes[i].material = [
          this.heldMaterials[2], this.heldMaterials[3], this.heldMaterials[0],
          this.heldMaterials[5], this.heldMaterials[1], this.heldMaterials[4]
        ];
        
        // Snap held dice directly to their spot
        this.diceBodies[i].type = CANNON.Body.KINEMATIC;
        this.diceBodies[i].position.copy(targetPos);
        this.diceBodies[i].quaternion.copy(targetRot);
        this.diceBodies[i].velocity.set(0,0,0);
        this.diceBodies[i].angularVelocity.set(0,0,0);
        
        this.diceMeshes[i].position.copy(targetPos);
        this.diceMeshes[i].quaternion.copy(targetRot);
      }
    }
  }
  
  snapToState(finalValues, heldState, targetElements) {
    this.rolling = false;
    this.settling = false;
    this.snapData = { finalValues, heldState, targetElements };
    this._applySnap();
  }
  
  _applySnap() {
    if (!this.snapData) return;
    const { finalValues, heldState, targetElements } = this.snapData;
    for (let i = 0; i < 5; i++) {
      const el = targetElements[i];
      if (!el) {
        this.diceBodies[i].position.set(100, 100, 100);
        this.diceMeshes[i].position.set(100, 100, 100);
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) {
        this.diceBodies[i].position.set(100, 100, 100);
        this.diceMeshes[i].position.set(100, 100, 100);
        continue;
      }
      
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      const vFov = (this.camera.fov * Math.PI) / 180;
      const visibleHeight = 2 * Math.tan(vFov / 2) * this.camera.position.y;
      const pixelsPerUnit = window.innerHeight / visibleHeight;
      const targetSize = rect.width / pixelsPerUnit;
      
      this.diceMeshes[i].scale.setScalar(targetSize);
      this._resizeBodyShape(this.diceBodies[i], targetSize);

      const targetPos = this.get3DTarget(centerX, centerY, targetSize);
      const targetRot = this.getTargetRotation(finalValues[i]);
      
      this.diceBodies[i].type = CANNON.Body.KINEMATIC;
      this.diceBodies[i].position.copy(targetPos);
      this.diceBodies[i].quaternion.copy(targetRot);
      this.diceBodies[i].velocity.set(0,0,0);
      this.diceBodies[i].angularVelocity.set(0,0,0);
      
      
      this.diceMeshes[i].material = heldState && heldState[i] ? [
        this.heldMaterials[2], this.heldMaterials[3], this.heldMaterials[0],
        this.heldMaterials[5], this.heldMaterials[1], this.heldMaterials[4]
      ] : [
        this.normalMaterials[2], this.normalMaterials[3], this.normalMaterials[0],
        this.normalMaterials[5], this.normalMaterials[1], this.normalMaterials[4]
      ];
      
      this.diceMeshes[i].position.copy(targetPos);
      this.diceMeshes[i].quaternion.copy(targetRot);
    }
  }
  // Swap a body's box shape to a new size WITHOUT leaving Cannon's cached
  // bounding radius / inertia stale (which could cause missed collisions).
  _resizeBodyShape(body, targetSize) {
    body.shapes[0] = new CANNON.Box(new CANNON.Vec3(targetSize/2, targetSize/2, targetSize/2));
    if (typeof body.updateBoundingRadius === 'function') body.updateBoundingRadius();
    if (typeof body.updateMassProperties === 'function') body.updateMassProperties();
    if (typeof body.computeAABB === 'function') body.computeAABB();
  }

  destroy() {
    this.destroyed = true;

    // Remove the resize listener (using the stored bound reference).
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }

    // Dispose GPU resources so WebGL contexts / buffers don't leak across re-inits.
    try {
      (this.diceMeshes || []).forEach(mesh => {
        if (mesh.geometry) mesh.geometry.dispose();
      });
      [this.normalMaterials, this.heldMaterials].forEach(set => {
        (set || []).forEach(mat => {
          if (mat.map) mat.map.dispose();
          mat.dispose();
        });
      });
      if (this.renderer) {
        this.renderer.dispose();
        if (this.renderer.forceContextLoss) this.renderer.forceContextLoss();
      }
    } catch (e) {
      console.warn('Dice3D destroy cleanup error:', e);
    }

    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    document.body.classList.remove('dice3d-active');
  }

  animate() {
    if (this.destroyed) return;
    requestAnimationFrame(this.animate.bind(this));
    
    if (this.rolling && !this.settling) {
      this.world.step(1 / 60);
      
      for (let i of this.rollData.unheldIndices) {
        this.diceMeshes[i].position.copy(this.diceBodies[i].position);
        this.diceMeshes[i].quaternion.copy(this.diceBodies[i].quaternion);
      }
      
      const elapsed = performance.now() - this.rollStartTime;
      if (elapsed > 1500) {
        this.settling = true;
        this.settleStartTime = performance.now();
        for (let i of this.rollData.unheldIndices) {
          this.diceBodies[i].type = CANNON.Body.KINEMATIC;
          this.diceBodies[i].velocity.set(0,0,0);
          this.diceBodies[i].angularVelocity.set(0,0,0);
          this.rollData.startLerpPos[i] = this.diceMeshes[i].position.clone();
          this.rollData.startLerpQuats[i] = this.diceMeshes[i].quaternion.clone();
        }
      }
    } else if (this.settling) {
      const elapsed = performance.now() - this.settleStartTime;
      const duration = 500;
      let t = elapsed / duration;
      if (t >= 1) {
        t = 1;
      }
      
      const easeT = 1 - Math.pow(1 - t, 3);
      
      for (let i of this.rollData.unheldIndices) {
        const startPos = this.rollData.startLerpPos[i];
        const startQuat = this.rollData.startLerpQuats[i];
        const targetPos = this.rollData.targets[i].pos;
        const targetRot = this.rollData.targets[i].rot;
        
        this.diceMeshes[i].position.lerpVectors(startPos, targetPos, easeT);
        this.diceMeshes[i].quaternion.slerpQuaternions(startQuat, targetRot, easeT);
        
        this.diceBodies[i].position.copy(this.diceMeshes[i].position);
        this.diceBodies[i].quaternion.copy(this.diceMeshes[i].quaternion);
      }
      
      if (t >= 1) {
        this.rolling = false;
        this.settling = false;
        this.snapData = {
          finalValues: this.rollData.finalValues,
          heldState: this.rollData.heldState,
          targetElements: this.rollData.targetElements
        };
        if (this.rollData.onComplete) {
          this.rollData.onComplete();
        }
      }
    } else if (!this.rolling && !this.settling && this.snapData) {
      this._applySnap();
    }
    
    this.renderer.render(this.scene, this.camera);
  }
}

window.addEventListener('load', () => {
  window.dice3d = new Dice3D();
});
