// Cellular Drift on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content and save model are the
// browser build's unchanged js/rules.js, js/content.js and js/store.js; this
// module is what js/app.js did around them — the screen flow (title ⇄ help;
// title → modes → lessons | journey | daily | practice | challenges → play
// ⇄ pause → results), every mode funnelled through startRound, steering by
// pointer, touch, keys and stick, Split / Eject / Hint, the event audio and
// shake from per-tick stat diffs, the adaptive music and danger ping, the
// results with progression, achievements, the device board and score
// posting, and the lifecycle — with the screens and HUD drawn by screens.ts
// (starhermit:ui) and the dish by render.ts (starhermit:scene).
//
// The simulation clock is the runtime's fixed steps at the rules' 30 Hz
// TICK_RATE: a tick every step, only while the round is active and not
// paused, so a hidden window and a slow frame never move the round, and
// play scripts replay exactly.
import { frame, onFixedUpdate, onPreferencesChange, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerMove, value } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded } from "starhermit:platform";
import { Content as C, Rules as R, type Breakdown, type Content, type State } from "./classic.ts";
import * as audio from "./audio.ts";
import { N, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens, hudBlocks, loadArt } from "./screens.ts";
import { applyPalette, initStyles } from "./style.ts";

export type ScreenName = "title" | "help" | "modes" | "lessons" | "journey" | "daily" | "practice" | "challenge" | "hud" | "pause" | "result";
export type Mode = "learn" | "journey" | "daily" | "practice" | "challenge";
export interface ResultsView {
  headline: string; bd: Breakdown; players: number; earned: string[];
  lb: { pending: boolean; posted: boolean; rank: number | null } | null;
}

export const app = {
  screen: "title" as ScreenName,
  /** Frame the screen opened on (the action that opened it must not also close it). */
  openedFrame: 0,
  focusNext: true,
  results: null as ResultsView | null,
  /** The caption strip: hints, refused actions, and (with Captions on) sound cues. */
  caption: null as { text: string; until: number } | null,
  toast: null as { text: () => string; until: number } | null,
};
export let game: State | null = null;
export let paused = false;
export let currentContent: Content | null = null;
export let currentMode: Mode = "learn";
export const settings = platform.settings;
const now = (): number => frame().time;

let terminalShown = false;
let sessionId = "";
let roundStartedAt = 0;
let cmdSeq = 0;
let hintUntil = 0;
let lastDangerTick = -1e9;
let prevStats: { motes: number; pellets: number; rivalCells: number; splits: number; ejects: number; barbBursts: number; merges: number } | null = null;

/** A toast; `text` re-runs each frame so a visible toast follows a language change. */
export function toast(text: () => string, seconds = 3.5): void {
  app.toast = { text, until: now() + seconds };
  ui.announce(text());
}
function caption(text: string, seconds: number): void {
  app.caption = { text, until: now() + seconds };
  ui.announce(text);
}
audio.setOnCaption((key) => { if (settings.captions) caption(T(key), 1.6); });

// ------------------------------------------------------------------ screens
export function showScreen(name: ScreenName): void {
  app.screen = name;
  app.openedFrame = frame().frame;
  // keyboard users land on the first control of the newly shown screen; the
  // HUD is the exception: focus there would take Space from Split
  app.focusNext = name !== "hud";
  if (name === "hud") ui.setFocus(null);
}
export function showTitle(): void { showScreen("title"); }
export function showModeSelect(): void { showScreen("modes"); }

/** The daily of the platform's day (the device's UTC date while offline). */
export function today(): Content { return C.dailyFor(platform.now()); }

// ------------------------------------------------------------------ the round
/** Every mode starts here. */
export function startRound(content: Content, mode: Mode): void {
  currentContent = content;
  currentMode = mode;
  game = R.createGame(C.toConfig(content, { mode }));
  paused = false;
  terminalShown = false;
  prevStats = null;
  hintUntil = 0;
  lastDangerTick = -1e9;
  app.caption = null;
  sessionId = "s-" + Date.now().toString(36) + "-" + game.seed.toString(36);
  roundStartedAt = now();
  applyTheme();
  render.setDecorSeed(game.seed);
  audio.setSeed(game.seed || 1);
  audio.play("go");
  const goal = game.config.goal;
  if (goal.type === "reach-marker") render.setMarker(goal.x || 0, goal.y || 0, goal.radius || 40);
  else render.setMarker(null);
  render.setHint(null);
  render.syncState(game);
  const c = R.centroid(game, "p0");
  if (c) render.snapCamera(c.x, c.y);
  showScreen("hud");
}
export function retry(): void {
  if (currentContent) startRound(currentContent, currentMode);
}
export function endSession(): void {
  game = null;
  paused = false;
  render.setMarker(null);
  render.setHint(null);
}
export function leaveRound(): void { endSession(); showModeSelect(); }

export function pauseGame(): void {
  if (!game || game.phase !== "active" || paused) return;
  paused = true;
  audio.play("ui");
  showScreen("pause");
}
export function resumeGame(): void {
  if (!paused) return;
  paused = false;
  audio.play("ui");
  showScreen("hud");
}

export function inPlay(): boolean { return !!game && game.phase === "active" && !paused && app.screen === "hud"; }

/** Plain-language reasons for refused actions (rules.js reason ids). */
const REASONS: Record<string, string> = {
  "round-over": N("the round is over"), eliminated: N("you were absorbed"), "split-disabled": N("splitting is off in this round"),
  "cells-too-small-or-cooling": N("your cells are too small or still cooling down"), "no-cells": N("you have no cells"),
  "cell-limit": N("you already have the most cells allowed"), "eject-disabled": N("ejecting is off in this round"),
  cooling: N("still cooling down"), "cells-too-small": N("your cells are too small"), "unknown-command": N("that action is not available"),
};
export function doAction(type: "split" | "eject"): void {
  if (!inPlay() || !game) return;
  const res = R.applyCommand(game, "p0", { type, id: "c" + ++cmdSeq });
  if (!res.ok && res.reason !== "duplicate") {
    const reason = res.reason ?? "unknown-command";
    // invalid-action explanation, always shown
    caption(T(type === "split" ? N("Cannot split: {reason}") : N("Cannot eject: {reason}"), { reason: T(REASONS[reason] ?? reason.replace(/-/g, " ")) }), 1.6);
  }
}
export function showHint(): void {
  if (!game || game.phase !== "active" || paused) return;
  const h = R.hint(game, "p0");
  audio.play("hint");
  caption(T(h.text), 2.6);
  if (h.x != null) {
    render.setHint(h.x, h.y ?? 0);
    hintUntil = now() + 2.6;
  }
}

function steerToWorld(x: number, y: number): void {
  if (!inPlay() || !game) return;
  R.applyCommand(game, "p0", { type: "setTarget", x, y });
}
/** Keys and the stick: the target 260 units from the centroid in the held direction. */
function applyStickSteering(): void {
  if (!game) return;
  const dx = value("right") - value("left");
  const dy = value("up") - value("down");
  const len = Math.hypot(dx, dy);
  if (len < 0.2) return;
  const c = R.centroid(game, "p0");
  if (!c) return;
  const k = Math.min(1, len) / len;
  steerToWorld(c.x + dx * k * 260, c.y + dy * k * 260);
}

/** The camera's focus: the player's centroid, zoomed by its largest cell; a marker goal frames the marker too. */
function computeFocus(): render.Focus | null {
  if (!game) return null;
  const c = R.centroid(game, "p0");
  if (!c) return null; // absorbed: keep the last camera position
  let big = 0;
  for (const cell of R.cellsOf(game, "p0")) if (cell.mass > big) big = cell.mass;
  const focus: render.Focus = { x: c.x, y: c.y, radius: R.radiusOf(Math.max(big, R.START_MASS)) };
  const g = game.config.goal;
  if (g && g.type === "reach-marker" && game.phase === "active") focus.include = { x: g.x || 0, y: g.y || 0, radius: (g.radius || 40) * 1.15 };
  return focus;
}

/** Per tick: event audio and shake from the player's stat diffs, the music's intensity and the danger ping. */
function afterTick(): void {
  if (!game) return;
  const st = game.stats.p0!;
  if (prevStats) {
    if (st.motes > prevStats.motes) audio.play("absorb");
    if (st.pellets > prevStats.pellets) audio.play("pellet");
    if (st.rivalCells > prevStats.rivalCells) { audio.play("absorbBig"); render.shake(2.5); }
    if (st.splits > prevStats.splits) audio.play("split");
    if (st.ejects > prevStats.ejects) audio.play("eject");
    if (st.barbBursts > prevStats.barbBursts) { audio.play("burst"); render.shake(4); }
    if ((st.merges || 0) > prevStats.merges) audio.play("merge");
  }
  prevStats = { motes: st.motes, pellets: st.pellets, rivalCells: st.rivalCells, splits: st.splits, ejects: st.ejects, barbBursts: st.barbBursts, merges: st.merges || 0 };
  if (game.tick % 15 === 0) {
    const h = R.hint(game, "p0");
    const goal = game.config.goal;
    const massFrac = goal.mass ? Math.min(1, R.playerMass(game, "p0") / goal.mass) : 0.3;
    audio.setIntensity(h.action === "flee" ? 1 : 0.2 + massFrac * 0.5);
    if (h.action === "flee" && game.tick - lastDangerTick > 2.2 * R.TICK_RATE) {
      lastDangerTick = game.tick;
      audio.play("danger");
    }
  }
}

// ------------------------------------------------------------------ results
function showResults(): void {
  if (!game || !currentContent) return;
  terminalShown = true;
  const g = game;
  const bd = R.scoreBreakdown(g, "p0");
  const durationMs = Math.round((now() - roundStartedAt) * 1000);
  const reason = g.terminalReason;
  let headline = N("Round over");
  if (reason === "goal-complete") headline = N("Goal complete!");
  else if (reason === "last-cell") headline = N("Last cell drifting — you win!");
  else if (reason === "time-up") headline = bd.objectiveMet ? N("Time up — goal held!") : N("Time up");
  else if (reason === "eliminated") headline = N("You were absorbed");
  else if (reason === "constraint-violated") headline = N("Constraint broken — no rival absorbs allowed");
  else if (reason === "surrender") headline = N("Surrendered");
  if (reason === "goal-complete" || reason === "last-cell") audio.play("win");
  else if (reason === "time-up") audio.play("timeup");
  else audio.play("lose");

  // progress per mode, lifetime stats
  const prog = platform.progress;
  const won = reason === "goal-complete" || reason === "last-cell" || (reason === "time-up" && bd.objectiveMet);
  const id = g.config.contentId;
  if (currentMode === "learn" && won) prog.lessonsDone[id] = true;
  if (currentMode === "journey" && won) {
    const stars = 1 + (g.tick <= (currentContent.parTicks || Infinity) ? 1 : 0) + (g.players[0]!.invalidCount === 0 ? 1 : 0);
    prog.journeyStars[id] = Math.max(prog.journeyStars[id] || 0, stars);
    prog.journeyBest[id] = Math.max(prog.journeyBest[id] || 0, bd.total);
  }
  if (currentMode === "practice" && won) prog.practiceDone[id] = true;
  if (currentMode === "challenge") {
    if (won) prog.challengeDone[id] = true;
    prog.challengeBest[id] = Math.max(prog.challengeBest[id] || 0, bd.total);
  }
  if (currentMode === "daily") {
    const day = currentContent.day || id;
    prog.dailiesDone[day] = Math.max(prog.dailiesDone[day] || 0, bd.total);
    const streak = prog.dailyStreak;
    if (streak.last !== day) {
      const y = new Date(new Date(day + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
      streak.count = streak.last === y ? streak.count + 1 : 1;
      streak.last = day;
    }
  }
  const lt = prog.stats;
  lt.rounds++;
  if (bd.objectiveMet) lt.goals++;
  if (g.winnerId === "p0") lt.wins++;
  lt.massAbsorbed += Math.round(g.stats.p0!.rivalMass);
  lt.cellsAbsorbed += g.stats.p0!.rivalCells;
  lt.splits += g.stats.p0!.splits;
  lt.playMs += durationMs;

  // achievements (idempotent, local — part of the cloud-saved progress)
  const defs: [string, () => boolean, string][] = [
    ["first-round", () => lt.rounds >= 1, N("First drift")],
    ["first-goal", () => lt.goals >= 1, N("Objective met")],
    ["first-win", () => lt.wins >= 1, N("Arena champion")],
    ["rounds-25", () => lt.rounds >= 25, N("Persistent cell")],
    ["cells-250", () => lt.cellsAbsorbed >= 250, N("Absorber")],
    ["splits-100", () => lt.splits >= 100, N("Divider")],
  ];
  const earned: string[] = [];
  for (const [key, test, label] of defs) {
    if (!prog.achievements[key] && test()) { prog.achievements[key] = Date.now(); earned.push(label); }
  }
  platform.persist();
  if (earned.length) audio.play("achievement");

  // the device's board, and the platform's when signed in (every round outside Learn)
  platform.addBoardEntry({ contentId: id, score: bd.total, objective: !!bd.objectiveMet, invalid: g.players[0]!.invalidCount, durationMs, sessionId });
  const view: ResultsView = { headline, bd, players: g.players.length, earned, lb: null };
  if (platform.signedIn() && currentMode !== "learn") {
    view.lb = { pending: true, posted: false, rank: null };
    void platform.postLeaderboard(bd.total).then((r) => { view.lb = { pending: false, posted: r.posted, rank: r.rank }; });
  }
  app.results = view;
  showScreen("result");
}

// ------------------------------------------------------------------ input
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const fresh = frame().frame !== app.openedFrame;
  switch (e.action) {
    case "pause":
      if (!fresh) break;
      if (paused && app.screen === "pause") resumeGame();
      else if (game && game.phase === "active" && app.screen === "hud") pauseGame();
      else back();
      break;
    case "split": if (inPlay()) { ui.setFocus(null); doAction("split"); } break;
    case "eject": if (inPlay()) { ui.setFocus(null); doAction("eject"); } break;
    case "hint": if (inPlay()) { ui.setFocus(null); showHint(); } break;
    case "up": case "down": case "left": case "right": if (inPlay()) ui.setFocus(null); break;
    default: break;
  }
});
/** Escape on a menu: one screen back (the title stays). */
function back(): void {
  switch (app.screen) {
    case "help": case "modes": showTitle(); break;
    case "lessons": case "journey": case "daily": case "practice": case "challenge": showModeSelect(); break;
    case "result": audio.play("ui"); endSession(); showModeSelect(); break;
    default: break;
  }
}
// The pointer steers over the dish (not over the HUD's buttons): every move
// sets the target to the world point under it, as the browser build's
// pointermove did; a touch moves the pointer the same way.
onPointerMove((x, y) => {
  if (!inPlay()) return;
  for (const r of hudBlocks) if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return;
  const w = render.screenToWorld(x, y);
  steerToWorld(w.x, w.y);
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
let themeKey = "";
function applyTheme(): void {
  const th = C.themeById((currentContent && currentContent.theme) || settings.theme || "lagoon");
  const key = `${th.id}:${settings.cvdPalette}`;
  if (key === themeKey) return;
  themeKey = key;
  render.setTheme(th, settings.cvdPalette ? C.CVD_THEME_PATCH : null);
}
function applySettings(): void {
  const p = preferences();
  applyPalette(p.highContrast);
  render.setReducedMotion(p.reducedMotion);
  render.setHighContrast(p.highContrast);
  applyTheme();
}

onStart(() => {
  setFixedRate(R.TICK_RATE);
  initStyles();
  platform.initPlatform();
  applySettings();
  applyLook();
  audio.start();
  loadArt();
  showTitle();
});
onPreferencesChange(() => applySettings());
platform.onSettingsChange(() => applySettings());
onSessionEnded(() => { toast(() => T("Signed out of StarHermit — progress keeps saving on this device.")); });
onSuspend(() => {
  // backgrounding pauses the round and silences the pad
  pauseGame();
  audio.suspend();
  platform.flush();
});
onResume(() => audio.resume());
onQuit(() => platform.flush());

onFixedUpdate(() => {
  if (!inPlay() || !game) return;
  applyStickSteering();
  R.step(game);
  render.syncState(game);
  afterTick();
  if (game.phase === "terminal" && !terminalShown) showResults();
});
let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const t = now();
  if (hintUntil && t > hintUntil) { render.setHint(null); hintUntil = 0; }
  if (app.toast && t > app.toast.until) app.toast = null;
  if (app.caption && t > app.caption.until) app.caption = null;
  if (app.screen === "hud" && ui.focused()) ui.setFocus(null);
});
onRender((alpha) => {
  const f = frame();
  drawScreens();
  render.draw(game && !paused ? alpha : 1, frameDt, computeFocus(), f.width, f.height);
});
