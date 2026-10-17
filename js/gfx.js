/*
 * Cellular Drift — graphics quality model: presets, per-category overrides,
 * GPU detection and a cost summary. Pure (no three.js, no DOM) so the settings
 * panel, the renderer and node tests agree on what a setting means.
 */

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category -> allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],   // key-light shadows of cells/barbs on the dish floor
  bloom: ['off', 'on'],                        // glow on motes, rims, marker and hint rings
  grade: ['off', 'on'],                        // colour grade + vignette
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],                  // image-based lighting (room environment) on membranes
  particles: ['low', 'high'],                  // drifting plankton count + burst particle budget
  background: ['static', 'animated'],          // caustic light shimmer across the dish
  detail: ['plain', 'detailed'],               // floor texture resolution/cell pattern, glossy membranes
};

// Each preset is a row of tiers plus a render scale (multiplies the device pixel ratio).
const TABLE = {
  low: { scale: 0.85, shadows: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', particles: 'low', background: 'static', detail: 'plain' },
  balanced: { scale: 1, shadows: 'low', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  high: { scale: 1, shadows: 'medium', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { scale: 1.25, shadows: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD, 20 = RTX 5090;
// gpu-level.js → window.StarHermitGpu): Low from 0, Balanced from 4, High from 10, Ultra from 17.
// Phones, tablets and ≤ 4 GB machines are capped at level 9 (Balanced); software renderers are level 0.
export const PRESET_LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

function gpuApi() { return globalThis.StarHermitGpu; }

/** Hardware level (0–20) for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  if (!G) return PRESET_LEVELS.balanced;
  return G.detectLevel({ ...(system || {}), gpu: String(gpu || '') });
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  if (G) return G.presetForLevel(level, PRESET_LEVELS);
  return level >= 17 ? 'ultra' : level >= 10 ? 'high' : level >= 4 ? 'balanced' : 'low';
}

/** Best preset for this GPU (the level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/** Scale a count tuned at the preset's floor level up for faster GPUs (≤ 4×, never below the floor budget). */
export function scaleCount(n, preset, level) {
  const G = gpuApi();
  const floor = PRESET_LEVELS[preset] || 0;
  return Math.round(G ? G.scaleBudget(n, Math.max(Number(level) || 0, floor), floor) : n);
}

/**
 * Per-preset asset and effect budget. Each preset is tuned to hold 60 FPS on the weakest GPU Auto gives
 * it (Low → hardware level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs).
 *   dprCap       device-pixel-ratio ceiling (before the preset's render scale);
 *   floorTexture dish-floor texture edge in px (Surface detail plain uses half);
 *   cellSegments membrane sphere [width, height] segments; material: 'lambert' | 'standard' | 'physical'
 *                (clearcoat + iridescence when Surface detail is detailed);
 *   particles    burst-particle budget and decor = drifting plankton at the floor level (the Particles
 *                tier still caps both). Counts scale up within the preset on faster GPUs
 *                (StarHermitGpu.scaleBudget, ≤ 4×, never below the floor budget).
 */
export const BUDGETS = {
  low: { dprCap: 1, floorTexture: 512, cellSegments: [16, 10], material: 'lambert', particles: 200, decor: 50 },
  balanced: { dprCap: 1.5, floorTexture: 1024, cellSegments: [24, 16], material: 'standard', particles: 500, decor: 120 },
  high: { dprCap: 2, floorTexture: 1024, cellSegments: [28, 20], material: 'physical', particles: 900, decor: 200 },
  ultra: { dprCap: 2, floorTexture: 2048, cellSegments: [40, 28], material: 'physical', particles: 1200, decor: 320 },
};
export const PARTICLE_CAP = { low: 300, high: 1200 }; // per Particles tier
export const DECOR_CAP = { low: 60, high: 480 };

/** A preset's concrete budget for a hardware level and Particles tier. */
export function budgetFor(preset, level, particles = 'high') {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  b.particles = Math.min(PARTICLE_CAP[particles] || PARTICLE_CAP.low, scaleCount(b.particles, preset, level));
  b.decor = Math.min(DECOR_CAP[particles] || DECOR_CAP.low, scaleCount(b.decor, preset, level));
  return b;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = { preset, auto, scale: row.scale * clamp(Number(s.render_scale) || 1, 0.5, 2) };
  for (const cat of Object.keys(CATEGORIES)) {
    out[cat] = CATEGORIES[cat].includes(s[cat]) ? s[cat] : row[cat];
  }
  out.budget = budgetFor(preset, level, out.particles);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise the canvas MSAA is used.
  out.post = out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  const row = TABLE[preset];
  return row ? row[cat] : undefined;
}

/** Choosing a preset clears every per-category override; scale/adaptive/fps are kept. */
export function withPreset(saved, preset) {
  const s = saved || {};
  const out = { preset: PRESETS.includes(preset) ? preset : 'auto' };
  if (s.render_scale != null) out.render_scale = s.render_scale;
  if (s.adaptive === false) out.adaptive = false;
  if (s.show_fps) out.show_fps = true;
  return out;
}

/** Short English cost summary (the panel localises the surrounding labels). */
export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? 'no shadows' : SHADOW_MAP[r.shadows] + '² shadows',
    r.bloom === 'on' ? 'bloom' : null,
    r.grade === 'on' ? 'grade' : null,
    r.reflections === 'on' ? 'reflections' : null,
    r.antialias === 'off' ? 'no AA' : r.antialias.toUpperCase(),
    pixels ? pixels[0] + '×' + pixels[1] + ' px' : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
