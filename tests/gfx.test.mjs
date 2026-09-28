import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, presetTier, withPreset, describe, CATEGORIES, PRESETS } from '../js/gfx.js';

test('detectPreset classifies GPU strings', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'high');
  assert.equal(detectPreset('Apple M2 Pro'), 'high');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon RX 6800 XT)'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 650'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
  assert.equal(detectPreset(null), 'balanced');
});

test('mobile caps Auto at balanced', () => {
  assert.equal(detectPreset('Apple M1', true), 'balanced');
  assert.equal(detectPreset('SwiftShader', true), 'low');
});

test('resolve: auto uses detected preset', () => {
  const r = resolve({}, 'low');
  assert.equal(r.preset, 'low');
  assert.equal(r.auto, true);
  assert.equal(r.shadows, 'off');
  assert.equal(r.post, false);
  assert.equal(r.adaptive, true);
  assert.equal(r.showFps, false);
  assert.equal(resolve(null, undefined).preset, 'balanced');
});

test('resolve: explicit preset and overrides', () => {
  const r = resolve({ preset: 'high', bloom: 'off', shadows: 'bogus' }, 'low');
  assert.equal(r.preset, 'high');
  assert.equal(r.auto, false);
  assert.equal(r.bloom, 'off');
  assert.equal(r.shadows, presetTier('high', 'shadows'));
  assert.equal(r.post, true);
  for (const cat of Object.keys(CATEGORIES)) assert.ok(CATEGORIES[cat].includes(r[cat]), cat);
});

test('resolve: render scale is clamped 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).scale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).scale, 0.5);
  assert.equal(resolve({ preset: 'high', render_scale: 1.5 }).scale, 1.5);
  assert.equal(resolve({ preset: 'low' }).scale, 0.85);
});

test('choosing a preset clears overrides but keeps scale/adaptive/fps', () => {
  const s = withPreset({ preset: 'high', bloom: 'off', particles: 'low', render_scale: 1.2, adaptive: false, show_fps: true }, 'ultra');
  assert.deepEqual(s, { preset: 'ultra', render_scale: 1.2, adaptive: false, show_fps: true });
  assert.equal(withPreset({ bloom: 'off' }, 'auto').preset, 'auto');
});

test('every preset defines every category and describe() summarises', () => {
  for (const p of PRESETS) for (const cat of Object.keys(CATEGORIES)) assert.ok(CATEGORIES[cat].includes(presetTier(p, cat)), p + '.' + cat);
  assert.match(describe(resolve({ preset: 'high' }), [1280, 800]), /2048² shadows.*SMAA.*1280×800 px/);
  assert.match(describe(resolve({ preset: 'low' })), /no shadows/);
});

test('Graphics panel strings exist in every locale', async () => {
  const { STRINGS, LOCALES, pickLocale, gfxStrings } = await import('../js/gfx-i18n.js');
  for (const l of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) assert.ok(LOCALES.includes(l), l);
  const keys = Object.keys(STRINGS['en-US']);
  for (const l of LOCALES) assert.deepEqual(Object.keys(STRINGS[l]).sort(), [...keys].sort(), l);
  for (const cat of Object.keys(CATEGORIES)) {
    assert.ok(keys.includes('cat_' + cat), cat);
    for (const tier of CATEGORIES[cat]) assert.ok(keys.includes('t_' + tier), tier);
  }
  assert.equal(pickLocale('de'), 'de-DE');
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('xx'), 'en-US');
  assert.equal(gfxStrings('it-IT')('auto', { tier: 'Alta' }), 'Automatica (rilevata: Alta)');
});
