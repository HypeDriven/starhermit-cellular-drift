// The engine save document and what the browser build left in the player's
// account (js/migrate.js): the foreign cloud save (the SDK's checksummed
// { sum, payload } document) read and merged, the engine save's conflict
// merge, and the per-player settings kept or dropped. The signed-in paths
// cannot run here (no account), so their logic is covered by these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const sandbox = { self: {}, console, localStorage: { getItem: () => null, setItem() {} } };
vm.createContext(sandbox);
for (const f of ['js/store.js', 'js/migrate.js']) vm.runInContext(readFileSync(new URL(f, ROOT), 'utf8'), sandbox, { filename: f });
const S = sandbox.self.CDStore, M = sandbox.self.CDMigrate;
const plain = (o) => JSON.parse(JSON.stringify(o));

/** The browser build's cloud save text: the wrapped string CDStore.save mirrored through the SDK. */
function browserSave(doc) {
  const payload = JSON.stringify(doc);
  return JSON.stringify({ sum: S.checksum(payload), payload });
}

test('the browser build\'s cloud save reads back whole', () => {
  const doc = S.fresh();
  doc.progress.journeyStars.j01 = 3;
  doc.progress.lessonsDone.l1 = true;
  doc.progress.stats.rounds = 42;
  doc.progress.dailyStreak = { last: '2026-10-01', count: 4 };
  doc.settings.captions = true;
  doc.settings.cvdPalette = true;
  doc.settings.music = 0.2;
  const back = M.docFromBrowserSave(browserSave(doc));
  assert.equal(back.progress.journeyStars.j01, 3);
  assert.equal(back.progress.lessonsDone.l1, true);
  assert.equal(back.progress.stats.rounds, 42);
  assert.equal(back.progress.dailyStreak.count, 4);
  assert.equal(back.settings.captions, true);
  assert.equal(back.settings.cvdPalette, true);
});
test('an old browser save without newer progress fields still reads (they come back fresh)', () => {
  const payload = JSON.stringify({ v: 1, settings: {}, progress: { lessonsDone: { l2: true }, stats: { rounds: 3 } } });
  const back = M.docFromBrowserSave(JSON.stringify({ sum: S.checksum(payload), payload }));
  assert.equal(back.progress.lessonsDone.l2, true);
  assert.deepEqual(plain(back.progress.practiceDone), {});
  assert.deepEqual(plain(back.progress.challengeDone), {});
});
test('a corrupt or future browser save is refused', () => {
  assert.equal(M.docFromBrowserSave('not json'), null);
  assert.equal(M.docFromBrowserSave(JSON.stringify({ sum: 'x', payload: '{}' })), null);
  assert.equal(M.docFromBrowserSave(browserSave({ v: 99, progress: {} })), null);
  assert.equal(M.docFromBrowserSave(null), null);
});
test('the engine save document round-trips its progress', () => {
  const p = S.fresh().progress;
  p.dailiesDone['2026-10-01'] = 820;
  const doc = plain(M.saveDoc(p));
  assert.equal(doc.v, 1);
  assert.equal(M.progressFromSave(doc).dailiesDone['2026-10-01'], 820);
  assert.equal(M.progressFromSave({ v: 2, progress: p }), null);
  assert.equal(M.progressFromSave(null), null);
  assert.equal(M.progressFromSave({ v: 1, progress: [] }), null);
});
test('two devices\' progress merges: better records, every done mark, achievements at their earliest', () => {
  const a = S.fresh().progress, b = S.fresh().progress;
  a.journeyStars = { j01: 3, j02: 1 }; b.journeyStars = { j02: 2, j03: 1 };
  a.challengeBest = { 'c-lean': 800 }; b.challengeBest = { 'c-lean': 950 };
  a.lessonsDone = { l1: true }; b.lessonsDone = { l2: true };
  a.practiceDone = { calm: true };
  a.dailiesDone = { '2026-10-02': 500 }; b.dailiesDone = { '2026-10-02': 700, '2026-10-03': 300 };
  a.dailyStreak = { last: '2026-10-02', count: 2 }; b.dailyStreak = { last: '2026-10-03', count: 3 };
  a.stats.rounds = 7; b.stats.rounds = 4; a.stats.splits = 3; b.stats.splits = 5;
  a.achievements = { 'first-win': 200 }; b.achievements = { 'first-win': 100, 'rounds-25': 300 };
  const m = plain(M.mergeProgress(b, a));
  assert.deepEqual(m.journeyStars, { j01: 3, j02: 2, j03: 1 });
  assert.equal(m.challengeBest['c-lean'], 950);
  assert.deepEqual(m.lessonsDone, { l1: true, l2: true });
  assert.deepEqual(m.practiceDone, { calm: true });
  assert.deepEqual(m.dailiesDone, { '2026-10-02': 700, '2026-10-03': 300 });
  assert.deepEqual(m.dailyStreak, { last: '2026-10-03', count: 3 });
  assert.equal(m.stats.rounds, 7);
  assert.equal(m.stats.splits, 5);
  assert.deepEqual(m.achievements, { 'first-win': 100, 'rounds-25': 300 });
  assert.deepEqual(plain(M.mergeProgress(null, null)), plain(S.fresh().progress));
  assert.equal(M.mergeProgress(a, null).journeyStars.j01, 3);
  assert.equal(M.mergeProgress(null, b).journeyStars.j03, 1);
});
test('the browser build\'s settings: the game\'s own options carry over, the runtime\'s are dropped', () => {
  assert.equal(M.migrateSetting('captions', true), true);
  assert.equal(M.migrateSetting('cvdPalette', false), false);
  assert.equal(M.migrateSetting('theme', 'cinder'), 'cinder');
  assert.equal(M.migrateSetting('theme', 'plaid'), undefined);
  assert.equal(M.migrateSetting('captions', 'yes'), undefined);
  for (const k of ['music', 'effects', 'ambience', 'voice', 'muted', 'graphics', 'reducedMotion', 'highContrast', 'largeText', 'leftHanded', 'ui.language']) {
    assert.equal(M.migrateSetting(k, true), undefined, k);
  }
  for (const k of ['music', 'graphics', 'captions', 'cvdPalette', 'theme', 'ui.language', 'audio.options']) assert.ok(M.BROWSER_SETTING_KEYS.includes(k), k);
  assert.deepEqual([...M.GAME_SETTING_KEYS].sort(), ['captions', 'cvdPalette', 'theme']);
});
