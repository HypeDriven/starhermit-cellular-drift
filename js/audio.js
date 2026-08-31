/*
 * Cellular Drift — audio: WebAudio procedural synth, no assets.
 * Buses: music / effects / ambience / voice, independent gains.
 * Short transients are tied to logical game events; variants are seeded so
 * replays sound identical. Captions are emitted through onCaption for the UI.
 */
export function createAudio(opts) {
  const settings = Object.assign({
    music: 0.6, effects: 0.9, ambience: 0.5, voice: 0.8, muted: false
  }, opts || {});

  let ctx = null;
  let buses = null;
  let master = null;
  let started = false;
  let musicTimer = null;
  let ambienceNodes = null;
  let intensity = 0; // 0..1 adaptive music intensity (driven by growth/threat)
  let captionCb = null;
  let variantSeed = 1;

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    buses = {};
    for (const name of ['music', 'effects', 'ambience', 'voice']) {
      const g = ctx.createGain();
      g.gain.value = settings.muted ? 0 : settings[name];
      g.connect(master);
      buses[name] = g;
    }
    return ctx;
  }

  function applyVolumes() {
    if (!buses) return;
    for (const name of Object.keys(buses)) {
      buses[name].gain.value = settings.muted ? 0 : settings[name];
    }
  }

  // seeded pitch variant (±6%) so replays sound the same
  function variant() {
    variantSeed = (variantSeed * 1103515245 + 12345) & 0x7fffffff;
    return 1 + ((variantSeed % 1000) / 1000 - 0.5) * 0.12;
  }

  function caption(text) { if (captionCb) captionCb(text); }

  // ---------- authored samples: event -> sfx/<basename>.opus (see sfx/manifest.json)
  // Lazy-fetched/decoded/cached only after the user-gesture unlock; synthesis
  // below stays the fallback while a sample loads or if it fails.
  const SAMPLES = {
    ui: 'ui-tick',
    absorb: 'mote-absorb',
    pellet: 'pellet-gulp',
    absorbBig: 'cell-absorb-big',
    split: 'cell-split',
    eject: 'mass-eject',
    burst: 'barb-burst',
    danger: 'danger-ping',
    countdown: 'countdown-beep',
    go: 'round-start-go',
    rewind: 'time-rewind',
    win: 'goal-win',
    lose: 'round-lose',
    timeup: 'time-up',
    achievement: 'achievement-unlock'
  };
  const sampleCache = {}; // event name -> { state: 'loading'|'ready'|'failed', buffer }

  function loadSample(name) {
    const entry = sampleCache[name];
    if (entry) return entry;
    const fresh = { state: 'loading', buffer: null };
    sampleCache[name] = fresh;
    fetch('./sfx/' + SAMPLES[name] + '.opus')
      .then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => { fresh.buffer = buf; fresh.state = 'ready'; })
      .catch(() => { fresh.state = 'failed'; });
    return fresh;
  }

  // returns true when a cached sample was played (once) through the effects bus
  function playSample(name) {
    if (!ctx || !SAMPLES[name]) return false;
    const entry = loadSample(name);
    if (entry.state !== 'ready') return false;
    const src = ctx.createBufferSource();
    src.buffer = entry.buffer;
    src.connect(buses.effects);
    src.start();
    return true;
  }

  function blip(bus, freq, dur, type, gain, when, slide) {
    if (!ensureCtx()) return;
    const t = when || ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.2, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(buses[bus]);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noiseBurst(bus, dur, gain, freq, q) {
    if (!ensureCtx()) return;
    const t = ctx.currentTime;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = freq || 800; f.Q.value = q || 1.2;
    const g = ctx.createGain();
    g.gain.value = gain || 0.2;
    src.connect(f); f.connect(g); g.connect(buses[bus]);
    src.start(t);
  }

  // ---------- event mapping (called by the session on logical events)
  const events = {
    ui() { blip('effects', 520 * variant(), 0.07, 'triangle', 0.12); },
    absorb() { // mote graze: soft plip
      blip('effects', 660 * variant(), 0.09, 'sine', 0.14, 0, 180);
      caption('absorbed a mote');
    },
    pellet() {
      blip('effects', 500 * variant(), 0.08, 'sine', 0.12, 0, 120);
    },
    absorbBig() { // rival cell absorbed: layered membrane thump
      blip('effects', 220 * variant(), 0.22, 'sine', 0.3, 0, -120);
      blip('effects', 440 * variant(), 0.12, 'triangle', 0.16, 0, 220);
      noiseBurst('effects', 0.1, 0.1, 1200, 1.5);
      caption('absorbed a rival cell');
    },
    split() {
      blip('effects', 300 * variant(), 0.16, 'sawtooth', 0.12, 0, 340);
      blip('effects', 150 * variant(), 0.2, 'sine', 0.2, 0, -60);
      caption('split');
    },
    eject() {
      blip('effects', 380 * variant(), 0.1, 'square', 0.07, 0, -120);
      caption('ejected mass');
    },
    burst() { // barb burst: sharp crack
      noiseBurst('effects', 0.25, 0.3, 2400, 0.8);
      blip('effects', 180, 0.3, 'sawtooth', 0.18, 0, -110);
      caption('burst on a barb');
    },
    danger() { // threat proximity ping
      blip('effects', 880, 0.12, 'sine', 0.1, 0, -200);
      caption('larger cell nearby');
    },
    countdown() { blip('effects', 440, 0.12, 'triangle', 0.18); },
    go() { blip('effects', 660, 0.25, 'triangle', 0.22, 0, 220); },
    rewind() {
      blip('effects', 700, 0.2, 'sine', 0.12, 0, -420);
      caption('rewound');
    },
    win() {
      const t = ensureCtx() && ctx.currentTime;
      [523, 659, 784, 1047].forEach((f, i) => blip('effects', f, 0.3, 'triangle', 0.2, t + i * 0.12));
      caption('goal complete');
    },
    lose() {
      const t = ensureCtx() && ctx.currentTime;
      [392, 330, 262].forEach((f, i) => blip('effects', f, 0.35, 'sine', 0.2, t + i * 0.16));
      caption('absorbed');
    },
    timeup() {
      const t = ensureCtx() && ctx.currentTime;
      [440, 440, 550].forEach((f, i) => blip('effects', f, 0.2, 'triangle', 0.16, t + i * 0.14));
      caption('time up');
    },
    achievement() {
      const t = ensureCtx() && ctx.currentTime;
      [784, 988, 1319].forEach((f, i) => blip('effects', f, 0.25, 'sine', 0.16, t + i * 0.09));
      caption('achievement unlocked');
    }
  };

  function play(name) {
    if (!started || settings.muted) { if (events[name]) caption(name); return; }
    if (!events[name]) return;
    if (playSample(name)) { caption(name); return; }
    events[name]();
  }

  // ---------- ambience: filtered noise "medium" with slow LFO
  function startAmbience() {
    if (!ensureCtx() || ambienceNodes) return;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 240; f.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.value = 0.35;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 90;
    lfo.connect(lfoG); lfoG.connect(f.frequency);
    src.connect(f); f.connect(g); g.connect(buses.ambience);
    src.start(); lfo.start();
    ambienceNodes = { src, lfo, g };
  }
  function stopAmbience() {
    if (!ambienceNodes) return;
    try { ambienceNodes.src.stop(); ambienceNodes.lfo.stop(); } catch {}
    ambienceNodes = null;
  }

  // ---------- adaptive music: slow pentatonic pad arpeggio
  const SCALE = [0, 3, 5, 7, 10, 12, 15]; // minor pentatonic over a root
  const ROOT = 196; // G3
  let stepIdx = 0;
  function musicStep() {
    if (!started || settings.muted || !ctx) return;
    const t = ctx.currentTime + 0.05;
    const degree = SCALE[(stepIdx * 3 + (stepIdx >> 2)) % SCALE.length];
    const freq = ROOT * Math.pow(2, degree / 12) * (stepIdx % 8 >= 4 ? 0.5 : 1);
    const dur = 1.6 - intensity * 0.7;
    blip('music', freq, dur, 'sine', 0.07 + intensity * 0.05, t);
    blip('music', freq * 2.01, dur * 0.8, 'sine', 0.025, t);
    if (intensity > 0.45 && stepIdx % 2 === 0) {
      blip('music', ROOT / 2, dur, 'triangle', 0.05, t);
    }
    stepIdx++;
  }
  function startMusic() {
    if (musicTimer || !ensureCtx()) return;
    stepIdx = 0;
    musicTimer = setInterval(musicStep, 420);
  }
  function stopMusic() {
    if (musicTimer) clearInterval(musicTimer);
    musicTimer = null;
  }

  return {
    // unlock on first user gesture
    unlock() {
      if (!ensureCtx()) return false;
      if (ctx.state === 'suspended') ctx.resume();
      if (!started) {
        started = true;
        startMusic();
        startAmbience();
      }
      return true;
    },
    play,
    setIntensity(v) { intensity = Math.max(0, Math.min(1, v)); },
    setSeed(seed) { variantSeed = (seed & 0x7fffffff) || 1; },
    setVolume(name, v) { settings[name] = v; applyVolumes(); },
    setMuted(m) { settings.muted = m; applyVolumes(); },
    suspend() { // backgrounded tab: keep clocks, silence output
      stopMusic();
      if (ctx && ctx.state === 'running') ctx.suspend();
    },
    resume() {
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume();
      if (started) startMusic();
    },
    onCaption(cb) { captionCb = cb; },
    get started() { return started; }
  };
}
