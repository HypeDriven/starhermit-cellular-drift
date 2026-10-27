// The petri dish on starhermit:scene, ported from the browser build's
// three.js render layer (js/render.js): the agar floor (a seeded canvas of
// the theme's gradient, membrane blotches and, with surface detail, a lamp
// pool, ghost cell walls and the glass wall's light), the caustic shimmer,
// the dark surround, the glowing rim and its halo, the faint concentric
// rings, pooled cell views (a flattened translucent membrane with a fresnel
// edge light, a nucleus, and a pulsing rim on the player's own cells),
// instanced motes and pellets, spinning barb stars, drifting plankton,
// pooled burst particles, the goal marker and hint rings, the damped camera
// follow and zoom with shake, and the look per graphics level from
// quality.ts. It reads rules snapshots and never mutates rules state.
//
// What changed from three.js, and why:
// - The caustic shimmer's and the rim halo's GLSL ShaderMaterials are WGSL;
//   the membranes' onBeforeCompile edge light is a WGSL surface hook.
// - three.js's ShadowMaterial catcher over the floor is the floor itself:
//   an emissive Lambert floor whose light hook darkens it by the key
//   light's shadow (the same 42 %), so the floor keeps its authored colours.
// - The floor's per-pixel grain (getImageData noise over the whole canvas)
//   is a hash in the floor's surface hook: the same ±7/255 grain without a
//   script loop over millions of pixels.
// - The hemisphere fill (lamp-pale sky toward the camera, deep teal below)
//   is a second, shadowless directional light from the camera's side: the
//   dish is seen straight down, so every visible surface faces the "sky".
// - IcosahedronGeometry motes and pellets are low-segment spheres;
//   MeshPhysicalMaterial's iridescence and sheen are not drawn (its
//   clearcoat is).
// - The EffectComposer chain (UnrealBloom, the grade ShaderPass, OutputPass,
//   SMAA / FXAA / canvas MSAA) is renderer.bloom / grade / antialias.
// - The fitted, texel-snapped shadow box is the engine's view-based
//   directional shadow (`shadow.distance`), with the camera kept just above
//   the dish so the view's depth is short.
// - Light intensities are three.js r160's divided by π (the engine's
//   convention). The soft particle dot is a DataTexture.
// - Layers, the adaptive resolution and the fps meter are gone: the runtime
//   owns resolution and the frame-rate readout.
import {
  ACESFilmicToneMapping, AdditiveBlending, AmbientLight, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry,
  Color, DataTexture, DirectionalLight, DoubleSide, ExtrudeGeometry, Group, InstancedMesh, Matrix4, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry, MeshPhysicalMaterial, MeshStandardMaterial, OrthographicCamera,
  PMREMGenerator, Points, PointsMaterial, Quaternion, RingGeometry, RoomEnvironment, SRGBColorSpace, ShaderMaterial,
  Shape, SphereGeometry, Vector3, mergeGeometries, renderer, scene,
} from "starhermit:scene";
import type { Material, MaterialHooks, Texture } from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import type { State, Theme } from "./classic.ts";
import type { Look } from "./quality.ts";

export const CAM = {
  FOLLOW_RATE: 6.5, // critically damped follow stiffness
  ZOOM_RATE: 4.0,
  MIN_HALF_H: 80,
  MAX_HALF_H: 900,
  MASS_ZOOM: 3.6, // extra view height per unit of player radius
  BASE_HALF_H: 46,
};
const PI = Math.PI;
const KEY_DIR = new Vector3(-0.4, 0.6, 1).normalize();
/** The camera sits this far above the dish floor (orthographic: height changes nothing on screen). */
const CAM_Z = 60;

export interface Focus { x: number; y: number; radius: number; include?: { x: number; y: number; radius: number } }

const camera = new OrthographicCamera(-1, 1, 1, -1, 0.5, 120);
camera.position.set(0, 0, CAM_Z);

// --- lights ---------------------------------------------------------------------------
const key = new DirectionalLight(0xfff4e0, 1.2 / PI);
key.shadow.bias = -0.0005;
key.shadow.normalBias = 1;
key.shadow.distance = CAM_Z + 20;
const fill = new DirectionalLight(0xdff8ff, 0.8 / PI);
fill.position.set(0, 0, 100);
const ambient = new AmbientLight(0xffffff, 0.3 / PI);

let look: Look | null = null;
let theme: Theme = {
  id: "lagoon", name: "", bg: "#071c26", bgDeep: "#03101a", membrane: "#4fd8c2", player: "#ffd166",
  motes: ["#9bf6e4", "#6ee7d8", "#c5fff3"], barb: "#ff6b81",
};
let highContrast = false;
let reducedMotion = false;
let decorSeed = 1;
let built = false;

// --- the soft dot (plankton and burst particles) -------------------------------------------
function dotTexture(): DataTexture {
  const n = 32;
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.min(1, Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2));
      // the browser build's radial gradient: 1 → 0.75 at 45 % → 0
      const a = d < 0.45 ? 1 - (0.25 * d) / 0.45 : 0.75 * (1 - (d - 0.45) / 0.55);
      const o = (y * n + x) * 4;
      px[o] = px[o + 1] = px[o + 2] = 255;
      px[o + 3] = Math.round(Math.max(0, a) * 255);
    }
  }
  return new DataTexture(px, n, n);
}
const dotTex = dotTexture();

// --- the dish ------------------------------------------------------------------------------
const envGroup = new Group();
let floorMesh: Mesh | null = null;
let causticMesh: Mesh | null = null;
const envMeshes: Mesh[] = [];
let floorTex: CanvasTexture | null = null;

// The floor's grain and the key light's shadow on it (see the header).
const floorHooks: MaterialHooks = {
  uniforms: { uSize: { value: 512 }, uShadow: { value: 0.42 } },
  surface: `
fn cd_hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
fn surface(s: Surface) -> Surface {
  var o = s;
  let n = (cd_hash(floor(s.uv * uniforms.uSize)) - 0.5) * (7.0 / 255.0);
  let srgb = clamp(linear_to_srgb(s.emissive) + vec3f(n), vec3f(0.0), vec3f(1.0));
  o.emissive = srgb_to_linear(srgb);
  return o;
}`,
  light: `
fn light(l: Light) -> Light {
  var o = l;
  o.emissive = l.emissive * (1.0 - uniforms.uShadow * (1.0 - l.shadow));
  o.sun = vec3f(0.0);
  o.direct = vec3f(0.0);
  o.indirect = vec3f(0.0);
  return o;
}`,
};

const CAUSTIC_FRAGMENT = `
fn cd_band(p: vec2f, t: f32) -> f32 {
  var q = p;
  for (var i = 0; i < 3; i++) {
    let fi = f32(i) + 1.0;
    q = q + vec2f(sin(q.y * 1.3 / fi + t * 0.7 + fi), cos(q.x * 1.1 / fi - t * 0.6 + fi * 1.7)) * 0.9;
  }
  let v = abs(sin(q.x) * sin(q.y));
  return pow(1.0 - v, 24.0);
}
fn fragment(f: Fragment) -> vec4f {
  let p = f.world.xy / 38.0;
  let c = cd_band(p, uniforms.uTime) * 0.65 + cd_band(p * 1.7 + vec2f(3.1), uniforms.uTime * 1.3) * 0.35;
  let edge = 1.0 - smoothstep(uniforms.uRadius * 0.82, uniforms.uRadius, length(f.world.xy));
  return vec4f(uniforms.uColor * c * uniforms.uStrength * edge, 1.0);
}`;
const causticUniforms = {
  uTime: { value: 0 }, uRadius: { value: 600 }, uColor: { value: new Color(0xffffff) }, uStrength: { value: 0.05 },
};
const causticMat = new ShaderMaterial({
  uniforms: causticUniforms, fragmentShader: CAUSTIC_FRAGMENT, transparent: true, depthWrite: false, blending: AdditiveBlending,
});

const GLOW_FRAGMENT = `
fn fragment(f: Fragment) -> vec4f {
  let t = (length(f.world.xy) - uniforms.uInner) / (uniforms.uOuter - uniforms.uInner);
  return vec4f(uniforms.uColor * pow(1.0 - clamp(t, 0.0, 1.0), 2.2) * 0.35, 1.0);
}`;
const glowUniforms = { uColor: { value: new Color(0x4fd8c2) }, uInner: { value: 602.5 }, uOuter: { value: 622 } };
const glowMat = new ShaderMaterial({
  uniforms: glowUniforms, fragmentShader: GLOW_FRAGMENT, transparent: true, depthWrite: false, blending: AdditiveBlending,
});

const hex = (c: Color): string => "#" + c.getHex().toString(16).padStart(6, "0");

/** The seeded agar floor canvas (the browser build's buildEnvironment canvas, without the grain). */
function floorCanvas(size: number, detailed: boolean): OffscreenCanvas {
  const cv = new OffscreenCanvas(size, size);
  const g = cv.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
  grad.addColorStop(0, detailed ? hex(new Color(theme.bg).lerp(new Color(theme.membrane), 0.02)) : theme.bg);
  grad.addColorStop(1, theme.bgDeep);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  let s = decorSeed;
  const rnd = (): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  g.globalAlpha = 0.05;
  for (let i = 0; i < 26; i++) {
    const r = 20 + rnd() * 90;
    const bx = rnd() * size, by = rnd() * size;
    const bg2 = g.createRadialGradient(bx, by, 1, bx, by, r);
    bg2.addColorStop(0, theme.membrane);
    bg2.addColorStop(1, "transparent");
    g.fillStyle = bg2;
    g.beginPath(); g.arc(bx, by, r, 0, PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  if (detailed) {
    const pool = g.createRadialGradient(size * 0.42, size * 0.38, 0, size * 0.42, size * 0.38, size * 0.55);
    pool.addColorStop(0, "rgba(210,255,248,0.07)");
    pool.addColorStop(1, "rgba(210,255,248,0)");
    g.fillStyle = pool; g.fillRect(0, 0, size, size);
    g.strokeStyle = theme.membrane;
    for (let i = 0; i < 90; i++) {
      const r = 3 + rnd() * 10, bx = rnd() * size, by = rnd() * size;
      g.globalAlpha = 0.04 + rnd() * 0.06;
      g.lineWidth = 1 + rnd() * 1.5;
      g.beginPath(); g.ellipse(bx, by, r, r * (0.7 + rnd() * 0.3), rnd() * PI, 0, PI * 2); g.stroke();
    }
    g.globalAlpha = 1;
    const wall = g.createRadialGradient(size / 2, size / 2, size * 0.44, size / 2, size / 2, size * 0.5);
    wall.addColorStop(0, "rgba(160,240,230,0)");
    wall.addColorStop(1, "rgba(160,240,230,0.10)");
    g.fillStyle = wall; g.fillRect(0, 0, size, size);
  }
  return cv;
}

let arenaRadius = 600;
function buildEnvironment(radius: number): void {
  for (const m of envMeshes) {
    envGroup.remove(m);
    m.geometry.dispose();
    const mat = m.material as Material;
    if (mat !== causticMat && mat !== glowMat) mat.dispose();
  }
  envMeshes.length = 0;
  floorTex?.dispose();
  const L = look!;
  const size = L.detailed ? L.budget.floorTexture : L.budget.floorTexture / 2;
  floorTex = new CanvasTexture(floorCanvas(size, L.detailed));
  floorTex.colorSpace = SRGBColorSpace;
  floorHooks.uniforms!.uSize!.value = L.detailed ? size : 0;
  const floorMat = new MeshLambertMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: floorTex });
  floorMat.hooks = { ...floorHooks };
  floorMesh = new Mesh(new CircleGeometry(radius, 96), floorMat);
  floorMesh.position.z = -10;
  floorMesh.receiveShadow = true;
  const add = (m: Mesh): Mesh => { envGroup.add(m); envMeshes.push(m); return m; };
  add(floorMesh);

  causticUniforms.uRadius.value = radius;
  causticUniforms.uColor.value.set(theme.membrane).lerp(new Color(0xffffff), 0.5);
  causticMesh = add(new Mesh(new CircleGeometry(radius, 96), causticMat));
  causticMesh.position.z = -9.6;
  causticMesh.visible = L.animated;

  const outside = add(new Mesh(new RingGeometry(radius, radius * 4, 96), new MeshBasicMaterial({ color: theme.bgDeep })));
  outside.position.z = -9;

  const bound = add(new Mesh(new RingGeometry(radius - 2.5, radius + 2.5, 128), new MeshBasicMaterial({
    color: theme.membrane, transparent: true, opacity: highContrast ? 0.95 : 0.6, side: DoubleSide,
  })));
  bound.position.z = -8;

  glowUniforms.uColor.value.set(theme.membrane);
  glowUniforms.uInner.value = radius + 2.5;
  glowUniforms.uOuter.value = radius + 22;
  const glow = add(new Mesh(new RingGeometry(radius + 2.5, radius + 22, 128, 1), glowMat));
  glow.position.z = -8.2;

  const rings: BufferGeometry[] = [];
  for (let i = 1; i <= 4; i++) {
    const rr = (radius * i) / 5;
    rings.push(new RingGeometry(rr - 0.8, rr + 0.8, 96));
  }
  const merged = mergeGeometries(rings);
  for (const r of rings) r.dispose();
  if (merged) {
    const grid = add(new Mesh(merged, new MeshBasicMaterial({
      color: theme.membrane, transparent: true, opacity: highContrast ? 0.22 : 0.1, side: DoubleSide,
    })));
    grid.position.z = -8.5;
  }
}

// --- cells: pooled views per entity id ---------------------------------------------------------
let cellGeo = new SphereGeometry(1, 24, 16);
const nucleusGeo = new SphereGeometry(1, 14, 10);
const rimGeo = new RingGeometry(0.94, 1.06, 48);
interface CellView { group: Group; outer: Mesh; nucleus: Mesh; rim: Mesh | null; shadow: Mesh }
const cellViews = new Map<number, CellView>();
const materialCache = new Map<string, Material>();
const nucleusMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 });
const playerRimMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: DoubleSide });

// The membranes' shadows on the floor. three.js cast them from the translucent
// membranes; the engine's shadow pass leaves transparent materials out
// (1.16.0; reported), so each cell lays a soft disc where the key light's
// shadow of its membrane falls: the floor is 10 below the cells' middle, the
// light from KEY_DIR, at the shadow catcher's 42 %.
function softDisc(): DataTexture {
  const n = 64;
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
      const a = d <= 0.8 ? 1 : Math.max(0, 1 - (d - 0.8) / 0.2);
      px[(y * n + x) * 4 + 3] = Math.round(a * 255);
    }
  }
  return new DataTexture(px, n, n);
}
const shadowGeo = new PlaneGeometry(2, 2);
const shadowMat = new MeshBasicMaterial({ color: 0x000000, map: softDisc(), transparent: true, opacity: 0.42, depthWrite: false });
const SHADOW_DX = (-KEY_DIR.x / KEY_DIR.z) * 10, SHADOW_DY = (-KEY_DIR.y / KEY_DIR.z) * 10;

/** The membrane's edge light: a view-space fresnel term added to the emissive (the dish is seen down -Z). */
function rimHooks(strength: number): MaterialHooks {
  return {
    uniforms: { uRim: { value: strength } },
    surface: `
fn surface(s: Surface) -> Surface {
  var o = s;
  let rim = pow(1.0 - clamp(abs(s.normal.z), 0.0, 1.0), 2.5);
  o.emissive = s.emissive + s.base_color.rgb * rim * uniforms.uRim;
  return o;
}`,
  };
}

function membraneMaterial(hue: number, isPlayer: boolean): Material {
  const L = look!;
  const kind = L.budget.material;
  const k = `${hue}${isPlayer ? "p" : ""}${highContrast ? "h" : ""}${L.detailed ? "d" : ""}${kind}${L.reflections ? "r" : ""}`;
  const hit = materialCache.get(k);
  if (hit) return hit;
  const base = isPlayer ? new Color(theme.player) : new Color().setHSL(hue / 360, highContrast ? 0.95 : 0.62, highContrast ? 0.6 : 0.55);
  const common = { color: base, transparent: true, opacity: highContrast ? 0.95 : 0.84, emissive: base.clone().multiplyScalar(0.2) };
  let mat: Material;
  if (kind === "lambert") mat = new MeshLambertMaterial(common);
  else if (L.detailed && kind === "physical") {
    mat = new MeshPhysicalMaterial({ ...common, roughness: 0.28, metalness: 0, envMapIntensity: 0.55, clearcoat: 0.8, clearcoatRoughness: 0.15 });
  } else mat = new MeshStandardMaterial({ ...common, roughness: 0.32, metalness: 0, envMapIntensity: 0.55 });
  mat.hooks = rimHooks(L.detailed ? 1.1 : 0.8);
  materialCache.set(k, mat);
  return mat;
}

const cellGroup = new Group();
function makeCellView(hue: number, isPlayer: boolean): CellView {
  const group = new Group();
  const outer = new Mesh(cellGeo, membraneMaterial(hue, isPlayer));
  outer.castShadow = true;
  group.add(outer);
  const nucleus = new Mesh(nucleusGeo, nucleusMat);
  nucleus.position.z = 0.2;
  group.add(nucleus);
  let rim: Mesh | null = null;
  if (isPlayer) {
    rim = new Mesh(rimGeo, playerRimMat);
    rim.position.z = 0.5;
    group.add(rim);
  }
  const shadow = new Mesh(shadowGeo, shadowMat);
  shadow.position.set(SHADOW_DX, SHADOW_DY, -9.7);
  shadow.visible = look!.shadows > 0;
  group.add(shadow);
  cellGroup.add(group);
  return { group, outer, nucleus, rim, shadow };
}
function clearCells(): void {
  for (const [, v] of cellViews) cellGroup.remove(v.group);
  cellViews.clear();
  for (const [, m] of materialCache) m.dispose();
  materialCache.clear();
}

// --- motes and pellets (instanced) -----------------------------------------------------------------
const MAX_MOTES = 420, MAX_PELLETS = 160;
const moteMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, emissive: 0x333333, emissiveIntensity: 1 });
const pelletMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, emissive: 0x444444 });
const moteMesh = new InstancedMesh(new SphereGeometry(1.5, 8, 6), moteMat, MAX_MOTES);
const pelletMesh = new InstancedMesh(new SphereGeometry(1.9, 8, 6), pelletMat, MAX_PELLETS);
moteMesh.castShadow = true; pelletMesh.castShadow = true;
moteMesh.count = 0; pelletMesh.count = 0;

// --- barbs (spiked hazard stars) ------------------------------------------------------------------
function barbGeometry(): BufferGeometry {
  const shape = new Shape();
  const spikes = 9;
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * PI * 2;
    const r = i % 2 === 0 ? 1 : 0.42;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  return new ExtrudeGeometry(shape, { depth: 0.35, bevelEnabled: false });
}
const barbGeo = barbGeometry();
let barbMat: MeshStandardMaterial | null = null;
const barbGroup = new Group();
const barbViews: Mesh[] = [];
function syncBarbs(state: State): void {
  for (const m of barbViews) barbGroup.remove(m);
  barbViews.length = 0;
  barbMat?.dispose();
  barbMat = new MeshStandardMaterial({
    color: theme.barb, roughness: 0.45, metalness: 0.1, emissive: new Color(theme.barb).multiplyScalar(0.3), envMapIntensity: 0.6,
  });
  for (const b of state.barbs) {
    const mesh = new Mesh(barbGeo, barbMat);
    mesh.castShadow = true;
    mesh.scale.set(b.radius, b.radius, b.radius);
    mesh.position.set(b.x, b.y, 0.5);
    barbGroup.add(mesh);
    barbViews.push(mesh);
  }
}

// --- drifting plankton (cosmetic) --------------------------------------------------------------------
let decorPoints: Points | null = null;
function buildDecor(radius: number): void {
  if (decorPoints) { scene.remove(decorPoints); decorPoints.geometry.dispose(); decorPoints.material.dispose(); decorPoints = null; }
  const n = look!.budget.decor;
  if (n <= 0) return;
  const pos = new Float32Array(n * 3);
  let s = (decorSeed ^ 0x5f3759df) >>> 0;
  const rnd = (): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    const a = rnd() * PI * 2, d = Math.sqrt(rnd()) * radius;
    pos[i * 3] = Math.cos(a) * d;
    pos[i * 3 + 1] = Math.sin(a) * d;
    pos[i * 3 + 2] = -6 + rnd() * 10;
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  decorPoints = new Points(geo, new PointsMaterial({
    color: theme.membrane, size: 4, map: dotTex, transparent: true, opacity: 0.4, depthWrite: false, sizeAttenuation: false,
  }));
  scene.add(decorPoints);
}

// --- burst particles (pooled, bounded by the budget) ----------------------------------------------------
const MAX_FX = 1200;
const fxGeo = new BufferGeometry();
const fxPos = new Float32Array(MAX_FX * 3);
const fxAttr = new BufferAttribute(fxPos, 3);
fxGeo.setAttribute("position", fxAttr);
fxGeo.setDrawRange(0, 0);
const fxMat = new PointsMaterial({ color: 0xffffff, size: 4.5, map: dotTex, transparent: true, opacity: 0.95, depthWrite: false, sizeAttenuation: false });
const fxPoints = new Points(fxGeo, fxMat);
fxPoints.frustumCulled = false;
const fx = { x: new Float32Array(MAX_FX), y: new Float32Array(MAX_FX), vx: new Float32Array(MAX_FX), vy: new Float32Array(MAX_FX), life: new Float32Array(MAX_FX), n: 0 };

function spawnFx(x: number, y: number, count: number, color: string, speed: number): void {
  if (reducedMotion) count = Math.min(count, 3);
  const cap = Math.min(look ? look.budget.particles : 300, MAX_FX);
  fxMat.color.set(color);
  for (let i = 0; i < count && fx.n < cap; i++) {
    const a = Math.random() * PI * 2;
    const sp = (0.3 + Math.random() * 0.7) * speed;
    fx.x[fx.n] = x; fx.y[fx.n] = y;
    fx.vx[fx.n] = Math.cos(a) * sp; fx.vy[fx.n] = Math.sin(a) * sp;
    fx.life[fx.n] = 0.5 + Math.random() * 0.4;
    fx.n++;
  }
}
function updateFx(dt: number): void {
  let i = 0;
  while (i < fx.n) {
    fx.life[i]! -= dt;
    if (fx.life[i]! <= 0) {
      const l = --fx.n;
      fx.x[i] = fx.x[l]!; fx.y[i] = fx.y[l]!; fx.vx[i] = fx.vx[l]!; fx.vy[i] = fx.vy[l]!; fx.life[i] = fx.life[l]!;
      continue;
    }
    fx.x[i]! += fx.vx[i]!; fx.y[i]! += fx.vy[i]!;
    fx.vx[i]! *= 0.94; fx.vy[i]! *= 0.94;
    i++;
  }
  for (let k = 0; k < fx.n; k++) { fxPos[k * 3] = fx.x[k]!; fxPos[k * 3 + 1] = fx.y[k]!; fxPos[k * 3 + 2] = 4; }
  fxGeo.setDrawRange(0, fx.n);
  if (fx.n > 0 || fxDirty) fxAttr.needsUpdate = true;
  fxDirty = fx.n > 0;
}
let fxDirty = false;

// --- goal marker and hint ring ------------------------------------------------------------------------
const markerGroup = new Group();
markerGroup.add(new Mesh(new RingGeometry(0.85, 1, 48), new MeshBasicMaterial({
  color: new Color(0xfff3a0).multiplyScalar(1.5), transparent: true, opacity: 0.85, side: DoubleSide,
})));
markerGroup.visible = false;
let markerRadius = 40;
const hintGroup = new Group();
hintGroup.add(new Mesh(new RingGeometry(0.8, 1, 32), new MeshBasicMaterial({
  color: new Color(0x9be8ff).multiplyScalar(1.5), transparent: true, opacity: 0.9, side: DoubleSide,
})));
hintGroup.visible = false;

// --- image-based light ----------------------------------------------------------------------------------
let envTex: Texture | null = null;
function updateEnvironment(): void {
  if (!look!.reflections) { scene.environment = null; return; }
  if (!envTex) {
    try { envTex = new PMREMGenerator().fromScene(new RoomEnvironment(), 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); envTex = null; }
  }
  scene.environment = envTex;
  // The engine's room lights about 1 / 0.3 as strongly as three.js's (bistro-builder's
  // finding), and a material's envMapIntensity is not applied (engine 1.16.0; reported):
  // the whole environment is scaled instead, and the food's emissive makes up its glow.
  scene.environmentIntensity = 0.3;
}

// --- camera ------------------------------------------------------------------------------------------------
const cam = { x: 0, y: 0, halfH: 120, shake: 0, shakeT: 0 };
let aspect = 16 / 9;
let viewW = 1, viewH = 1;
function updateFrustum(): void {
  camera.left = -cam.halfH * aspect;
  camera.right = cam.halfH * aspect;
  camera.top = cam.halfH;
  camera.bottom = -cam.halfH;
  camera.updateProjectionMatrix();
}

// --- entity interpolation ------------------------------------------------------------------------------------
interface Snap { x: number; y: number; mass?: number }
let prevMap = new Map<string, Snap>(), currMap = new Map<string, Snap>();
let lastState: State | null = null;
function entityMap(state: State): Map<string, Snap> {
  const m = new Map<string, Snap>();
  for (const c of state.cells) m.set("c" + c.id, { x: c.x, y: c.y, mass: c.mass });
  for (const mo of state.motes) m.set("m" + mo.id, { x: mo.x, y: mo.y });
  for (const pe of state.pellets) m.set("e" + pe.id, { x: pe.x, y: pe.y });
  return m;
}
function lerpPos(id: string, alpha: number, fallback: Snap): Snap {
  const c = currMap.get(id);
  if (!c) return fallback;
  const p = prevMap.get(id);
  if (!p) return c;
  return { x: p.x + (c.x - p.x) * alpha, y: p.y + (c.y - p.y) * alpha };
}

function build(): void {
  built = true;
  scene.add(key, key.target, fill, fill.target, ambient, envGroup, cellGroup, moteMesh, pelletMesh, barbGroup, fxPoints, markerGroup, hintGroup);
  renderer.camera = camera;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  scene.background = new Color(theme.bgDeep);
}

/** Called on every simulation tick with the new snapshot: pops for vanished entities; a new round rebuilds the dish. */
export function syncState(state: State): void {
  const newRound = state !== lastState;
  prevMap = newRound ? new Map() : currMap;
  currMap = entityMap(state);
  if (prevMap.size) {
    for (const [id, p] of prevMap) {
      if (!currMap.has(id)) {
        const isCell = id[0] === "c";
        spawnFx(p.x, p.y, isCell ? 14 : 4, isCell ? "#ffffff" : theme.motes[0]!, isCell ? 8 : 3);
      }
    }
  }
  lastState = state;
  if (newRound || state.arena.radius !== arenaRadius) {
    arenaRadius = state.arena.radius;
    rebuildDish();
  }
}
function rebuildDish(): void {
  if (!look || !lastState) return;
  buildEnvironment(arenaRadius);
  buildDecor(arenaRadius);
  syncBarbs(lastState);
}

/** The look for the frame's graphics level; rebuilds what it changes, cheap when nothing did. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  if (!built) build();
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  key.castShadow = shadows;
  if (shadows) key.shadow.mapSize = next.shadows;
  key.shadow.radius = next.shadows >= 4096 ? 3 : 2;
  floorHooks.uniforms!.uShadow!.value = shadows ? 0.42 : 0;
  updateEnvironment();
  fill.intensity = (next.reflections ? 0.6 : 0.8) / PI;
  const [ws, hs] = next.budget.cellSegments;
  cellGeo.dispose();
  cellGeo = new SphereGeometry(1, ws, hs);
  clearCells();
  rebuildDish();
  // Post effects, as the browser build's composer chain per preset. High
  // threshold: only emissive motes, rims, the marker and hint rings and glints bloom.
  renderer.bloom = next.bloom ? { strength: 0.45, radius: 0.2, threshold: 0.9 } : null;
  // The grade pass: 0.22 of a smoothstep S-curve, +10 % saturation, cool shadows /
  // warm highlights (split 0.25–0.85), vignette 0.26 from 0.38 to 0.9.
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.11, saturation: 1.1,
    shadows: [0.95, 1.0, 1.06], highlights: [1.04, 1.01, 0.96], split: [0.25, 0.85],
    vignette: { amount: 0.26, inner: 0.38, outer: 0.9, scale: [1, 0.9] },
  } : null;
  renderer.antialias = next.antialias;
}

export function setTheme(t: Theme, patch: { membrane: string; player: string; barb: string; motes: string[] } | null): void {
  theme = { ...t };
  if (patch) { theme.membrane = patch.membrane; theme.player = patch.player; theme.barb = patch.barb; theme.motes = patch.motes; }
  playerRimMat.color.set(theme.player).multiplyScalar(1.4);
  if (built) scene.background = new Color(theme.bgDeep);
  clearCells();
  rebuildDish();
}
export function setReducedMotion(v: boolean): void { reducedMotion = v; }
export function setHighContrast(v: boolean): void {
  if (v === highContrast) return;
  highContrast = v;
  nucleusMat.opacity = v ? 0.55 : 0.3;
  clearCells();
  rebuildDish();
}
export function setDecorSeed(seed: number): void { decorSeed = seed >>> 0; }
export function setMarker(x: number | null, y = 0, radius = 40): void {
  if (x == null) { markerGroup.visible = false; return; }
  markerGroup.visible = true;
  markerGroup.position.set(x, y, 0.4);
  markerRadius = radius;
  markerGroup.scale.set(radius, radius, 1);
}
export function setHint(x: number | null, y = 0): void {
  if (x == null) { hintGroup.visible = false; return; }
  hintGroup.visible = true;
  hintGroup.position.set(x, y, 0.6);
  hintGroup.scale.set(6, 6, 1);
}
export function shake(amount: number): void { if (!reducedMotion) { cam.shake = Math.min(6, amount); cam.shakeT = 0; } }
export function snapCamera(x: number, y: number): void { cam.x = x; cam.y = y; }

// --- per frame ------------------------------------------------------------------------------------------------
let time = 0;
const dummyM = new Matrix4();
const dummyQ = new Quaternion();
const dummyS = new Vector3();
const dummyP = new Vector3();
const zAxis = new Vector3(0, 0, 1);
const keyTmp = new Vector3();

/** Draws the frame: `alpha` between the last two ticks, `dt` seconds, the window's size in pixels. */
export function draw(alpha: number, dt: number, focus: Focus | null, width: number, height: number): void {
  time += dt;
  viewW = Math.max(1, width); viewH = Math.max(1, height);
  const nextAspect = viewW / viewH;
  if (nextAspect !== aspect) { aspect = nextAspect; updateFrustum(); }
  const state = lastState;
  if (!state || !look) { updateFrustum(); return; }

  // camera follow with critically damped smoothing
  if (focus) {
    const k = 1 - Math.exp(-CAM.FOLLOW_RATE * dt);
    let fx0 = focus.x, fy0 = focus.y;
    let targetHalf = CAM.BASE_HALF_H + focus.radius * CAM.MASS_ZOOM * 8;
    if (focus.include) {
      // Fit both the player and the goal marker in view, with a margin for the HUD bands.
      const inc = focus.include;
      const minX = Math.min(focus.x - focus.radius, inc.x - inc.radius), maxX = Math.max(focus.x + focus.radius, inc.x + inc.radius);
      const minY = Math.min(focus.y - focus.radius, inc.y - inc.radius), maxY = Math.max(focus.y + focus.radius, inc.y + inc.radius);
      fx0 = (minX + maxX) / 2; fy0 = (minY + maxY) / 2;
      const needH = (maxY - minY) / 2 / 0.7, needW = (maxX - minX) / 2 / (0.9 * aspect);
      targetHalf = Math.max(targetHalf, needH, needW);
    }
    cam.x += (fx0 - cam.x) * k;
    cam.y += (fy0 - cam.y) * k;
    targetHalf = Math.max(CAM.MIN_HALF_H, Math.min(CAM.MAX_HALF_H, targetHalf));
    const kz = 1 - Math.exp(-CAM.ZOOM_RATE * dt);
    if (Math.abs(targetHalf - cam.halfH) > 0.5) cam.halfH += (targetHalf - cam.halfH) * kz;
  }
  updateFrustum();
  let shX = 0, shY = 0;
  if (cam.shake > 0 && !reducedMotion) {
    cam.shakeT += dt * 40;
    const amp = cam.shake * Math.exp(-cam.shakeT * 0.12);
    shX = Math.sin(cam.shakeT * 1.7) * amp;
    shY = Math.cos(cam.shakeT * 2.3) * amp;
    if (amp < 0.05) cam.shake = 0;
  }
  camera.position.set(cam.x + shX, cam.y + shY, CAM_Z);
  // the key light follows the view (its shadow covers what is on screen)
  key.target.position.set(cam.x, cam.y, 0);
  keyTmp.copy(KEY_DIR).multiplyScalar(400);
  key.position.set(cam.x + keyTmp.x, cam.y + keyTmp.y, keyTmp.z);
  fill.target.position.set(cam.x, cam.y, 0);
  fill.position.set(cam.x, cam.y, 100);

  // cells
  const seen = new Set<number>();
  const pulse = reducedMotion ? 0.7 : 0.45 + Math.sin(time * 3) * 0.2;
  playerRimMat.opacity = pulse;
  for (const c of state.cells) {
    seen.add(c.id);
    let view = cellViews.get(c.id);
    const isPlayer = c.playerId === "p0";
    if (!view) {
      view = makeCellView(hueOf(state, c.playerId), isPlayer);
      cellViews.set(c.id, view);
    }
    const pos = lerpPos("c" + c.id, alpha, c);
    const r = Math.sqrt(c.mass) * 1.2;
    const breathe = reducedMotion ? 1 : 1 + Math.sin(time * 2.1 + c.id * 1.7) * 0.02;
    view.group.position.set(pos.x, pos.y, 0);
    view.outer.scale.set(r * breathe, r / breathe, r * 0.42);
    view.nucleus.scale.set(r * 0.34, r * 0.34, r * 0.2);
    if (view.rim) view.rim.scale.set(r, r, r);
    view.shadow.scale.set(r * breathe, r / breathe, 1);
  }
  for (const [id, view] of cellViews) {
    if (!seen.has(id)) { cellGroup.remove(view.group); cellViews.delete(id); }
  }

  // motes (instanced)
  let mi = 0;
  const moteScale = 1 + (reducedMotion ? 0 : Math.sin(time * 2.4) * 0.12);
  dummyS.set(moteScale, moteScale, moteScale);
  for (const mo of state.motes) {
    if (mi >= MAX_MOTES) break;
    const pos = lerpPos("m" + mo.id, alpha, mo);
    dummyP.set(pos.x, pos.y, 0.2);
    dummyQ.setFromAxisAngle(zAxis, mo.id);
    dummyM.compose(dummyP, dummyQ, dummyS);
    moteMesh.setMatrixAt(mi++, dummyM);
  }
  moteMesh.count = mi;
  moteMesh.instanceMatrix.needsUpdate = true;
  moteMat.color.set(theme.motes[0]!);
  moteMat.emissive.set(theme.motes[1]!).multiplyScalar(look.reflections ? 0.6 : 0.3);

  // pellets (instanced)
  let pi = 0;
  dummyS.set(1, 1, 1);
  for (const pe of state.pellets) {
    if (pi >= MAX_PELLETS) break;
    const pos = lerpPos("e" + pe.id, alpha, pe);
    dummyP.set(pos.x, pos.y, 0.3);
    dummyQ.setFromAxisAngle(zAxis, pe.id * 0.7);
    dummyM.compose(dummyP, dummyQ, dummyS);
    pelletMesh.setMatrixAt(pi++, dummyM);
  }
  pelletMesh.count = pi;
  if (pi > 0) pelletMesh.instanceMatrix.needsUpdate = true;
  pelletMat.color.set(theme.motes[2] ?? "#ffffff");
  pelletMat.emissive.set(theme.motes[2] ?? "#ffffff").multiplyScalar(look.reflections ? 0.7 : 0.45);

  // barbs: a slow menacing spin
  if (!reducedMotion) for (const v of barbViews) v.rotation.z += dt * 0.35;

  // the goal marker's pulse, the hint ring's
  if (markerGroup.visible) {
    const s = reducedMotion ? 1 : 1 + Math.sin(time * 2.6) * 0.08;
    markerGroup.scale.set(markerRadius * s, markerRadius * s, 1);
  }
  if (hintGroup.visible && !reducedMotion) {
    const s = 6 * (1 + Math.sin(time * 4) * 0.15);
    hintGroup.scale.set(s, s, 1);
  }

  // plankton drift and the caustic shimmer (frozen under reduced motion)
  if (decorPoints && !reducedMotion) decorPoints.rotation.z = time * 0.008;
  if (!reducedMotion) causticUniforms.uTime.value = time * 0.6;
  updateFx(dt);
}

function hueOf(state: State, playerId: string): number {
  for (const p of state.players) if (p.id === playerId) return p.hue;
  return 0;
}

/** A window point (pixels) as a dish point. */
export function screenToWorld(x: number, y: number): { x: number; y: number } {
  const nx = x / viewW, ny = y / viewH;
  return {
    x: camera.position.x + (nx - 0.5) * 2 * cam.halfH * aspect,
    y: camera.position.y + (0.5 - ny) * 2 * cam.halfH,
  };
}
/** A dish point as a window point (pixels). */
export function worldToScreen(x: number, y: number): { x: number; y: number } {
  return {
    x: ((x - camera.position.x) / (cam.halfH * aspect) * 0.5 + 0.5) * viewW,
    y: (0.5 - (y - camera.position.y) / cam.halfH * 0.5) * viewH,
  };
}
