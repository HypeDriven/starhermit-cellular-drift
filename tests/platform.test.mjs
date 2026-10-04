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
    assert.equal(await p.submitScore({}), false);
    assert.equal(p.inviteLink(), null);
    assert.equal(p.canSignIn(), false);
    assert.deepEqual(st.calls, []);
  } finally { st.restore(); }
});
