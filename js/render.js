/*
 * Cellular Drift — render: Three.js scene graph, semantic entity views,
 * camera, lighting, VFX, quality tiers. Consumes immutable rules snapshots
 * plus an interpolation alpha; never mutates rules state.
 *
 * Presentation: a translucent microscopic world of soft membranes, viewed
 * top-down through an orthographic camera so DOM labels align exactly with
 * projected world targets.
 */
import * as THREE from 'three';

export const CAM = {
  FOLLOW_RATE: 6.5,      // critically damped follow stiffness
  ZOOM_RATE: 4.0,
  MIN_HALF_H: 80,
  MAX_HALF_H: 900,
  MASS_ZOOM: 3.6,        // extra view height per unit of player radius
  BASE_HALF_H: 46
};

const TIER_DPR = { low: 1, medium: 1.5, high: 2 };
const TIER_PARTICLES = { low: 150, medium: 500, high: 1200 };
const TIER_DECOR = { low: 40, medium: 110, high: 220 };

export function createRenderer(canvas, opts) {
  const options = Object.assign({ onContextLost: null, onContextRestored: null }, opts || {});
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (e) {
    if (options.onContextLost) options.onContextLost('unavailable');
    throw e;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
  camera.position.set(0, 0, 1000);
  camera.lookAt(0, 0, 0);

  // layers: 0 environment, 1 gameplay, 2 selection/ghosts, 3 effects, 4 UI anchors
  camera.layers.enable(0); camera.layers.enable(1); camera.layers.enable(2);
  camera.layers.enable(3); camera.layers.enable(4);

  // ---------- lighting: one dominant key, soft fill
  const ambient = new THREE.AmbientLight(0xffffff, 0.75);
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(-0.4, 0.6, 1);
  scene.add(ambient, key);

  // ---------- theme
  let theme = {
    bg: '#071c26', bgDeep: '#03101a', membrane: '#4fd8c2', player: '#ffd166',
    motes: ['#9bf6e4', '#6ee7d8', '#c5fff3'], barb: '#ff6b81',
    fog: 'rgba(7,28,38,0.55)', grid: 'rgba(120,220,210,0.07)'
  };
  let cvdPatch = null;
  let highContrast = false;
  let reducedMotion = false;
  let tier = 'high';
  let decorSeed = 1;

  // ---------- environment: arena floor + boundary + membrane grid
  const envGroup = new THREE.Group();
  envGroup.layers.set(0);
  scene.add(envGroup);
  let floorMesh = null, boundMesh = null, gridMesh = null, outsideMesh = null;

  function themeColor(c) { return new THREE.Color(c); }

  function buildEnvironment(arenaRadius) {
    for (const m of [floorMesh, boundMesh, gridMesh, outsideMesh]) {
      if (m) { envGroup.remove(m); m.geometry.dispose(); if (m.material.map) m.material.map.dispose(); m.material.dispose(); }
    }
    // radial gradient floor texture (procedural, seeded decoration)
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
    grad.addColorStop(0, theme.bg);
    grad.addColorStop(1, theme.bgDeep);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    // seeded membrane blotches
    let s = decorSeed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    g.globalAlpha = 0.05;
    for (let i = 0; i < 26; i++) {
      const r = 20 + rnd() * 90;
      const bx = rnd() * size, by = rnd() * size;
      const bg2 = g.createRadialGradient(bx, by, 1, bx, by, r);
      bg2.addColorStop(0, theme.membrane);
      bg2.addColorStop(1, 'transparent');
      g.fillStyle = bg2;
      g.beginPath(); g.arc(bx, by, r, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;

    floorMesh = new THREE.Mesh(
      new THREE.CircleGeometry(arenaRadius, 96),
      new THREE.MeshBasicMaterial({ map: tex })
    );
    floorMesh.position.z = -10;
    envGroup.add(floorMesh);

    // dark surround outside the dish
    outsideMesh = new THREE.Mesh(
      new THREE.RingGeometry(arenaRadius, arenaRadius * 4, 96),
      new THREE.MeshBasicMaterial({ color: themeColor(theme.bgDeep) })
    );
    outsideMesh.position.z = -9;
    envGroup.add(outsideMesh);

    // dish boundary: glowing rim
    boundMesh = new THREE.Mesh(
      new THREE.RingGeometry(arenaRadius - 2.5, arenaRadius + 2.5, 128),
      new THREE.MeshBasicMaterial({ color: themeColor(theme.membrane), transparent: true, opacity: highContrast ? 0.95 : 0.6, side: THREE.DoubleSide })
    );
    boundMesh.position.z = -8;
    envGroup.add(boundMesh);

    // faint concentric membrane rings (depth cue)
    const rings = [];
    for (let i = 1; i <= 4; i++) {
      const rr = (arenaRadius * i) / 5;
      const ring = new THREE.RingGeometry(rr - 0.8, rr + 0.8, 96);
      rings.push(ring);
    }
    const merged = mergeGeometries(rings);
    gridMesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
      color: themeColor(theme.membrane), transparent: true, opacity: highContrast ? 0.22 : 0.1, side: THREE.DoubleSide
    }));
    gridMesh.position.z = -8.5;
    envGroup.add(gridMesh);
  }

  // minimal ring-merge (rings are the only merged static geometry)
  function mergeGeometries(geoms) {
    let pos = [], idx = [], off = 0;
    for (const g of geoms) {
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
      const gi = g.getIndex();
      for (let i = 0; i < gi.count; i++) idx.push(gi.getX(i) + off);
      off += p.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setIndex(idx);
    return out;
  }

  // ---------- cells (semantic views, pooled per entity id)
  const cellGeo = new THREE.SphereGeometry(1, 28, 20);
  const nucleusGeo = new THREE.SphereGeometry(1, 14, 10);
  const rimGeo = new THREE.RingGeometry(0.94, 1.06, 48);
  const cellViews = new Map(); // entityId -> {group, outer, nucleus, rim, hueKey}
  const materialCache = new Map();

  function membraneMaterial(hue, isPlayer) {
    const key = hue + (isPlayer ? 'p' : '') + (highContrast ? 'h' : '');
    if (materialCache.has(key)) return materialCache.get(key);
    const base = isPlayer ? themeColor(theme.player) : new THREE.Color().setHSL(hue / 360, highContrast ? 0.95 : 0.62, highContrast ? 0.6 : 0.55);
    const mat = new THREE.MeshPhongMaterial({
      color: base,
      transparent: true,
      opacity: highContrast ? 0.95 : 0.82,
      shininess: 90,
      specular: new THREE.Color(0xffffff).multiplyScalar(0.55),
      emissive: base.clone().multiplyScalar(0.16)
    });
    materialCache.set(key, mat);
    return mat;
  }

  function makeCellView(hue, isPlayer) {
    const group = new THREE.Group();
    const outer = new THREE.Mesh(cellGeo, membraneMaterial(hue, isPlayer));
    outer.scale.z = 0.42;
    group.add(outer);
    const nuc = new THREE.Mesh(nucleusGeo, new THREE.MeshBasicMaterial({
      color: themeColor('#ffffff'), transparent: true, opacity: highContrast ? 0.55 : 0.3
    }));
    nuc.scale.set(0.34, 0.34, 0.2);
    nuc.position.z = 0.2;
    group.add(nuc);
    const rim = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({
      color: isPlayer ? themeColor(theme.player) : new THREE.Color().setHSL(hue / 360, 0.8, 0.7),
      transparent: true, opacity: 0, side: THREE.DoubleSide
    }));
    rim.position.z = 0.5;
    rim.layers.set(2);
    group.add(rim);
    group.layers.set(1);
    scene.add(group);
    return { group, outer, nucleus: nuc, rim, hue, isPlayer };
  }

  // ---------- motes & pellets (instanced)
  const MAX_MOTES = 420, MAX_PELLETS = 160;
  const moteMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.5, 1), new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 40, emissive: 0x333333 }), MAX_MOTES);
  const pelletMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.9, 1), new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 60, emissive: 0x444444 }), MAX_PELLETS);
  moteMesh.layers.set(1); pelletMesh.layers.set(1);
  moteMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pelletMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(moteMesh, pelletMesh);

  // ---------- barbs (spiked hazard clusters)
  function barbGeometry() {
    const shape = new THREE.Shape();
    const spikes = 9;
    for (let i = 0; i < spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2;
      const r = i % 2 === 0 ? 1 : 0.42;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    shape.closePath();
    return new THREE.ExtrudeGeometry(shape, { depth: 0.35, bevelEnabled: false });
  }
  const barbGeo = barbGeometry();
  const barbViews = new Map();

  // ---------- decorative drift particles (never raycast; cosmetic only)
  let decorPoints = null;
  function buildDecor(arenaRadius) {
    if (decorPoints) { scene.remove(decorPoints); decorPoints.geometry.dispose(); decorPoints.material.dispose(); }
    const n = TIER_DECOR[tier] || 100;
    const pos = new Float32Array(n * 3);
    let s = decorSeed ^ 0x5f3759df;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * arenaRadius;
      pos[i * 3] = Math.cos(a) * d;
      pos[i * 3 + 1] = Math.sin(a) * d;
      pos[i * 3 + 2] = -6 + rnd() * 10;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    decorPoints = new THREE.Points(geo, new THREE.PointsMaterial({
      color: themeColor(theme.membrane), size: 2.2, transparent: true, opacity: 0.35, sizeAttenuation: false
    }));
    decorPoints.layers.set(0);
    scene.add(decorPoints);
  }

  // ---------- effect particles (pooled, bounded by tier)
  const MAX_FX = 1200;
  const fxGeo = new THREE.BufferGeometry();
  const fxPos = new Float32Array(MAX_FX * 3);
  fxGeo.setAttribute('position', new THREE.BufferAttribute(fxPos, 3));
  const fxPoints = new THREE.Points(fxGeo, new THREE.PointsMaterial({
    color: 0xffffff, size: 3, transparent: true, opacity: 0.9, sizeAttenuation: true
  }));
  fxPoints.layers.set(3);
  fxPoints.frustumCulled = false;
  scene.add(fxPoints);
  const fx = { x: new Float32Array(MAX_FX), y: new Float32Array(MAX_FX), vx: new Float32Array(MAX_FX), vy: new Float32Array(MAX_FX), life: new Float32Array(MAX_FX), n: 0 };
  const fxColor = new THREE.Color(0xffffff);

  function spawnFx(x, y, count, color, speed) {
    if (reducedMotion) count = Math.min(count, 3);
    const cap = TIER_PARTICLES[tier] || MAX_FX;
    fxPoints.material.color.set(color);
    fxColor.set(color);
    for (let i = 0; i < count && fx.n < cap; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.3 + Math.random() * 0.7) * (speed || 5);
      fx.x[fx.n] = x; fx.y[fx.n] = y;
      fx.vx[fx.n] = Math.cos(a) * sp; fx.vy[fx.n] = Math.sin(a) * sp;
      fx.life[fx.n] = 0.5 + Math.random() * 0.4;
      fx.n++;
    }
  }

  function updateFx(dt) {
    let i = 0;
    while (i < fx.n) {
      fx.life[i] -= dt;
      if (fx.life[i] <= 0) { // swap-remove
        const l = --fx.n;
        fx.x[i] = fx.x[l]; fx.y[i] = fx.y[l]; fx.vx[i] = fx.vx[l]; fx.vy[i] = fx.vy[l]; fx.life[i] = fx.life[l];
        continue;
      }
      fx.x[i] += fx.vx[i]; fx.y[i] += fx.vy[i];
      fx.vx[i] *= 0.94; fx.vy[i] *= 0.94;
      i++;
    }
    for (let k = 0; k < fx.n; k++) {
      fxPos[k * 3] = fx.x[k]; fxPos[k * 3 + 1] = fx.y[k]; fxPos[k * 3 + 2] = 4;
    }
    fxGeo.setDrawRange(0, fx.n);
    fxGeo.attributes.position.needsUpdate = true;
  }

  // ---------- goal marker & hint arrow (selection/ghost layer)
  const markerGroup = new THREE.Group();
  markerGroup.layers.set(2);
  const markerRing = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), new THREE.MeshBasicMaterial({
    color: 0xfff3a0, transparent: true, opacity: 0.85, side: THREE.DoubleSide
  }));
  markerGroup.add(markerRing);
  markerGroup.visible = false;
  scene.add(markerGroup);

  const hintGroup = new THREE.Group();
  hintGroup.layers.set(2);
  const hintRing = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32), new THREE.MeshBasicMaterial({
    color: 0x9be8ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide
  }));
  hintGroup.add(hintRing);
  hintGroup.visible = false;
  scene.add(hintGroup);

  // ---------- camera state
  const camState = { x: 0, y: 0, halfH: 120, shake: 0, shakeT: 0 };
  let arenaRadius = 600;
  let aspect = 1;

  function resize() {
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 1;
    const h = canvas.clientHeight || canvas.parentElement.clientHeight || 1;
    aspect = w / h;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TIER_DPR[tier] || 2));
    renderer.setSize(w, h, false);
    updateCameraFrustum();
  }

  function updateCameraFrustum() {
    camera.left = -camState.halfH * aspect;
    camera.right = camState.halfH * aspect;
    camera.top = camState.halfH;
    camera.bottom = -camState.halfH;
    camera.updateProjectionMatrix();
  }

  // ---------- entity interpolation store
  let prevMap = new Map(), currMap = new Map();
  let lastState = null;

  function entityMap(state) {
    const m = new Map();
    for (const c of state.cells) m.set('c' + c.id, { x: c.x, y: c.y, mass: c.mass, playerId: c.playerId });
    for (const mo of state.motes) m.set('m' + mo.id, { x: mo.x, y: mo.y });
    for (const pe of state.pellets) m.set('e' + pe.id, { x: pe.x, y: pe.y });
    return m;
  }

  // Called on every simulation tick with the new immutable-ish snapshot.
  function syncState(state) {
    prevMap = currMap;
    currMap = entityMap(state);
    // pop effects for vanished entities
    if (prevMap.size) {
      for (const [id, p] of prevMap) {
        if (!currMap.has(id)) {
          const isCell = id[0] === 'c';
          spawnFx(p.x, p.y, isCell ? 14 : 4, isCell ? '#ffffff' : theme.motes[0], isCell ? 8 : 3);
        }
      }
    }
    lastState = state;
    if (state.arena.radius !== arenaRadius) {
      arenaRadius = state.arena.radius;
      buildEnvironment(arenaRadius);
      buildDecor(arenaRadius);
      syncBarbs(state);
    }
  }

  function syncBarbs(state) {
    for (const [id, v] of barbViews) { scene.remove(v); }
    barbViews.clear();
    for (const b of state.barbs) {
      const mat = new THREE.MeshPhongMaterial({
        color: themeColor(theme.barb), shininess: 30,
        emissive: themeColor(theme.barb).multiplyScalar(0.25)
      });
      const mesh = new THREE.Mesh(barbGeo, mat);
      mesh.scale.setScalar(b.radius);
      mesh.position.set(b.x, b.y, 0.5);
      mesh.layers.set(1);
      scene.add(mesh);
      barbViews.set(b.id, mesh);
    }
  }

  function lerpPos(id, alpha) {
    const c = currMap.get(id);
    if (!c) return null;
    const p = prevMap.get(id);
    if (!p) return c;
    return { x: p.x + (c.x - p.x) * alpha, y: p.y + (c.y - p.y) * alpha, mass: c.mass, playerId: c.playerId };
  }

  const dummy = new THREE.Object3D();

  // ---------- per-frame draw
  let time = 0;
  function draw(alpha, dt, focus, localPlayerId) {
    time += dt;
    if (!lastState) { renderer.render(scene, camera); return; }
    const state = lastState;

    // camera follow with critically damped smoothing (never cumulative lerp drift)
    if (focus) {
      const k = 1 - Math.exp(-CAM.FOLLOW_RATE * dt);
      camState.x += (focus.x - camState.x) * k;
      camState.y += (focus.y - camState.y) * k;
      const targetHalf = Math.max(CAM.MIN_HALF_H, Math.min(CAM.MAX_HALF_H, CAM.BASE_HALF_H + focus.radius * CAM.MASS_ZOOM * 8));
      const kz = 1 - Math.exp(-CAM.ZOOM_RATE * dt);
      if (Math.abs(targetHalf - camState.halfH) > 0.5) {
        camState.halfH += (targetHalf - camState.halfH) * kz;
        updateCameraFrustum();
      }
    }
    // camera shake: low amplitude, event-tiered, never changes raycast truth
    let shX = 0, shY = 0;
    if (camState.shake > 0 && !reducedMotion) {
      camState.shakeT += dt * 40;
      const amp = camState.shake * Math.exp(-camState.shakeT * 0.12);
      shX = Math.sin(camState.shakeT * 1.7) * amp;
      shY = Math.cos(camState.shakeT * 2.3) * amp;
      if (amp < 0.05) camState.shake = 0;
    }
    camera.position.x = camState.x + shX;
    camera.position.y = camState.y + shY;

    // cells
    const seen = new Set();
    for (const c of state.cells) {
      const key = 'c' + c.id;
      seen.add(key);
      let view = cellViews.get(c.id);
      const isPlayer = c.playerId === localPlayerId;
      const playerHue = hueOf(state, c.playerId);
      if (!view) {
        view = makeCellView(playerHue, isPlayer);
        cellViews.set(c.id, view);
      }
      const pos = lerpPos(key, alpha) || c;
      const r = Math.sqrt(c.mass) * 1.2;
      // soft membrane breathing (deterministic phase per entity)
      const breathe = reducedMotion ? 1 : 1 + Math.sin(time * 2.1 + c.id * 1.7) * 0.02;
      view.group.position.set(pos.x, pos.y, 0);
      view.outer.scale.set(r * breathe, r / breathe, r * 0.42);
      view.nucleus.scale.set(r * 0.34, r * 0.34, r * 0.2);
      view.rim.scale.setScalar(r);
      // selection/ownership cue: rim on local player cells, pulsing grounded marker
      view.rim.material.opacity = isPlayer ? (reducedMotion ? 0.7 : 0.45 + Math.sin(time * 3) * 0.2) : 0;
    }
    for (const [id, view] of cellViews) {
      if (!seen.has('c' + id)) {
        scene.remove(view.group);
        cellViews.delete(id);
      }
    }

    // motes (instanced)
    let mi = 0;
    const moteScale = 1 + (reducedMotion ? 0 : Math.sin(time * 2.4) * 0.12);
    for (const mo of state.motes) {
      if (mi >= MAX_MOTES) break;
      const pos = lerpPos('m' + mo.id, alpha) || mo;
      dummy.position.set(pos.x, pos.y, 0.2);
      dummy.scale.setScalar(moteScale);
      dummy.rotation.set(0, 0, mo.id);
      dummy.updateMatrix();
      moteMesh.setMatrixAt(mi++, dummy.matrix);
    }
    moteMesh.count = mi;
    moteMesh.instanceMatrix.needsUpdate = true;
    moteMesh.material.color.set(theme.motes[0]);
    moteMesh.material.emissive.set(theme.motes[1]).multiplyScalar(0.25);

    // pellets (instanced)
    let pi = 0;
    for (const pe of state.pellets) {
      if (pi >= MAX_PELLETS) break;
      const pos = lerpPos('e' + pe.id, alpha) || pe;
      dummy.position.set(pos.x, pos.y, 0.3);
      dummy.scale.setScalar(1);
      dummy.rotation.set(0, 0, pe.id * 0.7);
      dummy.updateMatrix();
      pelletMesh.setMatrixAt(pi++, dummy.matrix);
    }
    pelletMesh.count = pi;
    pelletMesh.instanceMatrix.needsUpdate = true;
    pelletMesh.material.color.set(theme.motes[2] || '#ffffff');

    // barbs: slow menacing spin
    if (!reducedMotion) {
      for (const [, v] of barbViews) v.rotation.z += dt * 0.35;
    }

    // goal marker pulse
    if (markerGroup.visible) {
      const baseR = markerGroup.userData.radius || 40;
      const s = reducedMotion ? 1 : 1 + Math.sin(time * 2.6) * 0.08;
      markerGroup.scale.setScalar(baseR * s);
    }
    if (hintGroup.visible && !reducedMotion) {
      hintGroup.scale.setScalar(6 * (1 + Math.sin(time * 4) * 0.15));
    }

    // decor drift
    if (decorPoints && !reducedMotion) {
      decorPoints.rotation.z = time * 0.008;
    }

    updateFx(dt);
    renderer.render(scene, camera);
  }

  function hueOf(state, playerId) {
    for (const p of state.players) if (p.id === playerId) return p.hue;
    return 0;
  }

  // ---------- public helpers
  function worldToScreen(x, y) {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    return {
      x: ((x - camera.position.x) / (camState.halfH * aspect) * 0.5 + 0.5) * w,
      y: (0.5 - (y - camera.position.y) / camState.halfH * 0.5) * h
    };
  }
  function screenToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const nx = (clientX - rect.left) / Math.max(1, rect.width);
    const ny = (clientY - rect.top) / Math.max(1, rect.height);
    return {
      x: camera.position.x + (nx - 0.5) * 2 * camState.halfH * aspect,
      y: camera.position.y + (0.5 - ny) * 2 * camState.halfH
    };
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (options.onContextLost) options.onContextLost('lost');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    if (options.onContextRestored) options.onContextRestored();
  });

  return {
    resize,
    syncState,
    draw,
    worldToScreen,
    screenToWorld,
    setTheme(t, patch) {
      theme = Object.assign({}, t);
      if (patch) {
        theme.membrane = patch.membrane; theme.player = patch.player;
        theme.barb = patch.barb; theme.motes = patch.motes;
      }
      cvdPatch = patch || null;
      materialCache.forEach((m) => m.dispose());
      materialCache.clear();
      for (const [id, v] of cellViews) { scene.remove(v.group); }
      cellViews.clear();
      scene.background = themeColor(theme.bgDeep);
      if (lastState) {
        buildEnvironment(arenaRadius);
        buildDecor(arenaRadius);
        syncBarbs(lastState);
      }
    },
    setTier(t2) {
      tier = TIER_DPR[t2] ? t2 : 'high';
      resize();
      if (lastState) buildDecor(arenaRadius);
    },
    setReducedMotion(v) { reducedMotion = v; },
    setHighContrast(v) {
      highContrast = v;
      materialCache.forEach((m) => m.dispose());
      materialCache.clear();
      for (const [id, view] of cellViews) { scene.remove(view.group); }
      cellViews.clear();
      if (lastState) { buildEnvironment(arenaRadius); syncBarbs(lastState); }
    },
    setDecorSeed(seed) { decorSeed = seed >>> 0; },
    setMarker(x, y, radius) {
      if (x == null) { markerGroup.visible = false; return; }
      markerGroup.visible = true;
      markerGroup.position.set(x, y, 0.4);
      markerGroup.userData.radius = radius || 40;
      markerGroup.scale.setScalar(radius || 40);
    },
    setHint(x, y) {
      if (x == null) { hintGroup.visible = false; return; }
      hintGroup.visible = true;
      hintGroup.position.set(x, y, 0.6);
      hintGroup.scale.setScalar(6);
    },
    shake(amount) { if (!reducedMotion) { camState.shake = Math.min(6, amount); camState.shakeT = 0; } },
    snapCamera(x, y, halfH) {
      camState.x = x; camState.y = y;
      if (halfH) { camState.halfH = halfH; updateCameraFrustum(); }
    },
    get cameraState() { return camState; },
    dispose() {
      renderer.dispose();
      materialCache.forEach((m) => m.dispose());
    }
  };
}
