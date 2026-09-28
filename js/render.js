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
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { detectPreset, describe, resolve, SHADOW_MAP } from './gfx.js';

export const CAM = {
  FOLLOW_RATE: 6.5,      // critically damped follow stiffness
  ZOOM_RATE: 4.0,
  MIN_HALF_H: 80,
  MAX_HALF_H: 900,
  MASS_ZOOM: 3.6,        // extra view height per unit of player radius
  BASE_HALF_H: 46
};

// particle budgets per `particles` tier (burst FX cap, drifting plankton count)
const TIER_PARTICLES = { low: 300, high: 1200 };
const TIER_DECOR = { low: 60, high: 240 };

// Colour grade + vignette (display-space colours in, display-space out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.26 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      vec3 lc = clamp(c, 0.0, 1.0);
      // gentle S-curve contrast, a touch more saturation, cool shadows / warm highlights
      vec3 s = mix(lc, lc * lc * (3.0 - 2.0 * lc), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.95, 1.0, 1.06), vec3(1.04, 1.01, 0.96), smoothstep(0.25, 0.85, l));
      s = s * 0.99 + 0.003;
      c = mix(c, s + max(c - 1.0, 0.0), uAmount);
      float d = length((vUv - 0.5) * vec2(1.0, 0.9));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`
};

// Caustic shimmer: light focused by the dish's liquid, drawn additively over the floor.
const CAUSTIC_VERT = `
  varying vec2 vPos;
  void main() { vPos = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const CAUSTIC_FRAG = `
  uniform float uTime; uniform float uRadius; uniform vec3 uColor; uniform float uStrength;
  varying vec2 vPos;
  float band(vec2 p, float t) {
    vec2 q = p;
    for (int i = 0; i < 3; i++) {
      float fi = float(i) + 1.0;
      q += vec2(sin(q.y * 1.3 / fi + t * 0.7 + fi), cos(q.x * 1.1 / fi - t * 0.6 + fi * 1.7)) * 0.9;
    }
    float v = abs(sin(q.x) * sin(q.y));
    return pow(1.0 - v, 24.0);
  }
  void main() {
    vec2 p = vPos / 38.0;
    float c = band(p, uTime) * 0.65 + band(p * 1.7 + 3.1, uTime * 1.3) * 0.35;
    float edge = 1.0 - smoothstep(uRadius * 0.82, uRadius, length(vPos));
    gl_FragColor = vec4(uColor * c * uStrength * edge, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

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
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.enabled = false;

  // GPU identity drives the Auto preset (software renderers get Low).
  let gpu = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '';
  } catch (e) { gpu = ''; }
  const mobile = typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches)
    || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  const detected = detectPreset(gpu, mobile);
  let q = resolve({}, detected);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
  camera.position.set(0, 0, 1000);
  camera.lookAt(0, 0, 0);

  // layers: 0 environment, 1 gameplay, 2 selection/ghosts, 3 effects, 4 UI anchors
  camera.layers.enable(0); camera.layers.enable(1); camera.layers.enable(2);
  camera.layers.enable(3); camera.layers.enable(4);

  // ---------- lighting: hemisphere fill (lamp above, agar below) + one warm key
  // light from the upper left whose shadows fall down-right onto the dish floor.
  const ambient = new THREE.AmbientLight(0xffffff, 0.3);
  const hemi = new THREE.HemisphereLight(0xdff8ff, 0x0b2a33, 0.8);
  hemi.position.set(0, 0, 1);
  const key = new THREE.DirectionalLight(0xfff4e0, 1.2);
  const KEY_DIR = new THREE.Vector3(-0.4, 0.6, 1).normalize();
  key.position.copy(KEY_DIR).multiplyScalar(400);
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  scene.add(ambient, hemi, key, key.target);

  // image-based lighting (room environment) for glossy membranes; built on demand
  let envTex = null;
  function environmentTexture() {
    if (!envTex) {
      const pm = new THREE.PMREMGenerator(renderer);
      envTex = pm.fromScene(new RoomEnvironment(renderer), 0.04).texture;
      pm.dispose();
    }
    return envTex;
  }

  // ---------- theme
  let theme = {
    bg: '#071c26', bgDeep: '#03101a', membrane: '#4fd8c2', player: '#ffd166',
    motes: ['#9bf6e4', '#6ee7d8', '#c5fff3'], barb: '#ff6b81',
    fog: 'rgba(7,28,38,0.55)', grid: 'rgba(120,220,210,0.07)'
  };
  let cvdPatch = null;
  let highContrast = false;
  let reducedMotion = false;
  let decorSeed = 1;

  // ---------- environment: arena floor + boundary + membrane grid
  const envGroup = new THREE.Group();
  envGroup.layers.set(0);
  scene.add(envGroup);
  let floorMesh = null, boundMesh = null, gridMesh = null, outsideMesh = null, shadowMesh = null, causticMesh = null, glowMesh = null;
  const causticUniforms = {
    uTime: { value: 0 }, uRadius: { value: 600 }, uColor: { value: new THREE.Color(0xffffff) }, uStrength: { value: 0.05 }
  };

  function themeColor(c) { return new THREE.Color(c); }

  function buildEnvironment(arenaRadius) {
    for (const m of [floorMesh, boundMesh, gridMesh, outsideMesh, shadowMesh, causticMesh, glowMesh]) {
      if (m) { envGroup.remove(m); m.geometry.dispose(); if (m.material.map) m.material.map.dispose(); if (m.material !== causticMat) m.material.dispose(); }
    }
    const detailed = q.detail === 'detailed';
    // radial gradient floor texture (procedural, seeded decoration)
    const size = detailed ? 1024 : 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
    grad.addColorStop(0, detailed ? '#' + new THREE.Color(theme.bg).lerp(new THREE.Color(theme.membrane), 0.02).getHexString() : theme.bg);
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
    if (detailed) {
      // agar detail: a pool of lamp light, ghost cell walls and fine grain
      const pool = g.createRadialGradient(size * 0.42, size * 0.38, 0, size * 0.42, size * 0.38, size * 0.55);
      pool.addColorStop(0, 'rgba(210,255,248,0.07)');
      pool.addColorStop(1, 'rgba(210,255,248,0)');
      g.fillStyle = pool; g.fillRect(0, 0, size, size);
      g.strokeStyle = theme.membrane;
      for (let i = 0; i < 90; i++) {
        const r = 3 + rnd() * 10, bx = rnd() * size, by = rnd() * size;
        g.globalAlpha = 0.04 + rnd() * 0.06;
        g.lineWidth = 1 + rnd() * 1.5;
        g.beginPath(); g.ellipse(bx, by, r, r * (0.7 + rnd() * 0.3), rnd() * Math.PI, 0, Math.PI * 2); g.stroke();
      }
      const img = g.getImageData(0, 0, size, size), d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const n = (rnd() - 0.5) * 7;
        d[i] += n; d[i + 1] += n; d[i + 2] += n;
      }
      g.putImageData(img, 0, 0);
      // glass wall: light caught just inside the rim
      const wall = g.createRadialGradient(size / 2, size / 2, size * 0.44, size / 2, size / 2, size * 0.5);
      wall.addColorStop(0, 'rgba(160,240,230,0)');
      wall.addColorStop(1, 'rgba(160,240,230,0.10)');
      g.globalAlpha = 1;
      g.fillStyle = wall; g.fillRect(0, 0, size, size);
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

    // shadow catcher: the floor keeps its authored colours, shadows only darken it
    shadowMesh = new THREE.Mesh(
      new THREE.CircleGeometry(arenaRadius, 96),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.42 })
    );
    shadowMesh.position.z = -9.8;
    shadowMesh.receiveShadow = true;
    shadowMesh.visible = q.shadows !== 'off';
    envGroup.add(shadowMesh);

    // caustic shimmer (additive, animated when `background` is animated)
    causticUniforms.uRadius.value = arenaRadius;
    causticUniforms.uColor.value.set(theme.membrane).lerp(new THREE.Color(0xffffff), 0.5);
    causticMesh = new THREE.Mesh(new THREE.CircleGeometry(arenaRadius, 96), causticMat);
    causticMesh.position.z = -9.6;
    causticMesh.visible = q.background === 'animated';
    envGroup.add(causticMesh);

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

    // soft halo just outside the rim (the lit glass wall of the dish)
    glowMesh = new THREE.Mesh(
      new THREE.RingGeometry(arenaRadius + 2.5, arenaRadius + 22, 128, 1),
      new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uColor: { value: themeColor(theme.membrane) }, uInner: { value: arenaRadius + 2.5 }, uOuter: { value: arenaRadius + 22 } },
        vertexShader: 'varying vec2 vPos; void main() { vPos = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform vec3 uColor; uniform float uInner; uniform float uOuter; varying vec2 vPos;
          void main() { float t = (length(vPos) - uInner) / (uOuter - uInner); gl_FragColor = vec4(uColor * pow(1.0 - clamp(t, 0.0, 1.0), 2.2) * 0.35, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          }`
      })
    );
    glowMesh.position.z = -8.2;
    envGroup.add(glowMesh);

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

  const causticMat = new THREE.ShaderMaterial({
    uniforms: causticUniforms, vertexShader: CAUSTIC_VERT, fragmentShader: CAUSTIC_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });

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

  // Membrane edge light: a view-space fresnel term added to the emissive so the
  // flattened sphere reads as a translucent wall with a bright rim.
  function addMembraneRim(mat, strength) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uRim = { value: strength };
      shader.fragmentShader = 'uniform float uRim;\n' + shader.fragmentShader.replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  float cdRim = pow(1.0 - clamp(abs(normal.z), 0.0, 1.0), 2.5);\n  totalEmissiveRadiance += diffuseColor.rgb * cdRim * uRim;');
    };
    mat.customProgramCacheKey = () => 'cd-membrane-' + strength;
  }

  function membraneMaterial(hue, isPlayer) {
    const detailed = q.detail === 'detailed';
    const key = hue + (isPlayer ? 'p' : '') + (highContrast ? 'h' : '') + (detailed ? 'd' : '');
    if (materialCache.has(key)) return materialCache.get(key);
    const base = isPlayer ? themeColor(theme.player) : new THREE.Color().setHSL(hue / 360, highContrast ? 0.95 : 0.62, highContrast ? 0.6 : 0.55);
    const common = {
      color: base,
      transparent: true,
      opacity: highContrast ? 0.95 : 0.84,
      roughness: 0.32,
      metalness: 0,
      emissive: base.clone().multiplyScalar(0.2),
      envMapIntensity: 0.55
    };
    const mat = detailed
      ? new THREE.MeshPhysicalMaterial(Object.assign(common, { roughness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.15, iridescence: 0.25, iridescenceIOR: 1.3, sheen: 0.2, sheenColor: base.clone().lerp(new THREE.Color(0xffffff), 0.5) }))
      : new THREE.MeshStandardMaterial(common);
    addMembraneRim(mat, detailed ? 1.1 : 0.8);
    materialCache.set(key, mat);
    return mat;
  }

  function makeCellView(hue, isPlayer) {
    const group = new THREE.Group();
    const outer = new THREE.Mesh(cellGeo, membraneMaterial(hue, isPlayer));
    outer.scale.z = 0.42;
    outer.castShadow = true;
    group.add(outer);
    const nuc = new THREE.Mesh(nucleusGeo, new THREE.MeshBasicMaterial({
      color: themeColor('#ffffff'), transparent: true, opacity: highContrast ? 0.55 : 0.3
    }));
    nuc.scale.set(0.34, 0.34, 0.2);
    nuc.position.z = 0.2;
    group.add(nuc);
    const rim = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({
      color: (isPlayer ? themeColor(theme.player) : new THREE.Color().setHSL(hue / 360, 0.8, 0.7)).multiplyScalar(1.4),
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
  // motes glow (emissive above the bloom threshold) so food reads at a glance
  const moteMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.5, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, emissive: 0x333333, emissiveIntensity: 1 }), MAX_MOTES);
  const pelletMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.9, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, emissive: 0x444444 }), MAX_PELLETS);
  moteMesh.castShadow = true; pelletMesh.castShadow = true;
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
  // soft round sprite shared by plankton and burst particles
  const dotTex = (() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const g = cv.getContext('2d');
    const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.75)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  let decorPoints = null;
  function buildDecor(arenaRadius) {
    if (decorPoints) { scene.remove(decorPoints); decorPoints.geometry.dispose(); decorPoints.material.dispose(); }
    const n = TIER_DECOR[q.particles] || 100;
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
      color: themeColor(theme.membrane), size: 4, map: dotTex, transparent: true, opacity: 0.4, depthWrite: false, sizeAttenuation: false
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
    color: 0xffffff, size: 4.5, map: dotTex, transparent: true, opacity: 0.95, depthWrite: false, sizeAttenuation: true
  }));
  fxPoints.layers.set(3);
  fxPoints.frustumCulled = false;
  scene.add(fxPoints);
  const fx = { x: new Float32Array(MAX_FX), y: new Float32Array(MAX_FX), vx: new Float32Array(MAX_FX), vy: new Float32Array(MAX_FX), life: new Float32Array(MAX_FX), n: 0 };
  const fxColor = new THREE.Color(0xffffff);

  function spawnFx(x, y, count, color, speed) {
    if (reducedMotion) count = Math.min(count, 3);
    const cap = TIER_PARTICLES[q.particles] || MAX_FX;
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
    color: new THREE.Color(0xfff3a0).multiplyScalar(1.5), transparent: true, opacity: 0.85, side: THREE.DoubleSide
  }));
  markerGroup.add(markerRing);
  markerGroup.visible = false;
  scene.add(markerGroup);

  const hintGroup = new THREE.Group();
  hintGroup.layers.set(2);
  const hintRing = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32), new THREE.MeshBasicMaterial({
    color: new THREE.Color(0x9be8ff).multiplyScalar(1.5), transparent: true, opacity: 0.9, side: THREE.DoubleSide
  }));
  hintGroup.add(hintRing);
  hintGroup.visible = false;
  scene.add(hintGroup);

  // ---------- camera state
  const camState = { x: 0, y: 0, halfH: 120, shake: 0, shakeT: 0 };
  let arenaRadius = 600;
  let aspect = 1;

  // ---------- output size: CSS size x min(dpr, 2) x preset scale x adaptive scale
  let size = [0, 0], pixelRatio = 0, adaptiveScale = 1;
  function resize() {
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 1;
    const h = canvas.clientHeight || canvas.parentElement.clientHeight || 1;
    aspect = w / h;
    const ratio = Math.min(window.devicePixelRatio || 1, 2) * q.scale * adaptiveScale;
    if (w !== size[0] || h !== size[1] || ratio !== pixelRatio) {
      size = [w, h];
      pixelRatio = ratio;
      renderer.setPixelRatio(ratio);
      renderer.setSize(w, h, false);
    }
    updateCameraFrustum();
  }

  // ---------- post-processing chain (rebuilt when its key changes)
  let composer = null, postKey = null, postFailed = false;
  function currentPostKey() {
    return q.post ? [q.bloom, q.grade, q.antialias, size[0], size[1], pixelRatio].join('|') : 'none';
  }
  function buildPost() {
    if (composer) { for (const p of composer.passes) if (p.dispose) p.dispose(); composer.dispose(); composer = null; }
    if (!q.post || postFailed) return;
    const [w, h] = size;
    try {
      const target = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w * pixelRatio)), Math.max(1, Math.round(h * pixelRatio)), {
        type: THREE.HalfFloatType, samples: q.antialias === 'msaa' ? 4 : 0
      });
      const c = new EffectComposer(renderer, target);
      c.setPixelRatio(pixelRatio);
      c.setSize(w, h);
      c.addPass(new RenderPass(scene, camera));
      if (q.bloom === 'on') {
        // high threshold: only emissive motes, rims, rings and specular glints glow
        c.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.45, 0.2, 0.9));
      }
      if (q.grade === 'on') c.addPass(new ShaderPass(GradeShader));
      c.addPass(new OutputPass());
      if (q.antialias === 'smaa') c.addPass(new SMAAPass(w * pixelRatio, h * pixelRatio));
      if (q.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / (w * pixelRatio), 1 / (h * pixelRatio));
        c.addPass(fxaa);
      }
      composer = c;
    } catch (e) {
      // post-processing is an enhancement: render directly and say so in the Graphics panel
      postFailed = true;
      composer = null;
    }
  }

  // ---------- adaptive resolution + frame-rate readout
  let frames = [], fps = 0, lastNow = 0;
  function adapt(dtMs) {
    frames.push(dtMs);
    if (frames.length < 90) return false;
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    frames = [];
    fps = 1000 / avg;
    const el = document.getElementById('cd-fps');
    if (el && !el.hidden) el.textContent = Math.round(fps) + ' fps · ' + (Math.round(pixelRatio * 100) / 100) + '×';
    if (!q.adaptive) return false;
    const before = adaptiveScale;
    if (avg > 26) adaptiveScale = Math.max(0.6, Math.round((adaptiveScale - 0.1) * 100) / 100);
    else if (avg < 14 && adaptiveScale < 1) adaptiveScale = Math.min(1, Math.round((adaptiveScale + 0.05) * 100) / 100);
    return before !== adaptiveScale;
  }
  function fpsVisible(on) {
    let el = document.getElementById('cd-fps');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'cd-fps';
      el.className = 'cd-fps';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.appendChild(el);
    }
    if (el) el.hidden = !on;
  }

  // Key-light shadow box fitted to the visible part of the dish, snapped to
  // whole texels so camera follow does not make shadow edges shimmer.
  function fitShadow() {
    if (!key.castShadow) return;
    const sh = key.shadow;
    const halfW = camState.halfH * aspect;
    const extent = Math.min(arenaRadius + 30, Math.hypot(halfW, camState.halfH) + 30);
    const texel = (extent * 2) / (sh.mapSize.x || 1024);
    const tx = Math.round(camState.x / texel) * texel, ty = Math.round(camState.y / texel) * texel;
    key.target.position.set(tx, ty, 0);
    key.position.set(tx + KEY_DIR.x * 400, ty + KEY_DIR.y * 400, KEY_DIR.z * 400);
    key.target.updateMatrixWorld();
    if (sh.camera.right !== extent) {
      Object.assign(sh.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: 900 });
      sh.camera.updateProjectionMatrix();
    }
  }

  function renderFrame(dt) {
    const now = performance.now();
    const dtMs = lastNow ? Math.min(250, now - lastNow) : 16;
    lastNow = now;
    if (adapt(dtMs)) resize();
    const k = currentPostKey();
    if (k !== postKey) { postKey = k; buildPost(); }
    fitShadow();
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }

  // Apply resolved graphics settings live (no reload).
  function applyGraphics(saved) {
    q = resolve(saved || {}, detected);
    const mapSize = SHADOW_MAP[q.shadows];
    renderer.shadowMap.enabled = mapSize > 0;
    key.castShadow = mapSize > 0;
    if (mapSize > 0 && key.shadow.mapSize.x !== mapSize) {
      key.shadow.mapSize.set(mapSize, mapSize);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
    key.shadow.radius = q.shadows === 'high' ? 3 : 2;
    scene.environment = q.reflections === 'on' ? environmentTexture() : null;
    hemi.intensity = q.reflections === 'on' ? 0.6 : 0.8;
    if (shadowMesh) shadowMesh.visible = mapSize > 0;
    if (causticMesh) causticMesh.visible = q.background === 'animated';
    adaptiveScale = 1;
    frames = [];
    postFailed = false;
    postKey = null;
    fpsVisible(q.showFps);
    // membrane materials depend on `detail`; everything lit depends on shadow state
    materialCache.forEach((m) => m.dispose());
    materialCache.clear();
    for (const [, v] of cellViews) scene.remove(v.group);
    cellViews.clear();
    scene.traverse((o) => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
    });
    if (lastState) { buildEnvironment(arenaRadius); buildDecor(arenaRadius); }
    resize();
    document.body.setAttribute('data-gfx-preset', q.preset);
    canvas.setAttribute('data-gfx-preset', q.preset);
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
    // a new round (new rules state object) starts from a clean slate: no pop
    // effects for the previous round's entities, and the dish, decor and barbs
    // are rebuilt even when the arena radius is unchanged
    const newRound = state !== lastState;
    prevMap = newRound ? new Map() : currMap;
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
    if (newRound || state.arena.radius !== arenaRadius) {
      arenaRadius = state.arena.radius;
      buildEnvironment(arenaRadius);
      buildDecor(arenaRadius);
      syncBarbs(state);
    }
  }

  function syncBarbs(state) {
    for (const [id, v] of barbViews) { scene.remove(v); v.material.dispose(); }
    barbViews.clear();
    for (const b of state.barbs) {
      const mat = new THREE.MeshStandardMaterial({
        color: themeColor(theme.barb), roughness: 0.45, metalness: 0.1,
        emissive: themeColor(theme.barb).multiplyScalar(0.3), envMapIntensity: 0.6
      });
      const mesh = new THREE.Mesh(barbGeo, mat);
      mesh.castShadow = true;
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
    if (!lastState) { renderFrame(dt); return; }
    const state = lastState;

    // camera follow with critically damped smoothing (never cumulative lerp drift)
    if (focus) {
      const k = 1 - Math.exp(-CAM.FOLLOW_RATE * dt);
      let fx = focus.x, fy = focus.y;
      let targetHalf = CAM.BASE_HALF_H + focus.radius * CAM.MASS_ZOOM * 8;
      if (focus.include) {
        // Fit both the player and the included point (goal marker) in view,
        // with a margin for the HUD bands, and centre between them.
        const inc = focus.include;
        const minX = Math.min(focus.x - focus.radius, inc.x - inc.radius), maxX = Math.max(focus.x + focus.radius, inc.x + inc.radius);
        const minY = Math.min(focus.y - focus.radius, inc.y - inc.radius), maxY = Math.max(focus.y + focus.radius, inc.y + inc.radius);
        fx = (minX + maxX) / 2; fy = (minY + maxY) / 2;
        const needH = (maxY - minY) / 2 / 0.7, needW = (maxX - minX) / 2 / (0.9 * aspect);
        targetHalf = Math.max(targetHalf, needH, needW);
      }
      camState.x += (fx - camState.x) * k;
      camState.y += (fy - camState.y) * k;
      targetHalf = Math.max(CAM.MIN_HALF_H, Math.min(CAM.MAX_HALF_H, targetHalf));
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
    moteMesh.material.emissive.set(theme.motes[1]).multiplyScalar(0.3);

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
    pelletMesh.material.emissive.set(theme.motes[2] || '#ffffff').multiplyScalar(0.45);

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

    // decor drift + caustic shimmer (frozen under reduced motion)
    if (decorPoints && !reducedMotion) {
      decorPoints.rotation.z = time * 0.008;
    }
    if (!reducedMotion) causticUniforms.uTime.value = time * 0.6;

    updateFx(dt);
    renderFrame(dt);
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
    /** Apply saved graphics settings ({} = Auto); changes take effect immediately. */
    setGraphics(saved) { applyGraphics(saved); },
    /** What the Graphics panel shows: GPU, auto choice, resolved tiers, cost summary. */
    graphicsInfo() {
      const px = [Math.round(size[0] * pixelRatio), Math.round(size[1] * pixelRatio)];
      return {
        gpu: gpu || 'unknown GPU', detected, mobile, resolved: q,
        summary: describe(q, px), pixels: px, fps: Math.round(fps),
        adaptiveScale, postFailed
      };
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
