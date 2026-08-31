/*
 * Cellular Drift — rules engine.
 * Pure, deterministic, serializable. No rendering, no DOM, no timers.
 * UMD: usable from the browser (window.CDRules) and from Node (server/tests).
 *
 * The simulation is a fixed-step (TICK_RATE per second) realtime mass arena:
 * players steer a cell, absorb nutrient motes, pellets and smaller rival
 * cells, split to attack or travel, and eject mass. All randomness flows
 * through one seeded rules stream so replays are bit-identical.
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.CDRNG;
  if (typeof module === 'object' && module.exports) module.exports = factory(RNG);
  else root.CDRules = factory(RNG);
}(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var RULES_VERSION = 1;
  var TICK_RATE = 30;                       // fixed simulation steps per second
  var MAX_TICKS = TICK_RATE * 60 * 30;      // hard bound: 30 sim-minutes

  // ---- Tunables (fixed for a rules version; never change without bumping RULES_VERSION)
  var RADIUS_SCALE = 1.2;                   // radius = sqrt(mass) * RADIUS_SCALE (mass ~ membrane area)
  var START_MASS = 20;
  var MOTE_MASS = 1;
  var BASE_SPEED = 6.4;                     // units/tick at START_MASS
  var MIN_SPEED = 1.7;
  var SPEED_EXP = 0.28;                     // bigger cells are slower
  var STEER_LERP = 0.18;                    // velocity steering factor per tick
  var EAT_RATIO = 1.15;                     // eater mass must exceed prey mass * EAT_RATIO
  var EAT_OVERLAP = 0.35;                   // prey center must be inside eater.radius - prey.radius*EAT_OVERLAP
  var MIN_SPLIT_MASS = 32;                  // a cell needs at least this to divide
  var SPLIT_IMPULSE = 24;                   // launched-half impulse (units/tick, decays)
  var IMPULSE_FRICTION = 0.90;
  var SPLIT_COOLDOWN_TICKS = 24;            // per-cell cooldown after dividing
  var MAX_CELLS = 16;                       // per player
  var RECOMBINE_TICKS = 30 * 20;            // split halves may merge after 20s
  var MIN_EJECT_MASS = 22;                  // a cell needs at least this to eject
  var PELLET_MASS = 3;
  var EJECT_COOLDOWN_TICKS = 5;             // per player
  var PELLET_SPEED = 13;
  var PELLET_FRICTION = 0.90;
  var PELLET_SELF_DELAY = 40;               // owner may re-absorb a pellet after this many ticks
  var BARB_BURST_MASS = 60;                 // cells at/above this mass burst on a barb
  var BARB_RADIUS = 8;
  var BURST_MIN_PIECE = 12;
  var BURST_MAX_PIECES = 8;
  var DECAY_THRESHOLD = 220;                // very large cells slowly shed mass
  var DECAY_PER_TICK = 0.0006;
  var AI_THINK_TICKS = 12;
  var TARGET_QUANT = 0.5;                   // authoritative input quantization
  var MAX_TRACKED_CMDS = 64;                // duplicate-rejection ring per player

  // ---------- helpers
  function radiusOf(mass) { return Math.sqrt(mass) * RADIUS_SCALE; }
  function speedOf(mass) {
    var s = BASE_SPEED * Math.pow(START_MASS / Math.max(mass, 1), SPEED_EXP);
    return Math.max(MIN_SPEED, Math.min(BASE_SPEED, s));
  }
  function dist2(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
  function clampArena(arenaRadius, e, r) {
    var d = Math.sqrt(e.x * e.x + e.y * e.y);
    var max = arenaRadius - r;
    if (d > max && d > 0) { e.x = e.x / d * max; e.y = e.y / d * max; }
  }
  function quantize(v) { return Math.round(v / TARGET_QUANT) * TARGET_QUANT; }

  // Rules RNG: state stored on the game state so serialization is complete.
  function rng(state) {
    var r = RNG.create(state.rngState);
    return {
      next: function () { var v = r.next(); state.rngState = r.state; return v; },
      range: function (lo, hi) { var v = r.range(lo, hi); state.rngState = r.state; return v; },
      int: function (n) { var v = r.int(n); state.rngState = r.state; return v; }
    };
  }

  // ---------- creation
  // config: {
  //   contentId, contentVersion, seed, mode,
  //   arenaRadius, moteCap, moteRespawnPerTick, barbCount,
  //   durationTicks (0 = none), goal {type:'reach-mass'|'survive'|'absorb-cells', mass|count},
  //   noRivalAbsorb (challenge constraint), ejectDisabled, splitDisabled,
  //   rivals: [{name, skill 0..1, hue}], playerName, playerHue
  // }
  function createGame(config) {
    var seedNum = typeof config.seed === 'string' ? RNG.hashString(config.seed) : (config.seed >>> 0);
    var state = {
      version: RULES_VERSION,
      tick: 0,
      phase: 'active',            // active | terminal
      terminalReason: null,       // goal-complete | eliminated | time-up | surrender | last-cell | constraint-violated
      winnerId: null,
      seed: seedNum,
      rngState: (seedNum ^ RNG.STREAM_RULES) >>> 0,
      config: {
        contentId: config.contentId || 'custom',
        contentVersion: config.contentVersion || 1,
        mode: config.mode || 'practice',
        arenaRadius: config.arenaRadius || 600,
        moteCap: config.moteCap != null ? config.moteCap : 130,
        moteRespawnPerTick: config.moteRespawnPerTick != null ? config.moteRespawnPerTick : 0.12,
        barbCount: config.barbCount || 0,
        durationTicks: config.durationTicks || 0,
        goal: config.goal || { type: 'survive' },
        noRivalAbsorb: !!config.noRivalAbsorb,
        ejectDisabled: !!config.ejectDisabled,
        splitDisabled: !!config.splitDisabled,
        allowRewind: !!config.allowRewind
      },
      arena: { radius: config.arenaRadius || 600 },
      players: [],
      cells: [],
      motes: [],
      pellets: [],
      barbs: [],
      nextEntityId: 1,
      moteRespawnAcc: 0,
      stats: {}                   // playerId -> counters
    };

    // players: index 0 is the local human
    addPlayer(state, { id: 'p0', name: config.playerName || 'You', kind: 'human', hue: config.playerHue != null ? config.playerHue : 190 });
    var rivals = config.rivals || [];
    for (var i = 0; i < rivals.length; i++) {
      addPlayer(state, {
        id: 'p' + (i + 1),
        name: rivals[i].name || ('Rival ' + (i + 1)),
        kind: 'ai',
        hue: rivals[i].hue != null ? rivals[i].hue : (i * 47 + 20) % 360,
        skill: rivals[i].skill != null ? rivals[i].skill : 0.5,
        aiMode: 'graze', aiThinkAt: 0, aiJitterX: 0, aiJitterY: 0
      });
    }

    // spawn cells: player near center-ish, rivals spread around the dish
    var r = rng(state);
    var spawnR = state.arena.radius;
    for (var p = 0; p < state.players.length; p++) {
      var ang = (p / state.players.length) * Math.PI * 2 + r.range(-0.3, 0.3);
      var d = p === 0 ? spawnR * 0.15 : spawnR * r.range(0.45, 0.75);
      spawnCell(state, state.players[p].id, Math.cos(ang) * d, Math.sin(ang) * d, START_MASS);
      state.stats[state.players[p].id].spawnedMass = START_MASS;
    }

    // nutrient motes
    var cap = state.config.moteCap;
    for (var m = 0; m < cap; m++) spawnMote(state, r);

    // barb clusters (hazards)
    for (var b = 0; b < state.config.barbCount; b++) spawnBarb(state, r);

    return state;
  }

  function addPlayer(state, opts) {
    state.players.push({
      id: opts.id,
      name: opts.name,
      kind: opts.kind,
      hue: opts.hue,
      skill: opts.skill || 0,
      alive: true,
      invalidCount: 0,
      target: { x: 0, y: 0 },
      ejectCooldownUntil: 0,
      aiMode: opts.aiMode || null,
      aiThinkAt: opts.aiThinkAt || 0,
      aiJitterX: opts.aiJitterX || 0,
      aiJitterY: opts.aiJitterY || 0,
      rank: 0
    });
    state.stats[opts.id] = {
      motes: 0, pellets: 0, rivalMass: 0, rivalCells: 0,
      peakMass: 0, spawnedMass: 0, survivedTicks: 0, splits: 0, ejects: 0, barbBursts: 0
    };
  }

  function spawnCell(state, playerId, x, y, mass) {
    var cell = {
      id: state.nextEntityId++,
      playerId: playerId,
      x: x, y: y, vx: 0, vy: 0, ix: 0, iy: 0,
      mass: mass,
      bornTick: state.tick,
      lastSplitTick: -SPLIT_COOLDOWN_TICKS,
      mergeAfter: state.tick
    };
    clampArena(state.arena.radius, cell, radiusOf(mass));
    state.cells.push(cell);
    return cell;
  }

  function spawnMote(state, r) {
    var ang = r.range(0, Math.PI * 2);
    var d = Math.sqrt(r.next()) * (state.arena.radius - 12);
    state.motes.push({ id: state.nextEntityId++, x: Math.cos(ang) * d, y: Math.sin(ang) * d, mass: MOTE_MASS });
  }

  function spawnBarb(state, r) {
    // keep barbs away from spawn cells so no one is instantly punished
    for (var tries = 0; tries < 24; tries++) {
      var ang = r.range(0, Math.PI * 2);
      var d = Math.sqrt(r.next()) * (state.arena.radius - 60) + 30;
      var x = Math.cos(ang) * d, y = Math.sin(ang) * d;
      var ok = true;
      for (var i = 0; i < state.cells.length; i++) {
        if (dist2(x, y, state.cells[i].x, state.cells[i].y) < 140 * 140) { ok = false; break; }
      }
      if (ok) { state.barbs.push({ id: state.nextEntityId++, x: x, y: y, radius: BARB_RADIUS }); return; }
    }
  }

  // ---------- queries
  function playerById(state, id) {
    for (var i = 0; i < state.players.length; i++) if (state.players[i].id === id) return state.players[i];
    return null;
  }
  function cellsOf(state, playerId) {
    var out = [];
    for (var i = 0; i < state.cells.length; i++) if (state.cells[i].playerId === playerId) out.push(state.cells[i]);
    return out;
  }
  function playerMass(state, playerId) {
    var m = 0;
    for (var i = 0; i < state.cells.length; i++) if (state.cells[i].playerId === playerId) m += state.cells[i].mass;
    return m;
  }
  function centroid(state, playerId) {
    var mx = 0, my = 0, m = 0;
    for (var i = 0; i < state.cells.length; i++) {
      var c = state.cells[i];
      if (c.playerId !== playerId) continue;
      mx += c.x * c.mass; my += c.y * c.mass; m += c.mass;
    }
    if (m === 0) return null;
    return { x: mx / m, y: my / m };
  }

  // Rankings sorted by the spec tie-break: objective completion, fewer invalid
  // actions, lower elapsed, then stable identifier.
  function rankings(state) {
    var rows = state.players.map(function (p) {
      return {
        playerId: p.id, name: p.name, hue: p.hue, alive: p.alive,
        mass: playerMass(state, p.id),
        objectiveMet: objectiveMet(state, p.id) ? 1 : 0,
        invalid: p.invalidCount,
        survivedTicks: state.stats[p.id].survivedTicks
      };
    });
    rows.sort(function (a, b) {
      if (b.objectiveMet !== a.objectiveMet) return b.objectiveMet - a.objectiveMet;
      if (b.mass !== a.mass) return b.mass - a.mass;
      if (a.invalid !== b.invalid) return a.invalid - b.invalid;
      if (b.survivedTicks !== a.survivedTicks) return b.survivedTicks - a.survivedTicks;
      return a.playerId < b.playerId ? -1 : 1;
    });
    for (var i = 0; i < rows.length; i++) rows[i].rank = i + 1;
    return rows;
  }

  function objectiveMet(state, playerId) {
    var g = state.config.goal;
    var p = playerById(state, playerId);
    if (!p || !p.alive) return false;
    if (g.type === 'reach-mass') return playerMass(state, playerId) >= g.mass;
    if (g.type === 'absorb-cells') return state.stats[playerId].rivalCells >= g.count;
    if (g.type === 'eject-count') return state.stats[playerId].ejects >= g.count;
    if (g.type === 'split-then-mass') {
      return state.stats[playerId].splits >= (g.splits || 1) && playerMass(state, playerId) >= g.mass;
    }
    if (g.type === 'reach-marker') {
      var c = centroid(state, playerId);
      if (!c) return false;
      var r = g.radius || 40;
      return dist2(c.x, c.y, g.x || 0, g.y || 0) < r * r;
    }
    return false; // survive goals resolve at time-up
  }

  // Legal-action query — tutorials and hints use this, never duplicated rules.
  function legalActions(state, playerId) {
    var p = playerById(state, playerId);
    var out = {
      active: state.phase === 'active',
      alive: !!(p && p.alive),
      setTarget: { ok: true },
      split: { ok: false, reason: 'unknown' },
      eject: { ok: false, reason: 'unknown' }
    };
    if (!out.active) {
      out.setTarget = { ok: false, reason: 'round-over' };
      out.split = { ok: false, reason: 'round-over' };
      out.eject = { ok: false, reason: 'round-over' };
      return out;
    }
    if (!out.alive) {
      out.setTarget = { ok: false, reason: 'eliminated' };
      out.split = { ok: false, reason: 'eliminated' };
      out.eject = { ok: false, reason: 'eliminated' };
      return out;
    }
    // split
    if (state.config.splitDisabled) out.split = { ok: false, reason: 'split-disabled' };
    else {
      var mine = cellsOf(state, playerId);
      var eligible = false;
      for (var i = 0; i < mine.length; i++) {
        if (mine[i].mass >= MIN_SPLIT_MASS && state.tick - mine[i].lastSplitTick >= SPLIT_COOLDOWN_TICKS) { eligible = true; break; }
      }
      if (!eligible) out.split = { ok: false, reason: mine.length ? 'cells-too-small-or-cooling' : 'no-cells' };
      else if (mine.length >= MAX_CELLS) out.split = { ok: false, reason: 'cell-limit' };
      else out.split = { ok: true };
    }
    // eject
    if (state.config.ejectDisabled) out.eject = { ok: false, reason: 'eject-disabled' };
    else if (state.tick < p.ejectCooldownUntil) out.eject = { ok: false, reason: 'cooling' };
    else {
      var mine2 = cellsOf(state, playerId);
      var can = false;
      for (var j = 0; j < mine2.length; j++) if (mine2[j].mass >= MIN_EJECT_MASS + PELLET_MASS) { can = true; break; }
      out.eject = can ? { ok: true } : { ok: false, reason: 'cells-too-small' };
    }
    return out;
  }

  // ---------- commands
  // cmd: {type:'setTarget',x,y} | {type:'split'} | {type:'eject'} | {type:'surrender'}
  // Optional cmd.id gives idempotent duplicate rejection per player.
  function applyCommand(state, playerId, cmd) {
    if (!state._seen) state._seen = {};
    var p = playerById(state, playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (cmd && cmd.id != null) {
      var seen = state._seen[playerId] || (state._seen[playerId] = []);
      if (seen.indexOf(cmd.id) !== -1) return { ok: false, reason: 'duplicate' };
      seen.push(cmd.id);
      if (seen.length > MAX_TRACKED_CMDS) seen.shift();
    }
    if (state.phase !== 'active') return { ok: false, reason: 'round-over' };
    if (cmd.type === 'surrender') {
      eliminate(state, playerId);
      state.terminalReason = 'surrender';
      state.phase = 'terminal';
      finalize(state);
      return { ok: true };
    }
    if (!p.alive) { p.invalidCount++; return { ok: false, reason: 'eliminated' } }

    if (cmd.type === 'setTarget') {
      if (typeof cmd.x !== 'number' || typeof cmd.y !== 'number' ||
          !isFinite(cmd.x) || !isFinite(cmd.y)) { p.invalidCount++; return { ok: false, reason: 'bad-target' } }
      var r = state.arena.radius + 200; // generous bounds; clamped, never NaN
      p.target.x = quantize(Math.max(-r, Math.min(r, cmd.x)));
      p.target.y = quantize(Math.max(-r, Math.min(r, cmd.y)));
      return { ok: true };
    }
    if (cmd.type === 'split') {
      var legal = legalActions(state, playerId).split;
      if (!legal.ok) { p.invalidCount++; return { ok: false, reason: legal.reason } }
      p._wantSplit = true;
      return { ok: true };
    }
    if (cmd.type === 'eject') {
      var legalE = legalActions(state, playerId).eject;
      if (!legalE.ok) { p.invalidCount++; return { ok: false, reason: legalE.reason } }
      p._wantEject = true;
      return { ok: true };
    }
    p.invalidCount++;
    return { ok: false, reason: 'unknown-command' };
  }

  function eliminate(state, playerId) {
    var p = playerById(state, playerId);
    if (p) p.alive = false;
    state.cells = state.cells.filter(function (c) { return c.playerId !== playerId; });
  }

  // ---------- simulation step
  function step(state) {
    if (state.phase !== 'active') return;
    state.tick++;

    aiThink(state);
    applyWishes(state);
    moveCells(state);
    movePellets(state);
    absorbMotes(state);
    absorbPellets(state);
    absorbCells(state);
    barbBursts(state);
    recombine(state);
    decay(state);
    respawnMotes(state);
    updateSurvival(state);
    checkTerminal(state);
    if (state.tick >= MAX_TICKS && state.phase === 'active') {
      state.phase = 'terminal';
      state.terminalReason = 'time-up';
      finalize(state);
    }
  }

  function aiThink(state) {
    for (var i = 0; i < state.players.length; i++) {
      var p = state.players[i];
      if (p.kind !== 'ai' || !p.alive) continue;
      if (state.tick < p.aiThinkAt) continue;
      p.aiThinkAt = state.tick + AI_THINK_TICKS;
      var r = rng(state);
      var mine = cellsOf(state, p.id);
      if (!mine.length) continue;
      var big = mine[0];
      for (var k = 0; k < mine.length; k++) if (mine[k].mass > big.mass) big = mine[k];
      var myMass = playerMass(state, p.id);
      var skill = p.skill;

      // scan threats and prey (rival cells only)
      var threatX = 0, threatY = 0, threatW = 0;
      var prey = null, preyD2 = Infinity;
      var sight = 240 + skill * 160;
      for (var c = 0; c < state.cells.length; c++) {
        var o = state.cells[c];
        if (o.playerId === p.id) continue;
        var d2 = dist2(big.x, big.y, o.x, o.y);
        if (o.mass > big.mass * EAT_RATIO && d2 < sight * sight) {
          var w = o.mass / Math.max(1, d2);
          threatX += o.x * w; threatY += o.y * w; threatW += w;
        } else if (o.mass * EAT_RATIO < big.mass && d2 < preyD2 && d2 < (sight * 0.9) * (sight * 0.9)) {
          prey = o; preyD2 = d2;
        }
      }

      if (threatW > 0) {
        // flee directly away from the weighted threat centroid
        var tx = threatX / threatW, ty = threatY / threatW;
        var dx = big.x - tx, dy = big.y - ty;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        p.target.x = quantize(big.x + dx / len * 300);
        p.target.y = quantize(big.y + dy / len * 300);
        p.aiMode = 'flee';
        // panicked split to gain speed when a hunter is very close
        if (skill > 0.55 && len < 120 && big.mass >= MIN_SPLIT_MASS * 2 && r.next() < 0.25) p._wantSplit = true;
      } else if (prey) {
        p.target.x = quantize(prey.x + r.range(-20, 20) * (1 - skill));
        p.target.y = quantize(prey.y + r.range(-20, 20) * (1 - skill));
        p.aiMode = 'hunt';
        // split-kill: close, aligned, big enough
        if (big.mass >= Math.max(MIN_SPLIT_MASS * 2, prey.mass * 2.6) &&
            preyD2 < 150 * 150 && r.next() < 0.2 + skill * 0.5 &&
            state.tick - big.lastSplitTick >= SPLIT_COOLDOWN_TICKS &&
            mine.length < MAX_CELLS - 1 && !state.config.splitDisabled) {
          p._wantSplit = true;
        }
      } else {
        // graze: nearest mote cluster, biased away from barbs when large
        var best = null, bestD2 = Infinity;
        var scan = Math.min(state.motes.length, 40);
        for (var m = 0; m < scan; m++) {
          var mo = state.motes[m];
          var md2 = dist2(big.x, big.y, mo.x, mo.y);
          if (md2 < bestD2) { bestD2 = md2; best = mo; }
        }
        if (best) {
          p.target.x = quantize(best.x + r.range(-30, 30) * (1 - skill));
          p.target.y = quantize(best.y + r.range(-30, 30) * (1 - skill));
        }
        p.aiMode = 'graze';
        // large AI avoid barbs: steer away if heading into one
        if (big.mass >= BARB_BURST_MASS) {
          for (var b = 0; b < state.barbs.length; b++) {
            var barb = state.barbs[b];
            if (dist2(p.target.x, p.target.y, barb.x, barb.y) < 90 * 90) {
              var bx = p.target.x - barb.x, by = p.target.y - barb.y;
              var bl = Math.sqrt(bx * bx + by * by) || 1;
              p.target.x = quantize(barb.x + bx / bl * 220);
              p.target.y = quantize(barb.y + by / bl * 220);
              break;
            }
          }
        }
      }
    }
  }

  // Execute queued split/eject wishes (human or AI) at the start of a tick so
  // resolution order stays deterministic.
  function applyWishes(state) {
    for (var i = 0; i < state.players.length; i++) {
      var p = state.players[i];
      if (!p.alive) { p._wantSplit = false; p._wantEject = false; continue; }
      if (p._wantSplit) { doSplit(state, p); p._wantSplit = false; }
      if (p._wantEject) { doEject(state, p); p._wantEject = false; }
    }
  }

  function doSplit(state, p) {
    var mine = cellsOf(state, p.id);
    var added = 0;
    // stable order by cell id
    mine.sort(function (a, b) { return a.id - b.id; });
    for (var i = 0; i < mine.length; i++) {
      var c = mine[i];
      if (mine.length + added >= MAX_CELLS) break;
      if (c.mass < MIN_SPLIT_MASS) continue;
      if (state.tick - c.lastSplitTick < SPLIT_COOLDOWN_TICKS) continue;
      var half = c.mass / 2;
      c.mass = half;
      c.lastSplitTick = state.tick;
      c.mergeAfter = state.tick + RECOMBINE_TICKS;
      var dx = p.target.x - c.x, dy = p.target.y - c.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= len; dy /= len;
      var r0 = radiusOf(half);
      var child = spawnCell(state, p.id, c.x + dx * r0, c.y + dy * r0, half);
      child.ix = dx * SPLIT_IMPULSE;
      child.iy = dy * SPLIT_IMPULSE;
      child.lastSplitTick = state.tick;
      child.mergeAfter = state.tick + RECOMBINE_TICKS;
      state.stats[p.id].splits++;
      added++;
    }
    return added;
  }

  function doEject(state, p) {
    var legal = legalActions(state, p.id).eject;
    if (!legal.ok) return 0;
    var mine = cellsOf(state, p.id);
    mine.sort(function (a, b) { return a.id - b.id; });
    var n = 0;
    for (var i = 0; i < mine.length; i++) {
      var c = mine[i];
      if (c.mass < MIN_EJECT_MASS + PELLET_MASS) continue;
      c.mass -= PELLET_MASS;
      var dx = p.target.x - c.x, dy = p.target.y - c.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= len; dy /= len;
      var r0 = radiusOf(c.mass);
      state.pellets.push({
        id: state.nextEntityId++,
        x: c.x + dx * (r0 + 2), y: c.y + dy * (r0 + 2),
        vx: dx * PELLET_SPEED, vy: dy * PELLET_SPEED,
        mass: PELLET_MASS, ownerId: p.id, bornTick: state.tick
      });
      n++;
    }
    if (n > 0) {
      p.ejectCooldownUntil = state.tick + EJECT_COOLDOWN_TICKS;
      state.stats[p.id].ejects += n;
    }
    return n;
  }

  function moveCells(state) {
    for (var i = 0; i < state.cells.length; i++) {
      var c = state.cells[i];
      var p = playerById(state, c.playerId);
      if (!p) continue;
      var dx = p.target.x - c.x, dy = p.target.y - c.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      var speed = speedOf(c.mass);
      // ease off near the target so cells settle instead of orbiting
      var want = d > 1 ? Math.min(speed, d * 0.25) : 0;
      var wx = d > 1 ? dx / d * want : 0;
      var wy = d > 1 ? dy / d * want : 0;
      c.vx += (wx - c.vx) * STEER_LERP + c.ix;
      c.vy += (wy - c.vy) * STEER_LERP + c.iy;
      c.ix *= IMPULSE_FRICTION; c.iy *= IMPULSE_FRICTION;
      if (Math.abs(c.ix) < 0.01) c.ix = 0;
      if (Math.abs(c.iy) < 0.01) c.iy = 0;
      c.x += c.vx; c.y += c.vy;
      clampArena(state.arena.radius, c, radiusOf(c.mass));
    }
    // gentle same-owner overlap separation (soft membrane push)
    for (var a = 0; a < state.cells.length; a++) {
      for (var b = a + 1; b < state.cells.length; b++) {
        var A = state.cells[a], B = state.cells[b];
        if (A.playerId !== B.playerId) continue;
        if (state.tick >= A.mergeAfter && state.tick >= B.mergeAfter) continue; // about to merge
        var ra = radiusOf(A.mass), rb = radiusOf(B.mass);
        var dx2 = B.x - A.x, dy2 = B.y - A.y;
        var dd = Math.sqrt(dx2 * dx2 + dy2 * dy2);
        var min = Math.max(ra, rb);
        if (dd < min && dd > 0.001) {
          var push = (min - dd) * 0.5;
          var ux = dx2 / dd, uy = dy2 / dd;
          A.x -= ux * push * 0.5; A.y -= uy * push * 0.5;
          B.x += ux * push * 0.5; B.y += uy * push * 0.5;
        }
      }
    }
  }

  function movePellets(state) {
    for (var i = 0; i < state.pellets.length; i++) {
      var p = state.pellets[i];
      p.x += p.vx; p.y += p.vy;
      p.vx *= PELLET_FRICTION; p.vy *= PELLET_FRICTION;
      if (Math.abs(p.vx) < 0.02) p.vx = 0;
      if (Math.abs(p.vy) < 0.02) p.vy = 0;
      clampArena(state.arena.radius, p, 2);
    }
  }

  function absorbMotes(state) {
    if (!state.motes.length) return;
    var eaten = {};
    for (var i = 0; i < state.cells.length; i++) {
      var c = state.cells[i];
      var cr = radiusOf(c.mass);
      for (var m = 0; m < state.motes.length; m++) {
        if (eaten[state.motes[m].id]) continue;
        var mo = state.motes[m];
        if (dist2(c.x, c.y, mo.x, mo.y) < cr * cr) {
          eaten[mo.id] = true;
          c.mass += mo.mass;
          state.stats[c.playerId].motes++;
        }
      }
    }
    if (Object.keys(eaten).length) {
      state.motes = state.motes.filter(function (mo) { return !eaten[mo.id]; });
    }
  }

  function absorbPellets(state) {
    if (!state.pellets.length) return;
    var eaten = {};
    for (var i = 0; i < state.cells.length; i++) {
      var c = state.cells[i];
      var cr = radiusOf(c.mass);
      for (var m = 0; m < state.pellets.length; m++) {
        var pe = state.pellets[m];
        if (eaten[pe.id]) continue;
        if (pe.ownerId === c.playerId && state.tick - pe.bornTick < PELLET_SELF_DELAY) continue;
        if (dist2(c.x, c.y, pe.x, pe.y) < cr * cr) {
          eaten[pe.id] = true;
          c.mass += pe.mass;
          state.stats[c.playerId].pellets++;
        }
      }
    }
    if (Object.keys(eaten).length) {
      state.pellets = state.pellets.filter(function (pe) { return !eaten[pe.id]; });
    }
  }

  function absorbCells(state) {
    // deterministic order: ascending eater id, then ascending prey id
    var sorted = state.cells.slice().sort(function (a, b) { return a.id - b.id; });
    var dead = {};
    for (var i = 0; i < sorted.length; i++) {
      var eater = sorted[i];
      if (dead[eater.id]) continue;
      var er = radiusOf(eater.mass);
      for (var j = 0; j < sorted.length; j++) {
        var prey = sorted[j];
        if (prey.id === eater.id || dead[prey.id]) continue;
        if (prey.playerId === eater.playerId) continue;
        if (eater.mass < prey.mass * EAT_RATIO) continue;
        var pr = radiusOf(prey.mass);
        var reach = er - pr * EAT_OVERLAP;
        if (reach <= 0) continue;
        if (dist2(eater.x, eater.y, prey.x, prey.y) < reach * reach) {
          dead[prey.id] = true;
          eater.mass += prey.mass;
          er = radiusOf(eater.mass);
          var st = state.stats[eater.playerId];
          st.rivalMass += prey.mass;
          st.rivalCells++;
          if (state.config.noRivalAbsorb && eater.playerId === 'p0') {
            // pacifist constraint: absorbing a rival ends the round as a violation
            dead[prey.id] = true;
            eater.mass += prey.mass;
            state.cells = state.cells.filter(function (cl) { return !dead[cl.id]; });
            state.phase = 'terminal';
            state.terminalReason = 'constraint-violated';
            finalize(state);
            return;
          }
        }
      }
    }
    if (Object.keys(dead).length) {
      // record eliminations
      var ownersAlive = {};
      state.cells = state.cells.filter(function (c) { return !dead[c.id]; });
      for (var k = 0; k < state.cells.length; k++) ownersAlive[state.cells[k].playerId] = true;
      for (var pi = 0; pi < state.players.length; pi++) {
        var pl = state.players[pi];
        if (pl.alive && !ownersAlive[pl.id]) pl.alive = false;
      }
    }
  }

  function barbBursts(state) {
    if (!state.barbs.length) return;
    var newCells = [];
    for (var i = 0; i < state.cells.length; i++) {
      var c = state.cells[i];
      if (c.mass < BARB_BURST_MASS) continue;
      var cr = radiusOf(c.mass);
      for (var b = 0; b < state.barbs.length; b++) {
        var barb = state.barbs[b];
        var hit = dist2(c.x, c.y, barb.x, barb.y) < (cr + barb.radius - 2) * (cr + barb.radius - 2);
        if (!hit) continue;
        // burst into pieces
        var pieces = Math.min(BURST_MAX_PIECES, Math.floor(c.mass / BURST_MIN_PIECE));
        if (pieces < 2) break;
        var r = rng(state);
        var each = c.mass / pieces;
        c.mass = each;
        c.mergeAfter = state.tick + RECOMBINE_TICKS;
        for (var k = 1; k < pieces; k++) {
          var ang = (k / pieces) * Math.PI * 2 + r.range(-0.2, 0.2);
          var child = {
            id: state.nextEntityId++,
            playerId: c.playerId,
            x: c.x + Math.cos(ang) * cr * 0.6, y: c.y + Math.sin(ang) * cr * 0.6,
            vx: 0, vy: 0,
            ix: Math.cos(ang) * SPLIT_IMPULSE * 0.6, iy: Math.sin(ang) * SPLIT_IMPULSE * 0.6,
            mass: each, bornTick: state.tick, lastSplitTick: c.lastSplitTick,
            mergeAfter: state.tick + RECOMBINE_TICKS
          };
          clampArena(state.arena.radius, child, radiusOf(child.mass));
          newCells.push(child);
        }
        state.stats[c.playerId].barbBursts++;
        break; // one burst per cell per tick
      }
    }
    for (var n = 0; n < newCells.length; n++) state.cells.push(newCells[n]);
  }

  function recombine(state) {
    var removed = {};
    var sorted = state.cells.slice().sort(function (a, b) { return b.mass - a.mass; });
    for (var i = 0; i < sorted.length; i++) {
      var A = sorted[i];
      if (removed[A.id] || state.tick < A.mergeAfter) continue;
      for (var j = i + 1; j < sorted.length; j++) {
        var B = sorted[j];
        if (removed[B.id] || B.playerId !== A.playerId) continue;
        if (state.tick < B.mergeAfter) continue;
        var ra = radiusOf(A.mass), rb = radiusOf(B.mass);
        if (dist2(A.x, A.y, B.x, B.y) < ra * ra) {
          A.mass += B.mass;
          removed[B.id] = true;
        }
      }
    }
    if (Object.keys(removed).length) {
      state.cells = state.cells.filter(function (c) { return !removed[c.id]; });
    }
  }

  function decay(state) {
    for (var i = 0; i < state.cells.length; i++) {
      var c = state.cells[i];
      if (c.mass > DECAY_THRESHOLD) {
        c.mass -= c.mass * DECAY_PER_TICK;
        if (c.mass < DECAY_THRESHOLD) c.mass = DECAY_THRESHOLD;
      }
    }
  }

  function respawnMotes(state) {
    state.moteRespawnAcc += state.config.moteRespawnPerTick;
    var r = null;
    while (state.moteRespawnAcc >= 1 && state.motes.length < state.config.moteCap) {
      state.moteRespawnAcc -= 1;
      if (!r) r = rng(state);
      spawnMote(state, r);
    }
    if (state.moteRespawnAcc > 4) state.moteRespawnAcc = 4; // cap backlog
  }

  function updateSurvival(state) {
    for (var i = 0; i < state.players.length; i++) {
      var p = state.players[i];
      if (!p.alive) continue;
      var st = state.stats[p.id];
      st.survivedTicks++;
      var m = playerMass(state, p.id);
      if (m > st.peakMass) st.peakMass = m;
    }
  }

  function checkTerminal(state) {
    if (state.phase !== 'active') return;
    var human = state.players[0];
    if (!human.alive) {
      state.phase = 'terminal';
      state.terminalReason = 'eliminated';
      finalize(state);
      return;
    }
    if (objectiveMet(state, human.id)) {
      state.phase = 'terminal';
      state.terminalReason = 'goal-complete';
      state.winnerId = human.id;
      finalize(state);
      return;
    }
    // last cell drifting: only the human remains
    var aliveCount = 0;
    for (var i = 0; i < state.players.length; i++) if (state.players[i].alive) aliveCount++;
    if (aliveCount === 1 && state.players.length > 1) {
      state.phase = 'terminal';
      state.terminalReason = 'last-cell';
      state.winnerId = human.id;
      finalize(state);
      return;
    }
    if (state.config.durationTicks > 0 && state.tick >= state.config.durationTicks) {
      state.phase = 'terminal';
      state.terminalReason = 'time-up';
      finalize(state);
    }
  }

  function finalize(state) {
    var rows = rankings(state);
    for (var i = 0; i < rows.length; i++) {
      var p = playerById(state, rows[i].playerId);
      if (p) p.rank = rows[i].rank;
    }
    if (!state.winnerId && rows.length && rows[0].alive) state.winnerId = rows[0].playerId;
  }

  // ---------- scoring (integers; formatting is a presentation concern)
  function scoreBreakdown(state, playerId) {
    var st = state.stats[playerId];
    var rank = 0, total = 0;
    for (var i = 0; i < state.players.length; i++) total++;
    var rows = rankings(state);
    for (var r = 0; r < rows.length; r++) if (rows[r].playerId === playerId) rank = rows[r].rank;
    var goalMet = objectiveMet(state, playerId);
    var parts = {
      motes: st.motes * 2,
      pellets: st.pellets * 3,
      rivalMass: Math.round(st.rivalMass) * 5,
      survival: Math.floor(st.survivedTicks / TICK_RATE) * 2,
      peakMass: Math.floor(st.peakMass),
      rankBonus: state.phase === 'terminal' ? Math.max(0, (total - rank) * 100) : 0,
      objectiveBonus: goalMet ? 500 : 0
    };
    var sum = 0;
    for (var k in parts) sum += parts[k];
    return { parts: parts, total: sum, rank: rank, objectiveMet: goalMet };
  }

  // ---------- hint (same legal-action API as play)
  function hint(state, playerId) {
    var legal = legalActions(state, playerId);
    if (!legal.alive) return { action: 'none', text: 'You have been absorbed. Watch or retry.' };
    var c = centroid(state, playerId);
    var mine = cellsOf(state, playerId);
    var big = mine[0];
    for (var i = 0; i < mine.length; i++) if (mine[i].mass > big.mass) big = mine[i];
    // nearest threat
    var threat = null, threatD2 = Infinity;
    var prey = null, preyD2 = Infinity;
    for (var k = 0; k < state.cells.length; k++) {
      var o = state.cells[k];
      if (o.playerId === playerId) continue;
      var d2 = dist2(big.x, big.y, o.x, o.y);
      if (o.mass > big.mass * EAT_RATIO && d2 < threatD2) { threat = o; threatD2 = d2; }
      if (o.mass * EAT_RATIO < big.mass && d2 < preyD2) { prey = o; preyD2 = d2; }
    }
    if (threat && threatD2 < 200 * 200) {
      var dx = big.x - threat.x, dy = big.y - threat.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      return { action: 'flee', x: big.x + dx / len * 200, y: big.y + dy / len * 200,
        text: 'A larger cell is close — drift away from it.' };
    }
    if (prey && preyD2 < 260 * 260) {
      var canSplit = legal.split.ok && big.mass >= prey.mass * 2.6 && preyD2 < 150 * 150;
      return { action: canSplit ? 'split' : 'hunt', x: prey.x, y: prey.y,
        text: canSplit ? 'Split now to launch onto the smaller cell.' : 'Chase the smaller cell to absorb it.' };
    }
    var mote = null, moteD2 = Infinity;
    for (var m = 0; m < state.motes.length; m++) {
      var mo = state.motes[m];
      var md2 = dist2(c.x, c.y, mo.x, mo.y);
      if (md2 < moteD2) { moteD2 = md2; mote = mo; }
    }
    if (mote) return { action: 'graze', x: mote.x, y: mote.y, text: 'Graze on nutrient motes to grow.' };
    return { action: 'drift', text: 'Drift and stay clear of larger cells.' };
  }

  // ---------- serialization
  function serialize(state) {
    return JSON.parse(JSON.stringify({
      version: state.version,
      tick: state.tick,
      phase: state.phase,
      terminalReason: state.terminalReason,
      winnerId: state.winnerId,
      seed: state.seed,
      rngState: state.rngState,
      config: state.config,
      arena: state.arena,
      players: state.players.map(function (p) {
        return {
          id: p.id, name: p.name, kind: p.kind, hue: p.hue, skill: p.skill,
          alive: p.alive, invalidCount: p.invalidCount, rank: p.rank,
          target: { x: p.target.x, y: p.target.y },
          ejectCooldownUntil: p.ejectCooldownUntil,
          aiMode: p.aiMode, aiThinkAt: p.aiThinkAt, aiJitterX: p.aiJitterX, aiJitterY: p.aiJitterY
        };
      }),
      cells: state.cells, motes: state.motes, pellets: state.pellets, barbs: state.barbs,
      nextEntityId: state.nextEntityId,
      moteRespawnAcc: state.moteRespawnAcc,
      stats: state.stats
    }));
  }

  function deserialize(obj) {
    if (!obj || obj.version !== RULES_VERSION) throw new Error('unsupported state version');
    var state = JSON.parse(JSON.stringify(obj));
    state._seen = {};
    return state;
  }

  // Canonical hash of everything that affects outcomes (replay verification).
  function stateHash(state) {
    function n(v) { return Math.round(v * 1000); }
    var parts = [state.tick, state.phase, state.rngState, state.nextEntityId];
    for (var i = 0; i < state.cells.length; i++) {
      var c = state.cells[i];
      parts.push(c.id, c.playerId, n(c.x), n(c.y), n(c.mass));
    }
    for (var m = 0; m < state.motes.length; m++) parts.push(state.motes[m].id, n(state.motes[m].x), n(state.motes[m].y));
    for (var pe = 0; pe < state.pellets.length; pe++) parts.push(state.pellets[pe].id, n(state.pellets[pe].x), n(state.pellets[pe].y));
    for (var pl = 0; pl < state.players.length; pl++) {
      parts.push(state.players[pl].id, state.players[pl].alive ? 1 : 0, state.players[pl].invalidCount);
    }
    return RNG.hashString(parts.join(',')).toString(36);
  }

  return {
    RULES_VERSION: RULES_VERSION,
    TICK_RATE: TICK_RATE,
    MAX_TICKS: MAX_TICKS,
    RADIUS_SCALE: RADIUS_SCALE,
    START_MASS: START_MASS,
    MOTE_MASS: MOTE_MASS,
    MIN_SPLIT_MASS: MIN_SPLIT_MASS,
    MIN_EJECT_MASS: MIN_EJECT_MASS,
    PELLET_MASS: PELLET_MASS,
    MAX_CELLS: MAX_CELLS,
    EAT_RATIO: EAT_RATIO,
    BARB_BURST_MASS: BARB_BURST_MASS,
    RECOMBINE_TICKS: RECOMBINE_TICKS,
    hashString: RNG.hashString,
    radiusOf: radiusOf,
    speedOf: speedOf,
    createGame: createGame,
    applyCommand: applyCommand,
    step: step,
    legalActions: legalActions,
    playerById: playerById,
    cellsOf: cellsOf,
    playerMass: playerMass,
    centroid: centroid,
    rankings: rankings,
    objectiveMet: objectiveMet,
    scoreBreakdown: scoreBreakdown,
    hint: hint,
    serialize: serialize,
    deserialize: deserialize,
    stateHash: stateHash,
    eliminate: eliminate
  };
}));
