// Writes the native play scripts (tests/native/*.play) from their templates
// and the rules bot's plans (tools/plan.mjs): each round is played by the
// plan's held arrow keys and E / Space presses, so its planned score is the
// score the results show. Run after a rules or content change, then
// `npm test`.
//   node tools/gen-plays.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
function plan(id, ...extra) {
  const out = execFileSync('node', ['tools/plan.mjs', id, ...extra], { cwd: root, encoding: 'utf8' }).trim();
  const head = out.split('\n')[0];
  const score = /score (\d+)/.exec(head)[1];
  const hint = (/^# hint: (.*)$/m.exec(out) || [])[1] || '';
  return { lines: out, score, hint };
}
function write(name, text) {
  writeFileSync(new URL(`tests/native/${name}`, root), text.trim() + '\n');
  console.log(`wrote tests/native/${name}`);
}
const l1 = plan('l1'), l2 = plan('l2'), l3 = plan('l3'), l4 = plan('l4'), j01 = plan('j01');
const calm = plan('calm', '--ticks', '150', '--hint');

write('learn-lessons.play', `
# Learn: Play → Learn → lesson 1 (Drift) steered to the marker with the arrow
# keys, Back to modes, then lesson 2 (Graze) played to 60 mass by the rules
# bot's plan (tools/plan.mjs, written by tools/gen-plays.mjs: the held arrows
# set the target before every tick, one tick a frame in a render check, so
# the planned score is the score), each through the results with its
# breakdown; the lesson list then marks both done.
until 300 Play
frames 60
save title
click Play
until 60 Choose a mode
frames 10
save modes
click Learn
until 60 Graze
frames 10
save lessons
click Drift
until 30 Rank 1/1
${l1.lines}
until 200 Goal complete!
expect Objective bonus
expect Total score: ${l1.score}
expect Achievement unlocked: First drift, Objective met, Arena champion
frames 30
save drift-results
click Back to modes
until 60 Choose a mode
frames 10
click Learn
until 60 Graze
frames 10
click Graze
until 30 Reach 60 mass
${l2.lines}
until 300 Goal complete!
expect Total score: ${l2.score}
frames 30
save graze-results
click Back to modes
until 60 Choose a mode
frames 10
click Learn
until 60 Graze
frames 20
expect done
save lessons-done
`);

write('learn-actions.play', `
# Learn: lesson 3 (Eject: E sheds pellets, five of them) and lesson 4
# (Divide: Space splits once, then grow back to 70), played by the rules
# bot's plans with the E and Space presses they ask for; Retry from the
# results restarts the lesson, and Escape pauses it for Leave to modes.
until 300 Play
frames 30
click Play
until 60 Choose a mode
frames 10
click Learn
until 60 Graze
frames 10
click Eject
until 30 Eject 5 pellets
${l3.lines}
until 300 Goal complete!
expect Total score: ${l3.score}
frames 30
save eject-results
click Back to modes
until 60 Choose a mode
frames 10
click Learn
until 60 Graze
frames 10
click Divide
until 30 then reach 70 mass
${l4.lines}
until 300 Goal complete!
expect Total score: ${l4.score}
frames 30
save divide-results
click Retry
until 60 then reach 70 mass
frames 20
key Escape 2
until 30 Paused
frames 10
click Leave to modes
until 60 Choose a mode
`);

write('journey-stage.play', `
# Journey: stage 1 (First Culture) from the Journey list, grazed to 80 mass
# by the rules bot's plan well inside its par, so the results show the
# planned score and the list marks the stage done with three stars.
until 300 Play
frames 30
click Play
until 60 Choose a mode
frames 10
click Journey
until 60 First Culture
frames 10
save journey
click First Culture
until 30 Reach 80 mass
${j01.lines}
save journey-play
until 300 Goal complete!
expect Total score: ${j01.score}
frames 30
save journey-results
click Back to modes
until 60 Choose a mode
frames 10
click Journey
until 60 First Culture
frames 20
expect done ★ ★ ★
save journey-done
`);

write('practice-pause.play', `
# Practice: Calm from the practice list, a few seconds of the rules bot's
# grazing; H shows the hint (its caption), Space with a small cell is
# refused with the reason; Escape pauses: the pause screen's own options
# (captions, the colour-vision-safe palette) and the note on the
# StarHermit Options, Resume, Restart round, Leave to modes; then Escape back
# to the title, Help & rules and Close.
until 300 Play
frames 30
click Play
until 60 Choose a mode
frames 10
click Practice
until 60 Calm
frames 10
save practice
click Calm
until 30 Reach 100 mass
${calm.lines}
frames 5
key KeyH 2
until 10 ${calm.hint}
save practice-hint
key Space 2
until 10 Cannot split
expect your cells are too small
frames 5
key Escape 2
until 30 Paused
frames 10
expect Captions / text cues
expect StarHermit Options
save pause
click Color-vision-safe palette
frames 30
save pause-cvd
click Color-vision-safe palette
frames 10
click Resume
until 30 Reach 100 mass
frames 30
key Escape 2
until 30 Paused
frames 10
click Restart round
until 30 Mass 20 / 100
frames 30
key Escape 2
until 30 Paused
frames 10
click Leave to modes
until 60 Choose a mode
frames 10
key Escape 2
until 60 Help & rules
frames 10
click Help & rules
until 60 Touch: drag or tap
frames 10
save help
click Close
until 60 Play
`);

write('daily-challenge.play', `
# The daily (today's from the platform's clock, the device's UTC date in a
# check) from Daily Challenge → Begin the day, paused and left; then the
# Lean Drift challenge, where E is refused (ejecting is off in this round),
# played on to its pause and left; Escape walks back to the title.
until 300 Play
frames 30
click Play
until 60 Choose a mode
frames 10
click Daily Challenge
until 60 Begin the day
frames 10
expect Ranked.
save daily
click Begin the day
until 30 · Rank 
frames 90
save daily-play
key Escape 2
until 30 Paused
frames 10
click Leave to modes
until 60 Choose a mode
frames 10
click Challenge
until 60 Lean Drift
frames 10
save challenges
click Lean Drift
until 30 Reach 140 mass
frames 30
key KeyE 2
until 10 Cannot eject
expect ejecting is off in this round
save challenge-play
frames 5
key Escape 2
until 30 Paused
frames 10
click Leave to modes
until 60 Choose a mode
frames 10
key Escape 2
until 60 Help & rules
`);
