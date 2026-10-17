import { test } from 'node:test';
import '../js/gpu-level.js'; // window.StarHermitGpu (globalThis in Node)
import assert from 'node:assert/strict';
import { detectPreset, detectLevel, presetForLevel, BUDGETS, resolve, presetTier, withPreset, describe, CATEGORIES, PRESETS } from '../js/gfx.js';

const desk = { webgl: true, webgl2: true, cores: 8, memoryGb: 8 };
const phone = { webgl: true, webgl2: true, mobile: true, cores: 8, memoryGb: 8 };

test('hardware level → preset: Low 0, Balanced 4, High 10, Ultra 17', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', desk), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', desk), 0);
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0)', desk), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', desk), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', desk), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', desk), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', desk), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', desk), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', desk), 'ultra');
  assert.equal(detectPreset('', desk), 'balanced');
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are capped at Balanced; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', phone), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', phone) <= 9);
  assert.equal(detectPreset('NVIDIA GeForce RTX 5090', phone), 'balanced');
  assert.equal(detectPreset('Mali-G77', phone), 'low');
  assert.equal(detectPreset('SwiftShader', phone), 'low');
});

test('every preset has an explicit budget that grows from Low to Ultra and scales with the level', () => {
  const order = ['low', 'balanced', 'high', 'ultra'];
  const keys = ['dprCap', 'floorTexture', 'material', 'particles', 'decor'];
  for (const p of order) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < order.length; i++) {
    for (const k of keys) if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[order[i]][k] >= BUDGETS[order[i - 1]][k], `${order[i]}.${k}`);
  }
  const u17 = resolve({ preset: 'ultra' }, 'ultra', 17).budget;
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, u17, 'a manual Ultra on a weak GPU keeps the Ultra floor budget');
  const l0 = resolve({ preset: 'low' }, 'low', 0).budget, l3 = resolve({ preset: 'low' }, 'low', 3).budget;
  for (const k of keys) if (typeof l0[k] === 'number') assert.ok(l3[k] >= l0[k], `low.${k} scales up with the level`);
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
