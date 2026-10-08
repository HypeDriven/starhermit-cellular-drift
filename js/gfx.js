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

/**
 * Best preset for this GPU, from the WEBGL_debug_renderer_info unmasked renderer
 * string. Software renderers get Low, discrete GPUs / Apple M get High, the rest
 * Balanced. Touch/mobile devices are capped at Balanced.
 */
export function detectPreset(gpu, mobile) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?!.*graphics)|apple m\d/.test(g)) p = 'high';
  if (mobile && PRESETS.indexOf(p) > PRESETS.indexOf('balanced')) p = 'balanced';
  return p;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = { preset, auto, scale: row.scale * clamp(Number(s.render_scale) || 1, 0.5, 2) };
  for (const cat of Object.keys(CATEGORIES)) {
    out[cat] = CATEGORIES[cat].includes(s[cat]) ? s[cat] : row[cat];
  }
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
