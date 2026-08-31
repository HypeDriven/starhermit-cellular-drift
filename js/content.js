/*
 * Cellular Drift — content: versioned themes, lessons, journey, daily,
 * practice and challenges, plus offline validators.
 * UMD: usable from the browser (window.CDContent) and from Node (tests).
 */
(function (root, factory) {
  var R = (typeof module === 'object' && module.exports) ? require('./rules.js') : root.CDRules;
  if (typeof module === 'object' && module.exports) module.exports = factory(R);
  else root.CDContent = factory(R);
}(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  var CONTENT_VERSION = 1;

  // ---------- Visual themes (presentation data; rules never read these)
  var THEMES = [
    {
      id: 'lagoon', name: 'Lagoon Culture',
      bg: '#071c26', bgDeep: '#03101a', membrane: '#4fd8c2', player: '#ffd166',
      motes: ['#9bf6e4', '#6ee7d8', '#c5fff3'], barb: '#ff6b81',
      fog: 'rgba(7,28,38,0.55)', grid: 'rgba(120,220,210,0.07)'
    },
    {
      id: 'amethyst', name: 'Amethyst Depth',
      bg: '#170f2b', bgDeep: '#0b0618', membrane: '#9b7bff', player: '#7be0ad',
      motes: ['#cbb7ff', '#a88fe8', '#e3d8ff'], barb: '#ff8f5c',
      fog: 'rgba(23,15,43,0.55)', grid: 'rgba(170,140,255,0.07)'
    },
    {
      id: 'verdant', name: 'Verdant Bloom',
      bg: '#0c2013', bgDeep: '#04100a', membrane: '#7fd069', player: '#6ec9ff',
      motes: ['#b9f0a4', '#8fd97a', '#dcf7cd'], barb: '#ffb347',
      fog: 'rgba(12,32,19,0.55)', grid: 'rgba(140,230,140,0.07)'
    },
    {
      id: 'cinder', name: 'Cinder Field',
      bg: '#241016', bgDeep: '#120508', membrane: '#ff7a66', player: '#7ad7f0',
      motes: ['#ffb09a', '#ff8d75', '#ffd6c8'], barb: '#ffd23f',
      fog: 'rgba(36,16,22,0.55)', grid: 'rgba(255,150,130,0.07)'
    },
    {
      id: 'aurora', name: 'Aurora Veil',
      bg: '#0a1a2b', bgDeep: '#050d18', membrane: '#5fb4ff', player: '#f9f871',
      motes: ['#a5d8ff', '#7cc4f5', '#d0ebff'], barb: '#ff6fd8',
      fog: 'rgba(10,26,43,0.55)', grid: 'rgba(130,190,255,0.07)'
    }
  ];

  // Color-vision-safe palette patch (shapes/labels reinforce too).
  var CVD_THEME_PATCH = { membrane: '#0072B2', player: '#E69F00', barb: '#D55E00', motes: ['#56B4E9', '#F0E442', '#CC79A7'] };

  var RIVAL_NAMES = [
    'Vexel', 'Miro', 'Plasm', 'Nucleo', 'Sorp', 'Tintle', 'Osmo', 'Brindle',
    'Cilia', 'Vaku', 'Murel', 'Zygote', 'Fimbri', 'Lyso', 'Perox', 'Granule'
  ];

  function rivalSet(seed, count, skillBase, skillSpan) {
    var out = [];
    var names = RIVAL_NAMES.slice();
    // deterministic shuffle
    var h = R.hashString('names:' + seed);
    for (var i = names.length - 1; i > 0; i--) {
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      var j = h % (i + 1);
      var t = names[i]; names[i] = names[j]; names[j] = t;
    }
    for (var k = 0; k < count; k++) {
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      var skill = Math.max(0.1, Math.min(1, skillBase + ((h % 1000) / 1000 - 0.5) * 2 * skillSpan));
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      out.push({ name: names[k % names.length], skill: Math.round(skill * 100) / 100, hue: h % 360 });
    }
    return out;
  }

  // ---------- Learn-mode lessons (interactive; one rule at a time)
  var LESSONS = [
    {
      id: 'l1', name: 'Drift', theme: 'lagoon', seed: 'lesson-1',
      brief: 'Your cell drifts toward the pointer (or arrow keys). Move to the glowing marker.',
      goal: { type: 'reach-marker', x: -110, y: 120, radius: 45 },
      params: { arenaRadius: 320, moteCap: 20, rivals: 0, barbs: 0, durationTicks: R.TICK_RATE * 60 }
    },
    {
      id: 'l2', name: 'Graze', theme: 'lagoon', seed: 'lesson-2',
      brief: 'Nutrient motes drift in the medium. Touch them to absorb mass. Grow to 60.',
      goal: { type: 'reach-mass', mass: 60 },
      params: { arenaRadius: 380, moteCap: 90, rivals: 0, barbs: 0, durationTicks: R.TICK_RATE * 120 }
    },
    {
      id: 'l3', name: 'Eject', theme: 'amethyst', seed: 'lesson-3',
      brief: 'Eject mass (E or the Eject button) to shed pellets. Feed the marker cell 5 pellets.',
      goal: { type: 'eject-count', count: 5 },
      params: { arenaRadius: 380, moteCap: 60, rivals: 0, barbs: 0, durationTicks: R.TICK_RATE * 120 }
    },
    {
      id: 'l4', name: 'Divide', theme: 'amethyst', seed: 'lesson-4',
      brief: 'Split (Space) to launch half your mass forward. Split once, then grow back to 70.',
      goal: { type: 'split-then-mass', mass: 70 },
      params: { arenaRadius: 420, moteCap: 110, rivals: 0, barbs: 0, durationTicks: R.TICK_RATE * 150 }
    },
    {
      id: 'l5', name: 'Barbs', theme: 'cinder', seed: 'lesson-5',
      brief: 'Spiked barbs burst large cells — small cells slip by safely. Grow to 90 without bursting, or use the barbs to escape.',
      goal: { type: 'reach-mass', mass: 90 },
      params: { arenaRadius: 460, moteCap: 120, rivals: 0, barbs: 4, durationTicks: R.TICK_RATE * 180 }
    },
    {
      id: 'l6', name: 'Hunt', theme: 'verdant', seed: 'lesson-6',
      brief: 'Cells smaller than you can be absorbed — you need to be at least 15% bigger. Absorb 2 rival cells.',
      goal: { type: 'absorb-cells', count: 2 },
      params: { arenaRadius: 520, moteCap: 130, rivals: 2, rivalSkill: 0.2, barbs: 0, durationTicks: R.TICK_RATE * 240 }
    }
  ];

  // ---------- Journey: 40 authored stages (8 per theme), one concept at a time
  function journeyStages() {
    var stages = [];
    var names = [
      'First Culture', 'Open Water', 'Steady Graze', 'Rich Medium', 'Long Drift', 'Dense Bloom', 'Twin Currents', 'Lagoon Mastery',
      'First Contact', 'Shy Rival', 'The Chase', 'Crossing Paths', 'Split Decision', 'Hunter\'s Pace', 'Three\'s a Crowd', 'Amethyst Mastery',
      'Spike Garden', 'Soft Passage', 'Burst Risk', 'Barb Slalom', 'Shelter Play', 'Heavy Membrane', 'Thin Ice', 'Verdant Mastery',
      'Feeding Frenzy', 'Hot Pursuit', 'Crowded Dish', 'Eject Reserve', 'Lean Growth', 'Pressure Culture', 'Apex Rivals', 'Cinder Mastery',
      'Cold Open', 'Veil Rivals', 'Frozen Barbs', 'Long Winter', 'Deep Bloom', 'Last Medium', 'The Big Dish', 'Aurora Mastery'
    ];
    for (var i = 0; i < 40; i++) {
      var tier = Math.floor(i / 8);   // 0..4 → theme + concept block
      var step = i % 8;
      var mastery = step === 7;
      var p = {
        arenaRadius: 560 + tier * 40,
        moteCap: 120 + tier * 10 + step * 4,
        rivals: 0, rivalSkill: 0.3, barbs: 0,
        durationTicks: R.TICK_RATE * (120 + tier * 15),
        goalMass: 80 + tier * 25 + step * 8
      };
      if (tier === 0) { p.rivals = step >= 5 ? 1 : 0; p.rivalSkill = 0.25; }
      if (tier === 1) { p.rivals = 1 + (step >= 4 ? 1 : 0); p.rivalSkill = 0.3 + step * 0.03; }
      if (tier === 2) { p.rivals = 1 + (step >= 4 ? 1 : 0); p.rivalSkill = 0.4; p.barbs = 2 + Math.floor(step / 2); }
      if (tier === 3) { p.rivals = 2 + (step >= 4 ? 1 : 0); p.rivalSkill = 0.45 + step * 0.03; p.barbs = 2; }
      if (tier === 4) { p.rivals = 3 + (step >= 3 ? 1 : 0); p.rivalSkill = 0.55 + step * 0.04; p.barbs = 3 + Math.floor(step / 3); }
      if (mastery) {
        p.rivals = Math.min(6, p.rivals + 2);
        p.barbs += 2;
        p.goalMass = Math.round(p.goalMass * 1.35);
        p.durationTicks = R.TICK_RATE * (180 + tier * 20);
      }
      stages.push({
        id: 'j' + String(i + 1).padStart(2, '0'),
        version: CONTENT_VERSION,
        name: names[i],
        index: i,
        theme: THEMES[tier].id,
        seed: 'journey-' + (i + 1),
        params: p,
        mastery: mastery,
        goal: { type: 'reach-mass', mass: p.goalMass },
        parTicks: Math.round(p.durationTicks * 0.6)
      });
    }
    return stages;
  }

  // ---------- Daily: one shared seed + ruleset per UTC day
  function dailyFor(date) {
    var d = date || new Date();
    var key = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    var h = R.hashString('daily:' + key);
    var lcg = h;
    function rf(lo, hi) { lcg = (lcg * 1103515245 + 12345) & 0x7fffffff; return lo + (lcg / 0x7fffffff) * (hi - lo); }
    function ri(lo, hi) { return Math.floor(rf(lo, hi + 1)); }
    var params = {
      arenaRadius: ri(580, 700),
      moteCap: ri(130, 170),
      rivals: ri(3, 6), rivalSkill: rf(0.4, 0.7),
      barbs: ri(2, 6),
      durationTicks: R.TICK_RATE * 180,
      goalMass: ri(140, 220)
    };
    return {
      id: 'daily-' + key,
      version: CONTENT_VERSION,
      name: 'Daily Culture — ' + key,
      day: key,
      theme: THEMES[h % THEMES.length].id,
      seed: 'daily:' + key,
      params: params,
      goal: { type: 'reach-mass', mass: params.goalMass },
      parTicks: Math.round(params.durationTicks * 0.65),
      ranked: true
    };
  }

  // ---------- Practice presets (restart/rewind allowed, never ranked)
  var PRACTICE = [
    { id: 'calm', name: 'Calm', description: 'A quiet dish with one timid rival. Learn the currents.',
      params: { arenaRadius: 560, moteCap: 140, rivals: 1, rivalSkill: 0.25, barbs: 1, durationTicks: R.TICK_RATE * 150, goalMass: 100 } },
    { id: 'standard', name: 'Standard', description: 'A balanced culture: three rivals, a few barbs.',
      params: { arenaRadius: 620, moteCap: 150, rivals: 3, rivalSkill: 0.5, barbs: 3, durationTicks: R.TICK_RATE * 180, goalMass: 160 } },
    { id: 'expert', name: 'Expert', description: 'Six hungry rivals and a field of barbs.',
      params: { arenaRadius: 680, moteCap: 160, rivals: 6, rivalSkill: 0.75, barbs: 6, durationTicks: R.TICK_RATE * 200, goalMass: 220 } }
  ];

  // ---------- Challenges: constrained goals
  var CHALLENGES = [
    {
      id: 'c-lean', name: 'Lean Drift', version: CONTENT_VERSION, theme: 'lagoon',
      seed: 'challenge-lean', description: 'Reach 140 mass with ejecting disabled. Every mote matters.',
      params: { arenaRadius: 600, moteCap: 150, rivals: 2, rivalSkill: 0.45, barbs: 2, durationTicks: R.TICK_RATE * 180, goalMass: 140 },
      ejectDisabled: true, goal: { type: 'reach-mass', mass: 140 }
    },
    {
      id: 'c-sprint', name: 'Sprint Culture', version: CONTENT_VERSION, theme: 'cinder',
      seed: 'challenge-sprint', description: 'Reach 120 mass in 75 seconds. Graze aggressively.',
      params: { arenaRadius: 560, moteCap: 160, rivals: 2, rivalSkill: 0.4, barbs: 1, durationTicks: R.TICK_RATE * 75, goalMass: 120 },
      goal: { type: 'reach-mass', mass: 120 }
    },
    {
      id: 'c-crowd', name: 'Crowded Dish', version: CONTENT_VERSION, theme: 'amethyst',
      seed: 'challenge-crowd', description: 'Ten rivals in a small dish. Reach 150 mass.',
      params: { arenaRadius: 520, moteCap: 170, rivals: 10, rivalSkill: 0.5, barbs: 2, durationTicks: R.TICK_RATE * 200, goalMass: 150 },
      goal: { type: 'reach-mass', mass: 150 }
    },
    {
      id: 'c-barbs', name: 'Barb Garden', version: CONTENT_VERSION, theme: 'verdant',
      seed: 'challenge-barbs', description: 'A dozen barb clusters. Reach 130 mass — stay small or stay sharp.',
      params: { arenaRadius: 600, moteCap: 150, rivals: 2, rivalSkill: 0.45, barbs: 12, durationTicks: R.TICK_RATE * 200, goalMass: 130 },
      goal: { type: 'reach-mass', mass: 130 }
    },
    {
      id: 'c-gentle', name: 'Gentle Giant', version: CONTENT_VERSION, theme: 'aurora',
      seed: 'challenge-gentle', description: 'Reach 150 mass without absorbing a single rival cell.',
      params: { arenaRadius: 640, moteCap: 170, rivals: 4, rivalSkill: 0.5, barbs: 3, durationTicks: R.TICK_RATE * 220, goalMass: 150 },
      noRivalAbsorb: true, goal: { type: 'reach-mass', mass: 150 }
    },
    {
      id: 'c-apex', name: 'Apex Culture', version: CONTENT_VERSION, theme: 'cinder',
      seed: 'challenge-apex', description: 'Absorb 8 rival cells. No time to graze.',
      params: { arenaRadius: 640, moteCap: 150, rivals: 6, rivalSkill: 0.55, barbs: 3, durationTicks: R.TICK_RATE * 240 },
      goal: { type: 'absorb-cells', count: 8 }
    }
  ];

  // ---------- Materialize a content descriptor into a rules config
  function toConfig(content, opts) {
    opts = opts || {};
    var p = content.params;
    return {
      contentId: content.id,
      contentVersion: content.version || CONTENT_VERSION,
      seed: content.seed,
      mode: opts.mode || 'journey',
      arenaRadius: p.arenaRadius,
      moteCap: p.moteCap,
      barbCount: p.barbs || 0,
      durationTicks: p.durationTicks || 0,
      goal: content.goal || { type: 'reach-mass', mass: p.goalMass || 100 },
      noRivalAbsorb: !!content.noRivalAbsorb,
      ejectDisabled: !!content.ejectDisabled,
      splitDisabled: !!content.splitDisabled,
      allowRewind: opts.mode === 'practice',
      rivals: rivalSet(content.seed, p.rivals || 0, p.rivalSkill || 0.4, 0.12),
      playerName: opts.playerName,
      playerHue: opts.playerHue
    };
  }

  // ---------- Offline validators: legality, reachable goals, bounded duration, no soft locks
  function validateContent(content) {
    var issues = [];
    if (!content.id || !content.seed) issues.push('missing id/seed');
    var p = content.params || {};
    if (!(p.arenaRadius >= 200 && p.arenaRadius <= 1200)) issues.push('arenaRadius out of bounds');
    if (!(p.moteCap >= 0 && p.moteCap <= 400)) issues.push('moteCap out of bounds');
    if ((p.rivals || 0) < 0 || (p.rivals || 0) > 31) issues.push('rival count out of bounds');
    if ((p.barbs || 0) < 0 || (p.barbs || 0) > 30) issues.push('barb count out of bounds');
    if (content.goal && content.goal.type === 'reach-mass' && !(content.goal.mass > 20 && content.goal.mass <= 2000)) {
      issues.push('goal mass out of bounds');
    }
    if (issues.length) return issues;

    // Reachability: a goal-aware bot must be able to finish (or legitimately
    // time out ranked) within the hard tick bound — no soft locks.
    var cfg = toConfig(content, { mode: 'validation' });
    var state = R.createGame(cfg);
    var goal = state.config.goal;
    var guard = 0;
    while (state.phase !== 'terminal' && guard < R.MAX_TICKS) {
      if (goal.type === 'reach-marker') {
        R.applyCommand(state, 'p0', { type: 'setTarget', x: goal.x || 0, y: goal.y || 0 });
      } else {
        var h = R.hint(state, 'p0');
        if (h.x != null) R.applyCommand(state, 'p0', { type: 'setTarget', x: h.x, y: h.y });
        if (h.action === 'split') R.applyCommand(state, 'p0', { type: 'split' });
      }
      var legal = R.legalActions(state, 'p0');
      if (goal.type === 'eject-count' && legal.eject.ok) {
        R.applyCommand(state, 'p0', { type: 'setTarget', x: 100, y: 0 });
        R.applyCommand(state, 'p0', { type: 'eject' });
      }
      if (goal.type === 'split-then-mass' && state.stats.p0.splits === 0 && legal.split.ok) {
        R.applyCommand(state, 'p0', { type: 'split' });
      }
      R.step(state);
      guard++;
    }
    if (guard >= R.MAX_TICKS) issues.push('unbounded session (possible soft lock)');
    if (state.phase === 'terminal' && state.terminalReason === 'eliminated' && (p.rivals || 0) === 0) {
      issues.push('player eliminated with no rivals present');
    }
    for (var i = 0; i < state.cells.length; i++) {
      var c = state.cells[i];
      if (!isFinite(c.x) || !isFinite(c.y) || !isFinite(c.mass)) { issues.push('NaN in simulation'); break; }
    }
    return issues;
  }

  return {
    CONTENT_VERSION: CONTENT_VERSION,
    THEMES: THEMES,
    CVD_THEME_PATCH: CVD_THEME_PATCH,
    RIVAL_NAMES: RIVAL_NAMES,
    LESSONS: LESSONS,
    PRACTICE: PRACTICE,
    CHALLENGES: CHALLENGES,
    journeyStages: journeyStages,
    dailyFor: dailyFor,
    rivalSet: rivalSet,
    toConfig: toConfig,
    validateContent: validateContent,
    themeById: function (id) {
      for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
      return THEMES[0];
    }
  };
}));
