// Localization coverage: every English key the native client and the content
// use is translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA →
// fr-FR inherit), and placeholders survive. The client translates with T()
// and marks deferred keys with N() (native/*.ts); content names, briefs and
// descriptions, the rules' hint texts and the audio captions are keys too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { loadTables, codeKeys, audit } from './i18n-common.mjs';

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
  const keys = new Set();
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) {
    for (const k of codeKeys(read(`native/${f}`), [], ['T', 'N'])) keys.add(k);
  }
  // the audio captions (native/audio.ts CAPTIONS values)
  const caps = read('native/audio.ts').match(/export const CAPTIONS[^{]*\{([\s\S]*?)\};/)[1];
  for (const m of caps.matchAll(/:\s*"([^"]+)"/g)) keys.add(m[1]);
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

test('the native client picks the nearest shipped locale', () => {
  const src = read('native/i18n.ts');
  for (const loc of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) assert.ok(src.includes(`"${loc}"`), loc);
});
