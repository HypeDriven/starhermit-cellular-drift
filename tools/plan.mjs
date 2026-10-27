// Prints the play-script lines that play a round with the keyboard: a bot
// over the unchanged rules (js/rules.js, js/content.js) that steers with the
// arrow keys the way native/main.ts reads them (the held direction sets the
// target 260 units from the player's centroid before every tick) toward the
// lesson's marker, the rules' own hint (hunt, flee) or, grazing, the nearest
// mote (one it has circled for 25 ticks is given up), deciding every tick,
// and presses E / Space when a lesson asks for ejects or a split. The round
// clock is the runtime's fixed steps, one tick a frame in a render check, and
// the script timing is simulated line by line (see below), so the planned
// score is the run's score.
//   node tools/plan.mjs <content id> [--mode learn|journey|practice|challenge] [--ticks N] [--orbit N]
// --ticks N stops after N ticks (the script then pauses or leaves the round).
// tools/gen-plays.mjs writes tests/native/*.play from these plans.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const sandbox = { self: {}, console };
vm.createContext(sandbox);
for (const f of ['js/rng.js', 'js/rules.js', 'js/content.js']) vm.runInContext(readFileSync(new URL(f, ROOT), 'utf8'), sandbox, { filename: f });
const R = sandbox.self.CDRules, C = sandbox.self.CDContent;

const args = process.argv.slice(2);
const id = args[0] || 'l1';
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const all = [...C.LESSONS.map((c) => [c, 'learn']), ...C.journeyStages().map((c) => [c, 'journey']), ...C.PRACTICE.map((c) => [c, 'practice']), ...C.CHALLENGES.map((c) => [c, 'challenge'])];
const found = all.find(([c]) => c.id === id);
if (!found) { console.error(`no content ${id}`); process.exit(1); }
const [content, defMode] = found;
const mode = opt('--mode', defMode);
const maxTicks = Number(opt('--ticks', '54000'));

const g = R.createGame(C.toConfig(content, { mode }));
const goal = g.config.goal;
const lines = [];
let held = new Set();
let presses = 0;
let idle = 0; // frames run since the last line

// Play-script timing, measured on the 1.16.1 runtime (one fixed step a frame):
// the `until` that sees the round's HUD matches on the frame of its first
// tick (frame 0); a hold, release or key line takes a frame of its own and
// what it changes reaches the game from the next frame's tick; `frames N`
// takes N + 1 frames. So every line below is simulated as the frames it takes.
function keysFor(dx, dy) {
  const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  const ks = new Set();
  const ux = Math.round(Math.cos(oct * Math.PI / 4)), uy = Math.round(Math.sin(oct * Math.PI / 4));
  if (ux > 0) ks.add('ArrowRight'); if (ux < 0) ks.add('ArrowLeft');
  if (uy > 0) ks.add('ArrowUp'); if (uy < 0) ks.add('ArrowDown');
  return ks;
}
/** The keyboard steering of native/main.ts applyStickSteering. */
function steer() {
  if (!held.size) return;
  const dx = (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0);
  const dy = (held.has('ArrowUp') ? 1 : 0) - (held.has('ArrowDown') ? 1 : 0);
  const len = Math.hypot(dx, dy);
  const c = R.centroid(g, 'p0');
  if (!c || len < 0.2) return;
  R.applyCommand(g, 'p0', { type: 'setTarget', x: c.x + dx / len * 260, y: c.y + dy / len * 260 });
}
/** One frame: the tick with the keys in effect. */
function frame() { if (g.phase === 'active') { steer(); R.step(g); } }
function flushIdle() { if (idle > 0) { lines.push(`frames ${idle - 1}`); idle = 0; } }
/** A line of its own: its frame ticks with the keys before it, then it takes effect. */
function line(text, effect) { flushIdle(); lines.push(text); frame(); effect(); }

let chase = null; // { id, since }: the mote being chased
const skip = new Set();
const ORBIT = Number(opt('--orbit', '25'));

frame(); // frame 0: the until's frame, no keys yet
while (g.phase === 'active' && g.tick < maxTicks) {
  const c = R.centroid(g, 'p0');
  let want = held;
  if (c && goal.type === 'reach-marker') {
    if (Math.hypot((goal.x || 0) - c.x, (goal.y || 0) - c.y) > 2) want = keysFor((goal.x || 0) - c.x, (goal.y || 0) - c.y);
  } else if (c) {
    const h = R.hint(g, 'p0');
    let tx = h.x, ty = h.y;
    if (h.action === 'graze') {
      // the nearest mote not given up on: one chased past ORBIT ticks (circling it) is skipped
      let best = null;
      for (const m of g.motes) {
        if (skip.has(m.id)) continue;
        const d = Math.hypot(m.x - c.x, m.y - c.y);
        if (!best || d < best.d) best = { m, d };
      }
      if (best) {
        if (!chase || chase.id !== best.m.id) chase = { id: best.m.id, since: g.tick };
        else if (g.tick - chase.since > ORBIT) { skip.add(best.m.id); chase = null; }
        tx = best.m.x; ty = best.m.y;
      }
    }
    if (tx != null && Math.hypot(tx - c.x, ty - c.y) > 2) want = keysFor(tx - c.x, ty - c.y);
  }
  const legal = R.legalActions(g, 'p0');
  const wantEject = goal.type === 'eject-count' && legal.eject.ok && g.stats.p0.ejects < (goal.count || 0);
  const wantSplit = goal.type === 'split-then-mass' && legal.split.ok && g.stats.p0.splits < (goal.splits || 1);
  const changes = [...[...held].filter((k) => !want.has(k)).map((k) => ['release', k]), ...[...want].filter((k) => !held.has(k)).map((k) => ['hold', k])];
  // a single idle frame cannot be written (`frames N` takes N + 1): idle once more first
  if ((changes.length || wantEject || wantSplit) && idle !== 1) {
    for (const [op, k] of changes) line(`${op} ${k}`, () => { if (op === 'hold') held.add(k); else held.delete(k); });
    if ((wantEject || wantSplit) && g.phase === 'active') {
      const type = wantEject ? 'eject' : 'split';
      line(`key ${wantEject ? 'KeyE' : 'Space'} 2`, () => { R.applyCommand(g, 'p0', { type, id: 'p' + ++presses }); });
    }
    continue;
  }
  frame();
  idle++;
}
flushIdle();
for (const k of [...held]) lines.push(`release ${k}`);
const bd = R.scoreBreakdown(g, 'p0');
console.log(`# plan ${id} (${mode}): ${g.terminalReason || 'running'} at tick ${g.tick}, mass ${Math.floor(R.playerMass(g, 'p0'))}, score ${bd.total}`);
console.log(lines.join('\n'));
if (args.includes('--hint')) console.log(`# hint: ${R.hint(g, 'p0').text}`);
