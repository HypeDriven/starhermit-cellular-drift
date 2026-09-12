/*
 * Cellular Drift — browser game: Three.js scene + semantic HTML UI shell.
 * The rules engine (rules.js) is the single source of truth; this module only
 * wires input, rendering, audio and persistence to it. The simulation runs on
 * a fixed-step accumulator so game speed is independent of display rate.
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
let paused = false;              // solo simulation pause (menu or backgrounded tab)
let terminalShown = false;       // results overlay already presented for this round
let currentContent = null;       // content descriptor of the running round
let currentMode = '';            // learn | journey | daily | practice | challenge
let sessionId = '';              // stable id for this round (leaderboard tie-break)
let roundStartedAtMs = 0;        // wall-clock when the active round began
let cmdSeq = 0;                  // action identifiers: prevents accidental double commits
let hintUntilMs = 0;             // hint marker auto-hide deadline
let lastDangerPingMs = 0;
let prevStats = null;            // per-tick stat diffing drives event audio

// UI references (populated in buildUI)
const ui = {};

function nowMs() { return Date.now(); }

function settings() { return S.load().settings; }

// ---------- one-time init: canvas, renderer, platform time sync ----------
async function boot() {
  document.body.innerHTML = '';
  const wrap = el('div', { class: 'cd-root' });
  document.body.appendChild(wrap);

  canvas = el('canvas', { id: 'cd-canvas', width: '800', height: '600' });
  wrap.appendChild(canvas);

  try {
    renderer = createRenderer(canvas, {});
  } catch (e) {
    wrap.appendChild(el('section', { class: 'cd-screen cd-compat' }, [
      el('h2', {}, ['3D unavailable']),
      el('p', {}, ['Cellular Drift needs WebGL to render the dish. Your progress and settings are preserved; try a browser with WebGL enabled.'])
    ]));
    document.body.setAttribute('data-cd-booted', '1'); // a visible explanation is a completed boot
    return;
  }
  renderer.resize();
  window.addEventListener('resize', () => renderer.resize());
  audio = createAudio(settings());
  platform = createPlatform();
  window.CDPlatform = platform; // store.js mirrors saves through this hook
  try { await platform.init(); } catch (e) {}
  try { await platform.syncTime(); } catch (e) {}
  if (platform.hosted) {
    // Remote save wins over the local cache; the doc stays checksummed.
    platform.fetchProfile().then(renderAccountLine).catch(() => {});
    platform.loadCloud().then((remoteRaw) => {
      const remoteDoc = S.loadRaw(remoteRaw);
      if (remoteDoc) S.save(remoteDoc); // local cache mirrors the remote doc
      renderAccountLine();
    });
    platform.onSync(renderAccountLine);
  }

  // first user gesture unlocks WebAudio (autoplay policy)
  const unlock = () => { audio.unlock(); };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  // backgrounding pauses the solo simulation and silences output
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (game && game.phase === 'active' && !paused) pauseGame();
      audio.suspend();
    } else {
      audio.resume();
    }
  });

  buildUI(wrap);
  applyPresentationSettings();
  wireInput();
  requestAnimationFrame(frame);
  document.body.setAttribute('data-cd-booted', '1'); // clears the index.html boot watchdog
}

function applyPresentationSettings() {
  const st = settings();
  renderer.setReducedMotion(!!st.reducedMotion);
  renderer.setHighContrast(!!st.highContrast);
  document.body.classList.toggle('cd-hc', !!st.highContrast); // CSS: drops decorative backdrops
  if (st.graphicsTier && st.graphicsTier !== 'auto') renderer.setTier(st.graphicsTier);
  applyTheme(currentContent);
}

function applyTheme(content) {
  const st = settings();
  const theme = C.themeById((content && content.theme) || st.theme || 'lagoon');
  renderer.setTheme(theme, st.cvdPalette ? C.CVD_THEME_PATCH : null);
  if (game) renderer.setDecorSeed(game.seed);
}

// ---------- UI construction: every screen is built here once ----------
function buildUI(root) {
  // ---- title / home ----
  const titleScreen = el('section', { class: 'cd-screen cd-title' }, [
    el('h1', { class: 'cd-game-title' }, ['Cellular Drift']),
    el('p', { class: 'cd-tagline' }, ['A realtime mass arena. Move, absorb, split, eject — and manage the threats that hunt you.']),
    el('p', { id: 'cd-account', class: 'cd-sub' }, [''])
  ]);
  const playBtn = el('button', { class: 'cd-btn cd-play' }, ['Play']);
  playBtn.addEventListener('click', () => { audio.play('ui'); showModeSelect(); });
  titleScreen.appendChild(playBtn);
  const helpBtn = el('button', { class: 'cd-btn' }, ['Help & rules']);
  helpBtn.addEventListener('click', () => { audio.play('ui'); showScreen('help'); });
  titleScreen.appendChild(helpBtn);

  // ---- mode select (learn / journey / daily / practice / challenge) ----
  const modeSel = el('section', { class: 'cd-screen cd-modesel' }, [
    el('h2', {}, ['Choose a mode'])
  ]);
  function modeRow(label, sub, fn) {
    const b = el('button', { class: 'cd-btn cd-modebtn' }, [label]);
    if (sub) b.appendChild(el('span', { class: 'cd-sub' }, [sub]));
    b.addEventListener('click', () => { audio.play('ui'); fn(); });
    modeSel.appendChild(b);
  }
  modeRow('Learn', null, () => showLessons());
  modeRow('Journey', null, () => showJourney());
  modeRow('Daily Challenge', null, () => showDailySetup());
  modeRow('Practice', null, () => showPracticeSelect());
  modeRow('Challenge', null, () => showChallenges());
  modeSel.appendChild(backButton('Back', showTitle));

  // ---- learn lessons list ----
  const lessonList = el('section', { class: 'cd-screen cd-lessonlist' }, [el('h2', {}, ['Lessons'])]);
  C.LESSONS.forEach((l) => {
    const b = el('button', { class: 'cd-btn cd-itembtn', 'data-cid': l.id }, [l.name]);
    if (l.brief) b.appendChild(el('span', { class: 'cd-sub' }, [l.brief]));
    b.addEventListener('click', () => { audio.play('ui'); startRound(l, 'learn'); });
    lessonList.appendChild(b);
  });
  lessonList.appendChild(backButton('Back', showModeSelect));

  // ---- journey stages list ----
  const journeyList = el('section', { class: 'cd-screen cd-journeylist' }, [el('h2', {}, ['Journey'])]);
  C.journeyStages().forEach((st) => {
    const b = el('button', { class: 'cd-btn cd-itembtn', 'data-cid': st.id }, [st.name]);
    if (st.mastery) b.appendChild(el('span', { class: 'cd-sub' }, ['mastery stage']));
    b.addEventListener('click', () => { audio.play('ui'); startRound(st, 'journey'); });
    journeyList.appendChild(b);
  });
  journeyList.appendChild(backButton('Back', showModeSelect));

  // ---- daily setup ----
  const daily = C.dailyFor(platform.now());
  const dailySetup = el('section', { class: 'cd-screen cd-dailysetup' }, [
    el('h2', {}, ['Daily Challenge']),
    el('p', { class: 'cd-sub' }, [daily.name + ' — reach ' + daily.goal.mass + ' mass in 3 minutes. Ranked.'])
  ]);
  const dStartBtn = el('button', { class: 'cd-btn cd-itembtn' }, ['Begin the day']);
  dStartBtn.addEventListener('click', () => { audio.play('ui'); startRound(C.dailyFor(platform.now()), 'daily'); });
  dailySetup.appendChild(dStartBtn);
  dailySetup.appendChild(backButton('Back', showModeSelect));

  // ---- practice preset select ----
  const pracSel = el('section', { class: 'cd-screen cd-pracsel' }, [el('h2', {}, ['Practice'])]);
  C.PRACTICE.forEach((p) => {
    const b = el('button', { class: 'cd-btn cd-itembtn', 'data-cid': p.id }, [p.name]);
    if (p.description) b.appendChild(el('span', { class: 'cd-sub' }, [p.description]));
    b.addEventListener('click', () => { audio.play('ui'); startRound(p, 'practice'); });
    pracSel.appendChild(b);
  });
  pracSel.appendChild(backButton('Back', showModeSelect));

  // ---- challenges list ----
  const chalList = el('section', { class: 'cd-screen cd-challist' }, [el('h2', {}, ['Challenges'])]);
  C.CHALLENGES.forEach((ch) => {
    const b = el('button', { class: 'cd-btn cd-itembtn', 'data-cid': ch.id }, [ch.name]);
    if (ch.description) b.appendChild(el('span', { class: 'cd-sub' }, [ch.description]));
    b.addEventListener('click', () => { audio.play('ui'); startRound(ch, 'challenge'); });
    chalList.appendChild(b);
  });
  chalList.appendChild(backButton('Back', showModeSelect));

  // ---- play HUD ----
  const hud = el('section', { class: 'cd-screen cd-hud' }, [
    el('div', { class: 'cd-hudtop' }, [
      el('div', { class: 'cd-objective', role: 'status', 'aria-live': 'polite' }, ['']),
      el('div', { class: 'cd-progress' }, [''])
    ]),
    (() => {
      const b = el('button', { class: 'cd-btn cd-pausebtn' }, ['Pause']);
      b.addEventListener('click', () => pauseGame());
      return b;
    })(),
    (() => {
      const tray = el('div', { class: 'cd-actions' });
      const splitBtn = el('button', { class: 'cd-btn cd-actbtn' }, ['Split']);
      splitBtn.addEventListener('click', () => doAction('split'));
      const ejectBtn = el('button', { class: 'cd-btn cd-actbtn' }, ['Eject']);
      ejectBtn.addEventListener('click', () => doAction('eject'));
      const hintBtn = el('button', { class: 'cd-btn cd-actbtn' }, ['Hint']);
      hintBtn.addEventListener('click', () => showHint());
      tray.appendChild(splitBtn); tray.appendChild(ejectBtn); tray.appendChild(hintBtn);
      ui.splitBtn = splitBtn; ui.ejectBtn = ejectBtn;
      return tray;
    })(),
    el('div', { class: 'cd-captions', 'aria-live': 'polite' }, [''])
  ]);

  // ---- pause / settings overlay ----
  const pause = el('section', { class: 'cd-screen cd-pause' }, [el('h2', {}, ['Paused'])]);
  const resumeBtn = el('button', { class: 'cd-btn cd-itembtn' }, ['Resume']);
  resumeBtn.addEventListener('click', () => resumeGame());
  pause.appendChild(resumeBtn);
  const restartBtn = el('button', { class: 'cd-btn cd-itembtn' }, ['Restart round']);
  restartBtn.addEventListener('click', () => { paused = false; startRound(currentContent, currentMode); });
  pause.appendChild(restartBtn);
  const leaveBtn = el('button', { class: 'cd-btn cd-itembtn' }, ['Leave to modes']);
  leaveBtn.addEventListener('click', () => { endSession(); showModeSelect(); });
  pause.appendChild(leaveBtn);
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
    const inp = el('input', { type: 'checkbox' });
    inp.checked = !!S.load().settings[key]; // property, not attribute: setAttribute('checked','false') still checks the box
    row.appendChild(inp);
    pause.appendChild(row);
    return inp;
  }
  const mutedChk = toggleRow('Mute all audio', 'muted');
  const captionsChk = toggleRow('Captions / text cues', 'captions');
  const motionChk = toggleRow('Reduced motion', 'reducedMotion');
  const contrastChk = toggleRow('High contrast', 'highContrast');
  const cvdChk = toggleRow('Color-vision-safe palette', 'cvdPalette');
  function onVolChange() {
    S.save(Object.assign(S.load(), { settings: Object.assign({}, S.load().settings, { music: +musicVol.value, effects: +fxVol.value, ambience: +ambVol.value, voice: +voiceVol.value }) }));
    if (audio) audio.setVolumes({ music: +musicVol.value, effects: +fxVol.value, ambience: +ambVol.value, voice: +voiceVol.value });
  }
  function onToggleChange() {
    S.save(Object.assign(S.load(), { settings: Object.assign({}, S.load().settings, {
      muted: !!mutedChk.checked, captions: !!captionsChk.checked,
      reducedMotion: !!motionChk.checked, highContrast: !!contrastChk.checked, cvdPalette: !!cvdChk.checked
    }) }));
    if (audio) audio.setMuted(mutedChk.checked);
    applyPresentationSettings();
  }
  musicVol.addEventListener('input', onVolChange);
  fxVol.addEventListener('input', onVolChange);
  ambVol.addEventListener('input', onVolChange);
  voiceVol.addEventListener('input', onVolChange);
  mutedChk.addEventListener('change', onToggleChange);
  captionsChk.addEventListener('change', onToggleChange);
  motionChk.addEventListener('change', onToggleChange);
  contrastChk.addEventListener('change', onToggleChange);
  cvdChk.addEventListener('change', onToggleChange);

  // ---- results overlay (populated per round in showResults) ----
  const result = el('section', { class: 'cd-screen cd-result', 'aria-live': 'polite' }, [el('h2', {}, ['Results'])]);

  // ---- help overlay ----
  const help = el('section', { class: 'cd-screen cd-help' }, [
    el('h2', {}, ['Help & rules']),
    el('div', { class: 'cd-helptext' }, [
      el('p', {}, ['Steer your cell with the pointer (or arrow keys / WASD). Absorb nutrient motes, pellets, and cells at least 15% smaller than you to grow.']),
      el('p', {}, ['Split (Space) launches half your mass forward to attack or travel. Eject (E) sheds pellets to feed allies or lighten up. Spiked barbs burst cells of 60+ mass — small cells slip by.']),
      el('p', {}, ['Pause with Esc or the Pause button. Rank is by mass and survival; ties break on objective completion, fewer invalid actions, then faster time.'])
    ]),
    (() => {
      const b = el('button', { class: 'cd-btn cd-itembtn' }, ['Close']);
      b.addEventListener('click', () => showTitle());
      return b;
    })()
  ]);

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
  ui.objective = hud.querySelector('.cd-objective');
  ui.progress = hud.querySelector('.cd-progress');
  ui.captions = hud.querySelector('.cd-captions');

  audio.onCaption((text) => {
    if (!S.load().settings.captions) return;
    ui.captions.textContent = text;
    clearTimeout(ui._capT);
    ui._capT = setTimeout(() => { ui.captions.textContent = ''; }, 1600);
  });

  // show title by default
  showScreen('title');
}

// "done" badges reflect the save document at the moment a list is shown, so a
// round finished this session is marked without a reload.
function refreshProgressMarks() {
  const prog = S.load().progress;
  const mark = (list, textFor) => {
    if (!list) return;
    for (const b of list.querySelectorAll('.cd-itembtn[data-cid]')) {
      const text = textFor(b.getAttribute('data-cid'));
      let badge = b.querySelector('.cd-done');
      if (!text) { if (badge) badge.remove(); continue; }
      if (!badge) { badge = el('span', { class: 'cd-done' }, ['']); b.appendChild(badge); }
      badge.textContent = text;
    }
  };
  mark(ui.lessonList, (id) => prog.lessonsDone[id] ? 'done' : '');
  mark(ui.journeyList, (id) => {
    const stars = prog.journeyStars[id];
    return stars ? 'done' + (stars > 1 ? ' ★'.repeat(Math.min(3, stars)) : '') : '';
  });
  mark(ui.pracSel, (id) => prog.practiceDone && prog.practiceDone[id] ? 'done' : '');
  mark(ui.chalList, (id) => prog.challengeDone && prog.challengeDone[id] ? 'done' : '');
}

function backButton(label, fn) {
  const b = el('button', { class: 'cd-btn cd-backbtn' }, [label]);
  b.addEventListener('click', () => { audio.play('ui'); fn(); });
  return b;
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
  if (name === 'lessons' || name === 'journey' || name === 'practice' || name === 'challenge') refreshProgressMarks();
  // keyboard users land on the first control of the newly shown screen;
  // the HUD is the exception: focus there would swallow Space for the button
  const first = name !== 'hud' && map[name] && map[name].querySelector('button, input');
  if (first) first.focus({ preventScroll: true });
}

function showTitle() { showScreen('title'); }

// Account + cloud-sync status line on the title screen. Offline keeps the
// identical local-only behaviour; hosted shows the account nickname.
function renderAccountLine() {
  const node = document.getElementById('cd-account');
  if (!node || !platform) return;
  if (!platform.hosted) {
    node.textContent = 'Offline — progress saves on this device.';
    return;
  }
  const name = platform.profile ? platform.profile.name : '…';
  const syncTxt = platform.sync === 'synced' ? 'progress synced'
    : platform.sync === 'saving' ? 'saving…'
    : 'cloud sync unavailable';
  node.textContent = 'Playing as ' + name + ' · ' + syncTxt;
}
function showModeSelect() { showScreen('modesel'); }
function showLessons() { showScreen('lessons'); }
function showJourney() { showScreen('journey'); }
function showDailySetup() { showScreen('daily'); }
function showPracticeSelect() { showScreen('practice'); }
function showChallenges() { showScreen('challenge'); }

// ---------- start a round (all modes funnel here) ----------
function startRound(content, mode) {
  currentContent = content;
  currentMode = mode;
  game = R.createGame(C.toConfig(content, { mode: mode }));
  paused = false;
  terminalShown = false;
  prevStats = null;
  hintUntilMs = 0;
  sessionId = 's-' + nowMs().toString(36) + '-' + game.seed.toString(36);
  roundStartedAtMs = nowMs();
  simAcc = 0;
  applyTheme(content);
  renderer.setDecorSeed(game.seed);
  audio.setSeed(game.seed || 1);
  audio.play('go');
  const goal = game.config.goal;
  if (goal.type === 'reach-marker') renderer.setMarker(goal.x || 0, goal.y || 0, goal.radius || 40);
  else renderer.setMarker(null);
  renderer.setHint(null);
  const c = R.centroid(game, 'p0');
  if (c) renderer.snapCamera(c.x, c.y);
  updateHUD();
  showScreen('hud');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

function endSession() {
  game = null;
  paused = false;
  renderer.setMarker(null);
  renderer.setHint(null);
}

function pauseGame() {
  if (!game || game.phase !== 'active' || paused) return;
  paused = true;
  audio.play('ui');
  showScreen('pause');
}

function resumeGame() {
  if (!paused) return;
  paused = false;
  audio.play('ui');
  showScreen('hud');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

// ---------- input: pointer steering, keyboard, action buttons ----------
function inPlay() { return game && game.phase === 'active' && !paused; }

function steerToWorld(wx, wy) {
  if (!inPlay()) return;
  R.applyCommand(game, 'p0', { type: 'setTarget', x: wx, y: wy });
}

function doAction(type) {
  if (!inPlay()) return;
  const res = R.applyCommand(game, 'p0', { type: type, id: 'c' + (++cmdSeq) });
  if (!res.ok && res.reason !== 'duplicate') {
    // invalid-action explanation, visible and sonic
    ui.captions.textContent = 'Cannot ' + type + ': ' + res.reason.replace(/-/g, ' ');
    clearTimeout(ui._capT);
    ui._capT = setTimeout(() => { ui.captions.textContent = ''; }, 1600);
  }
}

function showHint() {
  if (!game || game.phase !== 'active') return;
  const h = R.hint(game, 'p0');
  audio.play('hint');
  ui.captions.textContent = h.text;
  clearTimeout(ui._capT);
  ui._capT = setTimeout(() => { ui.captions.textContent = ''; }, 2600);
  if (h.x != null) {
    renderer.setHint(h.x, h.y);
    hintUntilMs = nowMs() + 2600;
  }
}

const keysHeld = new Set();

function wireInput() {
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    const w = renderer.screenToWorld(e.clientX, e.clientY);
    steerToWorld(w.x, w.y);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!inPlay()) return;
    const w = renderer.screenToWorld(e.clientX, e.clientY);
    steerToWorld(w.x, w.y);
  });
  canvas.addEventListener('pointercancel', () => { /* capture lost: steering simply stops */ });

  window.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    const inControl = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
      if (paused) resumeGame();
      else if (game && game.phase === 'active' && ui.hud.style.display !== 'none') pauseGame();
      return;
    }
    if (inControl || !inPlay()) return;
    if (e.key === ' ') { e.preventDefault(); doAction('split'); return; }
    if (e.key === 'e' || e.key === 'E') { doAction('eject'); return; }
    if (e.key === 'h' || e.key === 'H') { showHint(); return; }
    const steerKeys = {
      ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1,
      w: 1, a: 1, s: 1, d: 1, W: 1, A: 1, S: 1, D: 1
    };
    if (steerKeys[e.key]) { e.preventDefault(); keysHeld.add(e.key.length === 1 ? e.key.toLowerCase() : e.key); }
  });
  window.addEventListener('keyup', (e) => keysHeld.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
  window.addEventListener('blur', () => keysHeld.clear());
}

// keyboard steering: held arrows nudge the target relative to the centroid
function applyKeySteering() {
  if (!keysHeld.size || !inPlay()) return;
  let dx = 0, dy = 0;
  if (keysHeld.has('ArrowUp') || keysHeld.has('w')) dy += 1;
  if (keysHeld.has('ArrowDown') || keysHeld.has('s')) dy -= 1;
  if (keysHeld.has('ArrowLeft') || keysHeld.has('a')) dx -= 1;
  if (keysHeld.has('ArrowRight') || keysHeld.has('d')) dx += 1;
  if (!dx && !dy) return;
  const c = R.centroid(game, 'p0');
  if (!c) return;
  const len = Math.sqrt(dx * dx + dy * dy);
  steerToWorld(c.x + dx / len * 260, c.y + dy / len * 260);
}

// ---------- main loop: fixed-step simulation + interpolated draw ----------
const TICK_MS = 1000 / R.TICK_RATE;
let simAcc = 0;
let lastFrameT = 0;

function frame(t) {
  requestAnimationFrame(frame);
  if (!lastFrameT) lastFrameT = t;
  let dt = (t - lastFrameT) / 1000;
  lastFrameT = t;
  if (dt > 0.25) dt = 0.25; // tab was hidden: don't fast-forward the sim

  if (game && game.phase === 'active' && !paused) {
    applyKeySteering();
    simAcc += dt * 1000;
    let steps = 0;
    while (simAcc >= TICK_MS && steps < 8 && game.phase === 'active') {
      R.step(game);
      renderer.syncState(game);
      afterTick();
      simAcc -= TICK_MS;
      steps++;
    }
    if (steps >= 8) simAcc = 0; // shed backlog instead of spiraling
  }

  if (hintUntilMs && nowMs() > hintUntilMs) { renderer.setHint(null); hintUntilMs = 0; }

  const alpha = game ? Math.min(1, simAcc / TICK_MS) : 0;
  renderer.draw(alpha, dt, computeFocus(), 'p0');
  updateHUD();

  if (game && game.phase === 'terminal' && !terminalShown) showResults();
}

function computeFocus() {
  if (!game) return null;
  const c = R.centroid(game, 'p0');
  if (!c) return null; // eliminated: keep the last camera position
  let big = 0;
  const cells = R.cellsOf(game, 'p0');
  for (const cell of cells) if (cell.mass > big) big = cell.mass;
  return { x: c.x, y: c.y, radius: R.radiusOf(Math.max(big, R.START_MASS)) };
}

// ---------- per-tick: event audio from stat diffs, adaptive intensity ----------
function afterTick() {
  const st = game.stats.p0;
  if (prevStats) {
    if (st.motes > prevStats.motes) audio.play('absorb');
    if (st.pellets > prevStats.pellets) audio.play('pellet');
    if (st.rivalCells > prevStats.rivalCells) { audio.play('absorbBig'); renderer.shake(2.5); }
    if (st.splits > prevStats.splits) audio.play('split');
    if (st.ejects > prevStats.ejects) audio.play('eject');
    if (st.barbBursts > prevStats.barbBursts) { audio.play('burst'); renderer.shake(4); }
    if ((st.merges || 0) > prevStats.merges) audio.play('merge');
  }
  prevStats = { motes: st.motes, pellets: st.pellets, rivalCells: st.rivalCells, splits: st.splits, ejects: st.ejects, barbBursts: st.barbBursts, merges: st.merges || 0 };

  // adaptive intensity + throttled danger ping
  if (game.tick % 15 === 0) {
    const h = R.hint(game, 'p0');
    const goal = game.config.goal;
    const massFrac = goal.mass ? Math.min(1, R.playerMass(game, 'p0') / goal.mass) : 0.3;
    audio.setIntensity(h.action === 'flee' ? 1 : 0.2 + massFrac * 0.5);
    if (h.action === 'flee' && nowMs() - lastDangerPingMs > 2200) {
      lastDangerPingMs = nowMs();
      audio.play('danger');
    }
  }
}

// ---------- HUD: objective / progress / action availability ----------
function fmtTime(ticks) {
  const s = Math.max(0, Math.ceil(ticks / R.TICK_RATE));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function objectiveText() {
  const g = game.config.goal;
  const brief = currentContent && currentContent.brief ? currentContent.brief + ' ' : '';
  if (g.type === 'reach-mass') return brief + 'Reach ' + g.mass + ' mass. Absorb motes, pellets and smaller cells to grow.';
  if (g.type === 'absorb-cells') return brief + 'Absorb ' + g.count + ' rival cells.';
  if (g.type === 'eject-count') return brief + 'Eject ' + g.count + ' pellets.';
  if (g.type === 'split-then-mass') return brief + 'Split at least ' + (g.splits || 1) + ' time(s), then reach ' + g.mass + ' mass.';
  if (g.type === 'reach-marker') return brief + 'Move to the glowing marker.';
  return brief + 'Survive and grow.';
}

let lastObjText = '', lastProgText = '';
function updateHUD() {
  if (!game || !ui.objective) return;
  const objText = objectiveText();
  if (objText !== lastObjText) { ui.objective.textContent = objText; lastObjText = objText; }

  const mass = Math.floor(R.playerMass(game, 'p0'));
  const rows = R.rankings(game);
  let rank = 1;
  for (const row of rows) if (row.playerId === 'p0') rank = row.rank;
  let prog = 'Mass ' + mass;
  const goal = game.config.goal;
  if (goal.type === 'reach-mass' || goal.type === 'split-then-mass') prog += ' / ' + goal.mass;
  if (game.config.durationTicks > 0) prog += ' · ' + fmtTime(game.config.durationTicks - game.tick);
  prog += ' · Rank ' + rank + '/' + game.players.length;
  if (game.phase === 'terminal') prog = 'Round over.';
  if (prog !== lastProgText) { ui.progress.textContent = prog; lastProgText = prog; }

  const legal = R.legalActions(game, 'p0');
  ui.splitBtn.disabled = !legal.split.ok;
  ui.ejectBtn.disabled = !legal.eject.ok;
}

// ---------- terminal: results, persistence, score submission ----------
function showResults() {
  terminalShown = true;
  const g = game;
  const bd = R.scoreBreakdown(g, 'p0');
  const durationMs = nowMs() - roundStartedAtMs;
  const reason = g.terminalReason;

  let headline = 'Round over';
  if (reason === 'goal-complete') headline = 'Goal complete!';
  else if (reason === 'last-cell') headline = 'Last cell drifting — you win!';
  else if (reason === 'time-up') headline = bd.objectiveMet ? 'Time up — goal held!' : 'Time up';
  else if (reason === 'eliminated') headline = 'You were absorbed';
  else if (reason === 'constraint-violated') headline = 'Constraint broken — no rival absorbs allowed';
  else if (reason === 'surrender') headline = 'Surrendered';

  if (reason === 'goal-complete' || reason === 'last-cell') audio.play('win');
  else if (reason === 'time-up') audio.play('timeup');
  else audio.play('lose');

  // persistence: progress buckets per mode + lifetime stats
  const doc = S.load();
  const won = reason === 'goal-complete' || reason === 'last-cell' || (reason === 'time-up' && bd.objectiveMet);
  const id = g.config.contentId;
  if (currentMode === 'learn' && won) doc.progress.lessonsDone[id] = true;
  if (currentMode === 'journey' && won) {
    const stars = 1 + (g.tick <= (currentContent.parTicks || Infinity) ? 1 : 0) + (g.players[0].invalidCount === 0 ? 1 : 0);
    doc.progress.journeyStars[id] = Math.max(doc.progress.journeyStars[id] || 0, stars);
    doc.progress.journeyBest[id] = Math.max(doc.progress.journeyBest[id] || 0, bd.total);
  }
  if (currentMode === 'practice' && won) {
    doc.progress.practiceDone = doc.progress.practiceDone || {};
    doc.progress.practiceDone[id] = true;
  }
  if (currentMode === 'challenge') {
    if (won) {
      doc.progress.challengeDone = doc.progress.challengeDone || {};
      doc.progress.challengeDone[id] = true;
    }
    doc.progress.challengeBest[id] = Math.max(doc.progress.challengeBest[id] || 0, bd.total);
  }
  if (currentMode === 'daily' && g.phase === 'terminal') {
    const day = currentContent.day || id;
    const prev = doc.progress.dailiesDone[day];
    doc.progress.dailiesDone[day] = Math.max(prev || 0, bd.total);
    const streak = doc.progress.dailyStreak;
    if (streak.last !== day) {
      const y = new Date(new Date(day + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
      streak.count = streak.last === y ? streak.count + 1 : 1;
      streak.last = day;
    }
  }
  const lt = doc.progress.stats;
  lt.rounds++;
  if (bd.objectiveMet) lt.goals++;
  if (g.winnerId === 'p0') lt.wins++;
  lt.massAbsorbed += Math.round(g.stats.p0.rivalMass);
  lt.cellsAbsorbed += g.stats.p0.rivalCells;
  lt.splits += g.stats.p0.splits;
  lt.playMs += durationMs;

  // Achievements (idempotent, local — part of the cloud-saved doc).
  const ACH_DEFS = [
    ['first-round', () => lt.rounds >= 1, 'First drift'],
    ['first-goal', () => lt.goals >= 1, 'Objective met'],
    ['first-win', () => lt.wins >= 1, 'Arena champion'],
    ['rounds-25', () => lt.rounds >= 25, 'Persistent cell'],
    ['cells-250', () => lt.cellsAbsorbed >= 250, 'Absorber'],
    ['splits-100', () => lt.splits >= 100, 'Divider']
  ];
  const earned = [];
  for (const [key, test, label] of ACH_DEFS) {
    if (!doc.progress.achievements[key] && test()) {
      doc.progress.achievements[key] = Date.now();
      earned.push(label);
    }
  }
  S.save(doc);
  if (earned.length) audio.play('achievement');

  // leaderboard (local + host when available)
  const entry = {
    contentId: id, score: bd.total, objective: !!bd.objectiveMet,
    invalid: g.players[0].invalidCount, durationMs: Math.round(durationMs), sessionId: sessionId
  };
  const boards = S.loadBoards();
  boards.entries.push(entry);
  S.saveBoards(boards);
  if (platform) platform.submitScore(entry);

  // build the results panel
  const r = ui.result;
  while (r.firstChild) r.removeChild(r.firstChild);
  r.appendChild(el('img', { class: 'cd-resultart', src: './assets/results-vignette.webp', alt: '', 'aria-hidden': 'true', width: '768', height: '432' }));
  r.appendChild(el('h2', {}, [headline]));
  const list = el('dl', { class: 'cd-breakdown' });
  const labels = { motes: 'Motes absorbed', pellets: 'Pellets absorbed', rivalMass: 'Rival mass', survival: 'Survival', peakMass: 'Peak mass', rankBonus: 'Rank bonus', objectiveBonus: 'Objective bonus' };
  for (const k in labels) {
    list.appendChild(el('dt', {}, [labels[k]]));
    list.appendChild(el('dd', {}, [String(bd.parts[k] || 0)]));
  }
  r.appendChild(list);
  r.appendChild(el('p', { class: 'cd-total' }, ['Total score: ' + bd.total + ' · Rank ' + bd.rank + '/' + g.players.length + (bd.objectiveMet ? ' · objective met' : '')]));
  if (earned.length) {
    r.appendChild(el('p', { class: 'cd-sub' }, ['🏅 Achievement unlocked: ' + earned.join(', ')]));
  }
  const retry = el('button', { class: 'cd-btn cd-itembtn' }, ['Retry']);
  retry.addEventListener('click', () => { audio.play('ui'); startRound(currentContent, currentMode); });
  r.appendChild(retry);
  const back = el('button', { class: 'cd-btn cd-itembtn' }, ['Back to modes']);
  back.addEventListener('click', () => { audio.play('ui'); endSession(); showModeSelect(); });
  r.appendChild(back);
  showScreen('result');
}

// ---------- public entry point used by index.html module script ----------
// debug(): read-only snapshot for QA automation (tests/e2e.mjs); never mutates state.
function debug() {
  if (!game) return { phase: null };
  const c = R.centroid(game, 'p0');
  const goal = game.config.goal;
  const st = settings();
  const theme = C.themeById((currentContent && currentContent.theme) || st.theme || 'lagoon');
  return {
    phase: game.phase, tick: game.tick, paused, mode: currentMode,
    playerColor: st.cvdPalette ? C.CVD_THEME_PATCH.player : theme.player,
    mass: R.playerMass(game, 'p0'),
    centroid: c ? { x: c.x, y: c.y } : null,
    screen: c ? renderer.worldToScreen(c.x, c.y) : null,
    goal: goal.type === 'reach-marker' ? { type: goal.type, x: goal.x || 0, y: goal.y || 0, radius: goal.radius || 40, screen: renderer.worldToScreen(goal.x || 0, goal.y || 0) } : { type: goal.type },
    terminalReason: game.terminalReason
  };
}
window.CDApp = { boot, debug };

boot();
