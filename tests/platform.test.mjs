// platform.test.mjs — js/platform.js on top of starhermit-sdk.js with a
// stubbed fetch and launch fragment: token read, profile nickname, cloud save
// round-trip on game:<slug>, settings KV patch, bindings, and no network at
// all when standalone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installHosted, installStandalone, UID } from './starhermit-harness.mjs';
import { createPlatform } from '../js/platform.js';

const SLUG = 'cellular-drift';

test('hosted: token, profile, cloud save game:<slug>, settings, bindings, invite', async () => {
  const { sdk, env, win } = installHosted(SLUG);
  assert.equal(sdk.userId, UID);
  assert.equal(sdk.slug, SLUG);
  assert.equal(sdk.launchSessionId, 's1');
  assert.ok(!/game_token/.test(win.history.url || ''), 'fragment stripped');

  const p = createPlatform();
  await p.init();
  assert.ok(p.hosted);
  assert.equal(p.gameSlug, SLUG);
  assert.equal((await p.fetchProfile()).name, 'Ada');

  assert.equal(await p.loadCloud(), null);
  const wrapped = JSON.stringify({ sum: 'abc', payload: JSON.stringify({ v: 1, progress: { x: 7 } }) });
  p.onLocalSave(wrapped);
  assert.equal(await p.flushSave(), true);
  const put = env.calls.find((c) => c.method === 'PUT');
  assert.ok(put.url.endsWith('/cloud-saves/game%3Acellular-drift'), put.url);
  assert.equal(put.init.headers.Authorization, 'Bearer ' + sdk.token);
  assert.equal(await p.loadCloud(), wrapped, 'cloud round-trip');
  assert.equal(p.sync, 'synced');

  assert.deepEqual((await p.getSettings()).seeded, { fromPlatform: true });
  await p.patchSettings({ music: 0.3 });
  assert.equal(env.settings.music, 0.3, 'settings patched');

  await p.loadBindings();
  assert.equal(p.actionFor({ code: 'KeyW' }), 'up');
  assert.equal(p.actionFor({ code: 'Space' }), 'split');
  assert.equal(p.actionFor({ key: 'e' }), 'eject');
  assert.equal(p.inviteLink(), `https://dashboard.starhermit.com/game-invite/${UID}/${SLUG}`);
  assert.equal(p.canSignIn(), false);
});

test('standalone: no token, no network', async () => {
  const st = installStandalone();
  try {
    const p = createPlatform();
    const r = await p.init();
    assert.equal(r.hosted, false);
    assert.equal(await p.loadCloud(), null);
    p.onLocalSave('{}');
    await p.flushSave();
    assert.deepEqual(await p.getSettings(), {});
    await p.patchSettings({ music: 1 });
    await p.loadBindings();
    assert.equal(p.actionFor({ code: 'KeyP' }), 'pause');
    assert.deepEqual(await p.submitScore(100), { posted: false, rank: null });
    assert.equal(p.inviteLink(), null);
    assert.equal(p.canSignIn(), false);
    assert.deepEqual(st.calls, []);
  } finally { st.restore(); }
});

test('save conflict: a write that loses to another device reloads the cloud copy for merging', async () => {
  const { loadSdkFactory, fakeWindow, jwt, resp } = await import('./starhermit-harness.mjs');
  const cloud = { bytes: null, etag: null };
  const slot = `/api/v1/me/cloud-saves/${encodeURIComponent('game:' + SLUG)}`;
  const fetchStub = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url);
    if (path === slot + '/info') return resp(200, cloud.bytes ? { exists: true, etag: cloud.etag } : { exists: false });
    if (path === slot) {
      if (method === 'PUT') {
        const h = init.headers || {};
        if ((h['If-Match'] && h['If-Match'] !== cloud.etag) || (h['If-None-Match'] === '*' && cloud.bytes)) return resp(412, { etag: cloud.etag });
        cloud.bytes = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        cloud.etag = '"v' + Date.now() + '"';
        return resp(200, { etag: cloud.etag });
      }
      return cloud.bytes ? resp(200, null, new Uint8Array(cloud.bytes)) : resp(404, null);
    }
    return resp(404, null);
  };
  const win = fakeWindow('#game_token=' + jwt({ sub: UID, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 }));
  globalThis.window = win;
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {}, documentElement: { lang: 'en-US' } };
  const sdk = loadSdkFactory().create({ window: win, fetch: fetchStub, setTimeout: () => 0, clearTimeout: () => {} });
  globalThis.StarHermit = sdk.init();
  const p = createPlatform();
  await p.init();
  assert.equal(await p.loadCloud(), null);
  const other = JSON.stringify({ sum: 'x', payload: JSON.stringify({ v: 1, progress: { lessonsDone: { l1: true } } }) });
  cloud.bytes = Buffer.from(sdk._zip('save.json', new TextEncoder().encode(other)));
  cloud.etag = '"other"';
  const merged = new Promise((resolve) => p.onConflict(resolve));
  p.onLocalSave(JSON.stringify({ sum: 'y', payload: JSON.stringify({ v: 1, progress: {} }) }));
  assert.equal(await p.flushSave(), false);
  assert.equal(await merged, other, 'the other device\'s save is handed over for merging');
  assert.equal(sdk.saveConflicted(), false, 'writes are allowed again after the reload');
  p.onLocalSave(other);
  assert.equal(await p.flushSave(), true, 'merged save lands');
});

test('mergeProgress keeps the better of both devices', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const sandbox = { self: {} };
  vm.runInNewContext(readFileSync(new URL('../js/store.js', import.meta.url), 'utf8'), sandbox);
  const S = sandbox.self.CDStore;
  const local = S.fresh(), remote = S.fresh();
  local.settings.music = 0.1;
  local.progress.journeyStars = { j01: 3 }; remote.progress.journeyStars = { j01: 1, j02: 2 };
  local.progress.lessonsDone = { l1: true }; remote.progress.lessonsDone = { l2: true };
  local.progress.achievements = { 'first-round': 500 }; remote.progress.achievements = { 'first-round': 100, 'first-win': 300 };
  local.progress.stats.rounds = 4; remote.progress.stats.rounds = 9; local.progress.stats.splits = 50;
  const m = S.mergeProgress(local, remote);
  assert.deepEqual({ ...m.progress.journeyStars }, { j01: 3, j02: 2 });
  assert.deepEqual({ ...m.progress.lessonsDone }, { l2: true, l1: true });
  assert.deepEqual({ ...m.progress.achievements }, { 'first-round': 100, 'first-win': 300 });
  assert.equal(m.progress.stats.rounds, 9);
  assert.equal(m.progress.stats.splits, 50);
  assert.equal(m.settings.music, 0.1, 'this device keeps its settings');
});
