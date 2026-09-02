/*
 * Cellular Drift — browser game: Three.js scene + semantic HTML UI shell.
 * The rules engine (rules.js) is the single source of truth; this module only
 * wires input, rendering, audio and persistence to it. No timers drive state.
 */
import * as THREE from 'three';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';
import { createPlatform } from './platform.js';

const R = window.CDRules;
const C = window.CDContent;
const S = window.CDStore;

// ---------- DOM helpers (single shared layout model) ----------
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'style') e.style.cssText = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  if (children) for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  }
  return e;
}

// ---------- module state ----------
let canvas = null, renderer = null, audio = null, platform = null;
let game = null;                 // rules state (immutable-ish snapshot)
let sessionSeed = 0;            // per-round seed for replay/AV variants
let roundStartedAtMs = 0;       // wall-clock when the active round began
let lastRoundEndReason = '';    // 'win' | 'lose' | 'timeup' | '' (drives result audio)

// UI references (populated in buildUI)
const ui = {};

function nowSec() { return Date.now(); }

// ---------- one-time init: canvas, renderer, platform time sync ----------
async function boot() {
  document.body.innerHTML = '';
  const wrap = el('div', { class: 'cd-root' });
  document.body.appendChild(wrap);

  canvas = el('canvas', { id: 'cd-canvas', width: '800', height: '600' });
  wrap.appendChild(canvas);

  renderer = createRenderer(canvas, {});
  renderer.resize();
  window.addEventListener('resize', () => renderer.resize());
  audio = createAudio({});
  platform = createPlatform();
  try { await platform.syncTime(); } catch (e) {}

  buildUI(wrap);
}

// ---------- UI construction: every screen is built here once ----------
function buildUI(root) {
  // ---- title / home ----
  const titleScreen = el('section', { class: 'cd-screen cd-title' }, [
    el('h1', { class: 'cd-game-title' }, ['Cellular Drift']),
    el('p', { class: 'cd-tagline' }, ['A realtime mass arena. Move, absorb, split, eject — and manage the threats that hunt you.'])
  ]);

  const playBtn = el('button', { class: 'cd-btn cd-play' }, ['Play']);
  playBtn.addEventListener('click', () => showModeSelect());
  titleScreen.appendChild(playBtn);

  // ---- mode select (learn / journey / daily / practice / challenge) ----
  const modeSel = el('section', { class: 'cd-screen cd-modesel' }, [
    el('h2', {}, ['Choose a mode'])
  ]);
  function modeRow(label, sub, fn) {
    const b = el('button', { class: 'cd-btn cd-modebtn' }, [label]);
    if (sub) b.appendChild(el('span', { class: 'cd-sub' }, [sub]));
    b.addEventListener('click', fn);
    modeSel.appendChild(b);
  }
  modeRow('Learn', null, () => showLessons());
  modeRow('Journey', null, () => showJourney());
  modeRow('Daily Challenge', null, () => showDailySetup());
  modeRow('Practice', null, () => showPracticeSelect());
  modeRow('Challenge', null, () => showChallenges());

  // ---- learn lessons list ----
  const lessonList = el('section', { class: 'cd-screen cd-lessonlist' }, [el('h2', {}, ['Lessons'])]);
  C.LESSONS.forEach((l) => {
    const b = el('button', { class: 'cd-btn cd-itembtn' }, [l.name, l.brief ? '' : '']);
    if (S.load().progress.lessonsDone[l.id]) b.appendChild(el('span', { class: 'cd-done' }, ['done']));
    b.addEventListener('click', () => startLesson(l));
    lessonList.appendChild(b);
  });

  // ---- journey stages list ----
  const journeyList = el('section', { class: 'cd-screen cd-journeylist' }, [el('h2', {}, ['Journey'])]);
  C.journeyStages().forEach((st) => {
    const b = el('button', { class: 'cd-btn cd-itembtn' }, [st.name, st.mastery ? '' : '']);
    if (S.load().progress.journeyStars[st.id]) b.appendChild(el('span', { class: 'cd-done' }, ['done']));
    b.addEventListener('click', () => startJourney(st));
    journeyList.appendChild(b);
  });

  // ---- daily setup ----
  const dailySetup = el('section', { class: 'cd-screen cd-dailysetup' }, [el('h2', {}, ['Daily Challenge'])]);
  const dStartBtn = el('button', { class: 'cd-btn cd-itembtn' }, ['Begin the day']);
  dStartBtn.addEventListener('click', () => startDaily());
  dailySetup.appendChild(dStartBtn);

  // ---- practice preset select ----
  const pracSel = el('section', { class: 'cd-screen cd-pracsel' }, [el('h2', {}, ['Practice'])]);
  C.PRACTICE.forEach((p) => {
    const b = el('button', { class: 'cd-btn cd-itembtn' }, [p.name, p.description ? '' : '']);
    if (S.load().progress.practiceDone && S.load().progress.practiceDone[p.id]) b.appendChild(el('span', { class: 'cd-done' }, ['done']));
    b.addEventListener('click', () => startPractice(p));
    pracSel.appendChild(b);
  });

  // ---- challenges list ----
  const chalList = el('section', { class: 'cd-screen cd-challist' }, [el('h2', {}, ['Challenges'])]);
  C.CHALLENGES.forEach((ch) => {
    const b = el('button', { class: 'cd-btn cd-itembtn' }, [ch.name, ch.description ? '' : '']);
    if (S.load().progress.challengeDone && S.load().progress.challengeDone[ch.id]) b.appendChild(el('span', { class: 'cd-done' }, ['done']));
    b.addEventListener('click', () => startChallenge(ch));
    chalList.appendChild(b);
  });

  // ---- play HUD ----
  const hud = el('section', { class: 'cd-screen cd-hud' }, [
    el('div', { class: 'cd-objective' }, ['']),
    el('div', { class: 'cd-progress' }, ['']),
    el('button', { class: 'cd-btn cd-pausebtn' }, ['Pause'])
  ]);

  // ---- pause / settings overlay ----
  const pause = el('section', { class: 'cd-screen cd-pause' }, [el('h2', {}, ['Paused'])]);
  function settingRow(label, key) {
    const row = el('div', { class: 'cd-setrow' });
    row.appendChild(el('span', {}, [label]));
    const inp = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(S.load().settings[key] != null ? S.load().settings[key] : 0) });
    row.appendChild(inp);
    pause.appendChild(row);
    return inp;
  }
  const musicVol = settingRow('Music volume', 'music');
  const fxVol = settingRow('Effects volume', 'effects');
  const ambVol = settingRow('Ambience volume', 'ambience');
  const voiceVol = settingRow('Voice volume', 'voice');
  function toggleRow(label, key) {
    const row = el('div', { class: 'cd-setrow' });
    row.appendChild(el('span', {}, [label]));
    const inp = el('input', { type: 'checkbox', checked: S.load().settings[key] ? true : false });
    row.appendChild(inp);
    pause.appendChild(row);
    return inp;
  }
  const mutedChk = toggleRow('Mute all audio', 'muted');
  const captionsChk = toggleRow('Captions / text cues', 'captions');
  function onVolChange() {
    S.save(Object.assign(S.load(), { settings: Object.assign({}, S.load().settings, { music: +musicVol.value, effects: +fxVol.value, ambience: +ambVol.value, voice: +voiceVol.value }) }));
    if (audio) audio.setVolumes({ music: +musicVol.value, effects: +fxVol.value, ambience: +ambVol.value, voice: +voiceVol.value });
  }
  function onToggleChange() {
    S.save(Object.assign(S.load(), { settings: Object.assign({}, S.load().settings, { muted: mutedChk.checked ? true : false, captions: captionsChk.checked ? true : false }) }));
    if (audio) audio.setMuted(mutedChk.checked);
  }
  musicVol.addEventListener('input', onVolChange);
  fxVol.addEventListener('input', onVolChange);
  ambVol.addEventListener('input', onVolChange);
  voiceVol.addEventListener('input', onVolChange);
  mutedChk.addEventListener('change', onToggleChange);
  captionsChk.addEventListener('change', onToggleChange);

  // ---- results overlay ----
  const result = el('section', { class: 'cd-screen cd-result' }, [el('h2', {}, ['Results'])]);

  // ---- help overlay ----
  const help = el('section', { class: 'cd-screen cd-help' }, [el('h2', {}, ['Help & rules'])]);

  root.appendChild(titleScreen);
  root.appendChild(modeSel);
  root.appendChild(lessonList);
  root.appendChild(journeyList);
  root.appendChild(dailySetup);
  root.appendChild(pracSel);
  root.appendChild(chalList);
  root.appendChild(hud);
  root.appendChild(pause);
  root.appendChild(result);
  root.appendChild(help);

  ui.titleScreen = titleScreen;
  ui.modeSel = modeSel;
  ui.lessonList = lessonList;
  ui.journeyList = journeyList;
  ui.dailySetup = dailySetup;
  ui.pracSel = pracSel;
  ui.chalList = chalList;
  ui.hud = hud;
  ui.pause = pause;
  ui.result = result;
  ui.help = help;

  // show title by default
  showScreen('title');
}

// ---------- screen switching (single owner) ----------
function showScreen(name) {
  const map = {
    'title': ui.titleScreen, 'modesel': ui.modeSel, 'lessons': ui.lessonList,
    'journey': ui.journeyList, 'daily': ui.dailySetup, 'practice': ui.pracSel,
    'challenge': ui.chalList, 'hud': ui.hud, 'pause': ui.pause, 'result': ui.result, 'help': ui.help
  };
  for (const k in map) {
    const s = map[k];
    if (!s) continue;
    const show = (k === name);
    s.style.display = show ? '' : 'none';
    if (show && s.classList.contains('cd-overlay')) s.setAttribute('data-open', '1'); else if (!show) s.removeAttribute('data-open');
  }
}

function showTitle() { showScreen('title'); }
function showModeSelect() { showScreen('modesel'); }
function showLessons() { showScreen('lessons'); }
function showJourney() { showScreen('journey'); }
function showDailySetup() { showScreen('daily'); }
function showPracticeSelect() { showScreen('practice'); }
function showChallenges() { showScreen('challenge'); }

// ---------- start a round (all modes funnel here) ----------
function startLesson(l) { game = R.createGame(C.toConfig({ id: l.id, seed: l.seed, params: l.params }, {})); sessionSeed = 0; roundStartedAtMs = nowSec(); showScreen('hud'); }
function startJourney(st) { const cfg = C.toConfig({ id: st.id, version: st.version, name: st.name, index: st.index, theme: st.theme, seed: st.seed, params: st.params }, {}); game = R.createGame(cfg); sessionSeed = 0; roundStartedAtMs = nowSec(); showScreen('hud'); }
function startDaily() { const d = C.dailyFor(new Date()); const cfg = C.toConfig({ id: d.id, version: d.version, name: d.name, day: d.day, theme: d.theme, seed: d.seed, params: d.params }, {}); game = R.createGame(cfg); sessionSeed = 0; roundStartedAtMs = nowSec(); showScreen('hud'); }
function startPractice(p) { const cfg = C.toConfig({ id: p.id, name: p.name, description: p.description, seed: 'practice-' + (p.params ? '' : ''), params: p.params }, {}); game = R.createGame(cfg); sessionSeed = 0; roundStartedAtMs = nowSec(); showScreen('hud'); }
function startChallenge(ch) { const cfg = C.toConfig({ id: ch.id, name: ch.name, version: ch.version, theme: ch.theme, seed: ch.seed, description: ch.description, params: ch.params }, {}); game = R.createGame(cfg); sessionSeed = 0; roundStartedAtMs = nowSec(); showScreen('hud'); }

// ---------- main loop (requestAnimationFrame) ----------
let rafId = null;
function frame() {
  if (!game) return;
  const g = game;
  // step the rules engine once per rAF tick (fixed-step realtime)
  R.step(g);
  renderer.syncState(g, sessionSeed);
  audio.setSeed(sessionSeed || 1);
  updateHUD();
  rafId = requestAnimationFrame(frame);
}

// ---------- HUD: objective / progress / actions / pause ----------
function updateHUD() {
  if (!game) return;
  const g = game;
  // objective text (from rules goal + terminal reason)
  let objText = 'Survive and grow.';
  if (g.config.goal.type === 'reach-mass') objText = 'Reach the target mass. Absorb motes, pellets and smaller cells to grow.';
  else if (g.config.goal.type === 'absorb-cells') objText = 'Absorb rival cells.';
  // progress: alive count + tick
  const prog = g.phase === 'terminal' ? 'Round over.' : ('Tick ' + g.tick);
}

// ---------- public entry point used by index.html module script ----------
window.CDApp = { boot };

boot();
