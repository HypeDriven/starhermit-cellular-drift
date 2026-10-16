// Localization coverage: every English key the code and content use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, and the language follows sh-language.js and
// switches live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadTables, codeKeys, audit, bootI18n } from './i18n-common.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

function content() {
  const sandbox = { self: {}, console };
  sandbox.window = sandbox.self;
  vm.createContext(sandbox);
  for (const f of ['js/rng.js', 'js/rules.js', 'js/content.js']) vm.runInContext(read(f), sandbox, { filename: f });
  return sandbox.self.CDContent || sandbox.CDContent;
}

export function usedKeys() {
  const keys = new Set(codeKeys(read('js/app.js'), ['tr', 'L'], ['N']));
  codeKeys(read('index.html'), ['tr', 'T'], []).forEach((k) => keys.add(k));
  const C = content();
  for (const l of C.LESSONS) { keys.add(l.name); if (l.brief) keys.add(l.brief); }
  for (const s of C.journeyStages()) keys.add(s.name);
  for (const p of C.PRACTICE) { keys.add(p.name); if (p.description) keys.add(p.description); }
  for (const c of C.CHALLENGES) { keys.add(c.name); if (c.description) keys.add(c.description); }
  for (const m of read('js/rules.js').matchAll(/text: '((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
  for (const m of read('js/rules.js').matchAll(/text: \w+ \? '((?:[^'\\]|\\.)*)' : '((?:[^'\\]|\\.)*)'/g)) { keys.add(m[1]); keys.add(m[2]); }
  return [...keys].filter((k) => /[A-Za-z]/.test(k)).sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'CD_STRINGS'), usedKeys()), []);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'CDI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Resume'), 'Fortsetzen');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  I18N.language.setChoice('en-GB');
  assert.equal(I18N.T('Color-vision-safe palette'), 'Colour-vision-safe palette');
});
