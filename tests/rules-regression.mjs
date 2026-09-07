import assert from 'node:assert/strict';
globalThis.self = globalThis;
await import('../js/rng.js');
await import('../js/rules.js');
await import('../js/content.js');
const R = globalThis.CDRules, C = globalThis.CDContent;

function run() {
  const game = R.createGame(C.toConfig(C.PRACTICE[1], { mode: 'practice' }));
  for (let i = 0; i < 600; i++) {
    if (i % 30 === 0) R.applyCommand(game, 'p0', { type: 'setTarget', x: i, y: -i });
    R.step(game);
  }
  return R.stateHash(game);
}
assert.equal(run(), run(), 'identical seeded commands must produce identical states');
const game = R.createGame(C.toConfig(C.PRACTICE[0], { mode: 'practice' }));
R.applyCommand(game, 'p0', { type: 'split', id: 'duplicate-check' });
const restored = R.deserialize(R.serialize(game));
assert.equal(R.applyCommand(restored, 'p0', { type: 'split', id: 'duplicate-check' }).reason, 'duplicate');

const challenge = R.createGame(C.toConfig(C.CHALLENGES.find(c => c.id === 'c-gentle'), { mode: 'challenge' }));
challenge.motes = []; challenge.pellets = []; challenge.barbs = [];
challenge.cells = [
  { id: 9001, playerId: 'p0', x: 0, y: 0, mass: 100 },
  { id: 9002, playerId: 'p1', x: 1, y: 0, mass: 40 },
].map(cell => ({ vx: 0, vy: 0, ix: 0, iy: 0, bornTick: 0, lastSplitTick: -24, mergeAfter: 0, ...cell }));
R.step(challenge);
assert.equal(challenge.terminalReason, 'constraint-violated');
assert.equal(challenge.cells.length, 1);
assert.equal(challenge.cells[0].mass, 140, 'forbidden absorption must add prey mass only once');
assert.equal(challenge.stats.p0.rivalMass, 40);

for (const content of [...C.LESSONS, ...C.journeyStages(), ...C.PRACTICE, ...C.CHALLENGES, C.dailyFor(new Date())]) {
  assert.deepEqual(C.validateContent(content), [], content.id);
}
console.log('Rules regression and all content validation passed.');
