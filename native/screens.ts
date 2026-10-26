// The browser build's DOM shell (js/app.js buildUI + css/style.css) as
// starhermit:ui, built every frame: the play HUD (objective and progress at
// the top-left, Pause at the top-right, the Split / Eject / Hint tray at the
// bottom-right, the caption strip above it), the toast, and the screens over
// a dark scrim (the title over its key art, Help, the mode select, the
// lesson / Journey / practice / challenge lists with their done marks and
// stars, the daily setup, pause with the game's own options, results with
// the vignette art and the score breakdown). Screens centre their column
// when it fits and scroll it (the Back / Retry buttons pinned below) when
// it does not, as the browser build's auto margins did.
import { clipboard, frame, openMenu } from "starhermit:engine";
import { bindings } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { createImageBitmap, OffscreenCanvas } from "starhermit:canvas";
import { requestSignIn } from "starhermit:platform";
import { Content as C, Rules as R, type Content } from "./classic.ts";
import * as audio from "./audio.ts";
import { N, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import {
  app, currentContent, doAction, endSession, game, leaveRound, pauseGame, resumeGame, retry, settings, showHint,
  showModeSelect, showScreen, showTitle, startRound, toast, today, type Mode, type ScreenName,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; narrow: boolean; short: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, ox: sa.left / sc, oy: sa.top / sc, narrow: lw <= 600, short: lh <= 520 };
}
const lastHeight = new Map<string, number>();

function textWidth(text: string, style: string | readonly string[], kind?: "button"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls?: string | readonly string[] | null, id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = cls ? (typeof cls === "string" ? [cls] : [...cls]) : [];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, width);
}

interface Btn { id: string; text: string; sub?: string; done?: string; style?: string[]; disabled?: boolean; quiet?: boolean; act: () => void }
/** A button `width` wide (its label, a smaller second line and a done mark wrap inside). */
function button(b: Btn, width: number): void {
  const style = b.style ?? ["btn", "btn-item"];
  const inner = width - 46;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const plainFits = !b.sub && !b.done && textWidth(b.text, style, "button") + 4 <= width;
  if (!plainFits) {
    opts.content = () => {
      ui.column(`${b.id}-face`, () => {
        para(b.text, inner, "btn-title", undefined, true);
        if (b.sub) para(b.sub, inner, "btn-sub", undefined, true);
        if (b.done) para(b.done, inner, "btn-done", undefined, true);
      }, { align: "center", spacing: 2 });
    };
  }
  if (ui.style(...style, { width }).id(b.id).button(b.text, opts)) { if (!b.quiet) audio.play("ui"); b.act(); }
}
function stack(key: string, list: Btn[], width: number): void {
  ui.column(key, () => { for (const b of list) button(b, width); }, { spacing: 12, width, align: "center" });
}

// ------------------------------------------------------------------ art
// The results vignette (assets/results-vignette.webp) decoded into a canvas;
// a soft fill stands in until it has, and high contrast drops it.
let vignette: OffscreenCanvas | null = null;
export function loadArt(): void {
  createImageBitmap("assets/results-vignette.webp").then((bmp) => {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    // the panel's 14 px corners at the 300 px it shows
    g.beginPath();
    g.roundRect(0, 0, bmp.width, bmp.height, (14 * bmp.width) / 300);
    g.clip();
    g.drawImage(bmp, 0, 0);
    bmp.close();
    vignette = c;
  }, () => undefined);
}
function vignetteWidget(width: number, height: number): void {
  ui.widget("", {
    role: "none", size: { width, height },
    draw: (r) => {
      const rad = 14 * ui.preferences().scale;
      if (!vignette) { draw.roundRect(r.x, r.y, r.width, r.height, rad, "#0b2a33"); return; }
      // object-fit: cover
      const k = Math.max(r.width / vignette.width, r.height / vignette.height);
      const sw = r.width / k, sh = r.height / k;
      draw.image(vignette, r.x, r.y, r.width, r.height, {
        source: { x: (vignette.width - sw) / 2, y: (vignette.height - sh) / 2, width: sw, height: sh },
      });
    },
  });
}
/** The medal (the browser build's 🏅, which the runtime's fonts lack): a ribbon over a gold star. */
function medal(size: number): void {
  ui.widget("", {
    role: "none", size: { width: size, height: size },
    draw: (r) => {
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2, s = Math.min(r.width, r.height) / 2;
      draw.polygon([[cx - s * 0.55, cy - s], [cx - s * 0.1, cy - s], [cx + s * 0.1, cy - s * 0.2], [cx - s * 0.3, cy - s * 0.2]], "#ff6b81");
      draw.polygon([[cx + s * 0.55, cy - s], [cx + s * 0.1, cy - s], [cx - s * 0.1, cy - s * 0.2], [cx + s * 0.3, cy - s * 0.2]], "#4fd8c2");
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? s * 0.68 * 0.45 : s * 0.68;
        pts.push([cx + Math.cos(a) * rr, cy + s * 0.3 + Math.sin(a) * rr]);
      }
      draw.polygon(pts, "#ffd166");
    },
  });
}

// ------------------------------------------------------------------ the frame
/** The HUD's button blocks this frame (window pixels): the pointer over them does not steer. */
export const hudBlocks: ui.Rect[] = [];

function firstId(name: ScreenName): string | null {
  switch (name) {
    case "title": return "btn-play";
    case "help": return "btn-help-close";
    case "modes": return "mode-learn";
    case "lessons": return `item-${C.LESSONS[0]!.id}`;
    case "journey": return "item-j01";
    case "daily": return "btn-daily-begin";
    case "practice": return `item-${C.PRACTICE[0]!.id}`;
    case "challenge": return `item-${C.CHALLENGES[0]!.id}`;
    case "pause": return "btn-resume";
    case "result": return "btn-retry";
    default: return null;
  }
}

export function drawScreens(): void {
  const L = layoutNow();
  if (app.focusNext && frame().frame - app.openedFrame >= 2) {
    const first = firstId(app.screen);
    if (first) ui.setFocus(first);
    app.focusNext = false;
  }
  hudBlocks.length = 0;
  if (game && (app.screen === "hud" || app.screen === "pause")) hud(L);
  switch (app.screen) {
    case "title": titleScreen(L); break;
    case "help": helpScreen(L); break;
    case "modes": modesScreen(L); break;
    case "lessons": listScreen(L, "lessons", N("Lessons"), C.LESSONS, "learn"); break;
    case "journey": listScreen(L, "journey", N("Journey"), JOURNEY, "journey"); break;
    case "daily": dailyScreen(L); break;
    case "practice": listScreen(L, "practice", N("Practice"), C.PRACTICE, "practice"); break;
    case "challenge": listScreen(L, "challenge", N("Challenges"), C.CHALLENGES, "challenge"); break;
    case "pause": pauseScreen(L); break;
    case "result": resultScreen(L); break;
    default: break;
  }
  if (app.caption && (app.screen === "hud" || app.screen === "result")) {
    const w = Math.min(L.lw * 0.92, 36 * 16);
    const y = app.screen === "hud" ? (L.short ? 64 : 72) : 6;
    ui.place("captions", { anchor: "bottom", y }, () => {
      para(app.caption!.text, w - 24, "captions-text", "caption-text", true);
    }, { style: "captions" });
  }
  if (app.toast) {
    const text = app.toast.text();
    // over the results / pause screens the bottom holds their buttons: the toast shows at the top
    const top = app.screen === "result" || app.screen === "pause";
    const w = Math.min(L.lw - 32, 34 * 16);
    ui.place("toast", top ? { anchor: "top", y: 12 } : { anchor: "bottom", y: 24 }, () => {
      ui.column("toast-box", () => { para(text, w - 40, "toast-text", "toast-text", true); }, { style: "toast", align: "center" });
    });
  }
}
const JOURNEY = C.journeyStages();

// ------------------------------------------------------------------ HUD
function fmtTime(ticks: number): string {
  const s = Math.max(0, Math.ceil(ticks / R.TICK_RATE));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function objectiveText(): string {
  const g = game!.config.goal;
  const brief = currentContent && currentContent.brief ? T(currentContent.brief) + " " : "";
  if (g.type === "reach-mass") return brief + T("Reach {mass} mass. Absorb motes, pellets and smaller cells to grow.", { mass: g.mass ?? 0 });
  if (g.type === "absorb-cells") return brief + T("Absorb {n} rival cells.", { n: g.count ?? 0 });
  if (g.type === "eject-count") return brief + T("Eject {n} pellets.", { n: g.count ?? 0 });
  if (g.type === "split-then-mass") return brief + T("Split at least {n} time(s), then reach {mass} mass.", { n: g.splits || 1, mass: g.mass ?? 0 });
  if (g.type === "reach-marker") return brief + T("Move to the glowing marker.");
  return brief + T("Survive and grow.");
}
function progressText(): string {
  const s = game!;
  if (s.phase === "terminal") return T("Round over.");
  const mass = Math.floor(R.playerMass(s, "p0"));
  let rank = 1;
  for (const row of R.rankings(s)) if (row.playerId === "p0") rank = row.rank;
  let prog = T("Mass {n}", { n: mass });
  const goal = s.config.goal;
  if (goal.type === "reach-mass" || goal.type === "split-then-mass") prog += " / " + goal.mass;
  if (s.config.durationTicks > 0) prog += " · " + fmtTime(s.config.durationTicks - s.tick);
  prog += " · " + T("Rank {rank}/{total}", { rank, total: s.players.length });
  return prog;
}
function hud(L: Layout): void {
  const s = game!;
  const pad = L.short ? 10 : 16;
  const play = app.screen === "hud";
  const legal = R.legalActions(s, "p0");
  // objective and progress, top-left (70ch at most); Pause below them on the right
  const infoW = Math.max(120, Math.min(70 * 8, L.lw - pad * 2));
  const info = ui.place("hud-info", { anchor: "top-start", x: pad, y: pad }, () => {
    para(objectiveText(), infoW, "hud-objective", "hud-objective");
    para(progressText(), infoW, "hud-progress", "hud-progress");
  }, { spacing: 4 });
  if (play) {
    const r = ui.place("hud-pause", { anchor: "top-end", x: pad, y: pad + info.height / L.sc + 12 }, () => {
      if (ui.style("btn", "btn-act").id("btn-pause").button(T("Pause"))) pauseGame();
    });
    hudBlocks.push(r);
  }
  if (!play) return;
  // the thumb-zone tray, bottom-right
  const r = ui.place("hud-actions", { anchor: "bottom-end", x: pad, y: pad }, () => {
    ui.row("hud-tray", () => {
      if (ui.style("btn", "btn-act").id("btn-split").button(T("Split"), { disabled: !legal.split.ok })) doAction("split");
      if (ui.style("btn", "btn-act").id("btn-eject").button(T("Eject"), { disabled: !legal.eject.ok })) doAction("eject");
      if (ui.style("btn", "btn-act").id("btn-hint").button(T("Hint"))) showHint();
    }, { spacing: 8, align: "center" });
  });
  hudBlocks.push(r);
}

// ------------------------------------------------------------------ screens
interface ScreenOpts { title?: boolean }
/** A screen: the scrim over the dish with its column centred; a column taller
 * than the room scrolls while the footer's buttons stay below it. */
function screen(key: string, L: Layout, maxW: number, body: (w: number) => void, footer: ((w: number) => void) | null, opts: ScreenOpts = {}): void {
  const width = Math.max(200, Math.min(maxW, L.lw - 32));
  const padY = L.short ? 12 : 24;
  const fH = footer ? (lastHeight.get(`${key}:f`) ?? 56) + 12 : 0;
  const bodyMax = Math.max(64, L.lh - padY * 2 - fH);
  const bh = lastHeight.get(`${key}:b`) ?? 0;
  const scrolls = bh > bodyMax + 1;
  const bg = opts.title ? (ui.preferences().highContrast ? "screen-plain" : "screen-title") : "screen";
  ui.place(`scr-${key}`, { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.column(`scr-${key}-box`, () => {
      const inside = (w: number): void => {
        const r = ui.column(`${key}-body`, () => body(w), { width: w, spacing: L.short ? 8 : 12, align: "center" });
        lastHeight.set(`${key}:b`, r.height / L.sc);
      };
      if (scrolls) ui.scrollArea(`${key}-scroll`, { width: width + 16, height: bodyMax }, () => inside(width));
      else inside(width);
      if (footer) {
        const r = ui.column(`${key}-foot`, () => footer(width), { width, align: "center", spacing: 8 });
        lastHeight.set(`${key}:f`, r.height / L.sc);
      }
    }, { width: L.lw, height: L.lh, align: "center", justify: "center", spacing: 12, padding: { top: padY, bottom: padY } });
  }, { style: bg, width: L.lw + L.ox * 2, height: L.lh + L.oy * 2 });
}
const ITEM_W = 420;
const itemW = (w: number): number => Math.min(ITEM_W, w);
function h2(text: string, id: string): void { ui.style("h2").id(id).heading(text); }

function titleScreen(L: Layout): void {
  screen("title", L, 560, (w) => {
    ui.style("game-title", L.narrow || L.short ? "game-title-compact" : null).id("game-title").label("Cellular Drift");
    para(T("A realtime mass arena. Move, absorb, split, eject — and manage the threats that hunt you."), Math.min(w, 36 * 16), "tagline", "tagline", true);
    para(accountLine(), w, "sub", "account-line", true);
    const list: Btn[] = [
      { id: "btn-play", text: T("Play"), act: showModeSelect },
      { id: "btn-help", text: T("Help & rules"), act: () => showScreen("help") },
      { id: "btn-options", text: T("Options"), act: () => openMenu() },
    ];
    const link = platform.inviteLink();
    if (link) {
      list.push({
        id: "btn-invite", text: T("Invite a friend"),
        act: () => {
          try { clipboard.writeText(link); toast(() => T("Invite link copied — send it to a friend.")); }
          catch { toast(() => T("Could not copy the invite link."), 6); }
        },
      });
    }
    if (!platform.signedIn()) list.push({ id: "btn-sign-in", text: T("Sign in with StarHermit"), act: () => { void requestSignIn().catch(() => undefined); } });
    stack("title-actions", list, itemW(w));
  }, null, { title: true });
}
/** The account and cloud-sync line: offline keeps the local-only wording; signed in shows the nickname. */
function accountLine(): string {
  const name = platform.displayName();
  if (!name) return T("Offline — progress saves on this device.");
  const sync = platform.syncState();
  const syncTxt = sync === "synced" ? T("progress synced") : sync === "saving" ? T("saving…") : T("cloud sync unavailable");
  return T("Playing as {name}", { name }) + " · " + syncTxt;
}

/** An action's keys as Help shows them (↑ / W), from the player's bindings; a
 * pad's controls by their usual names (A, B, X, Y, the stick, the D-pad). */
const KEY_NAMES: Record<string, string> = { Space: "Space", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc" };
const PAD_NAMES: Record<string, string> = {
  South: "A", East: "B", West: "X", North: "Y", Start: "Start", Select: "Select",
  LeftShoulder: "LB", RightShoulder: "RB", LeftTrigger: "LT", RightTrigger: "RT", LeftStickPress: "LS", RightStickPress: "RS",
};
function padName(code: string): string {
  if (code.startsWith("LeftStick") && code !== "LeftStickPress") return "L-stick";
  if (code.startsWith("RightStick") && code !== "RightStickPress") return "R-stick";
  if (code.startsWith("Dpad")) return "D-pad";
  return PAD_NAMES[code] ?? code;
}
function keys(action: string, device: "keyboard" | "gamepad" = "keyboard"): string {
  const list = bindings(action).filter((b) => b.device === device).map((b) => (device === "keyboard" ? KEY_NAMES[b.code] ?? b.label : padName(b.code)));
  return [...new Set(list)].join(" / ") || "—";
}
function helpScreen(L: Layout): void {
  screen("help", L, 640, (w) => {
    h2(T("Help & rules"), "help-heading");
    const tw = Math.min(w, 60 * 8);
    ui.column("help-text", () => {
      para(T("Steer your cell with the pointer (or {keys}). Absorb nutrient motes, pellets, and cells at least 15% smaller than you to grow.", {
        keys: ["up", "left", "down", "right"].map((a) => keys(a)).join(", "),
      }), tw, "help-text");
      para(T("Split ({split}) launches half your mass forward to attack or travel. Eject ({eject}) sheds pellets to feed allies or lighten up. Hint: {hint}. Pause: {pause}. Spiked barbs burst cells of 60+ mass — small cells slip by.", {
        split: keys("split"), eject: keys("eject"), hint: keys("hint"), pause: keys("pause"),
      }), tw, "help-text");
      para(T("Touch: drag or tap on the dish to steer, and use the Split, Eject, Hint and Pause buttons. Gamepad: {stick} steers; {split} splits, {eject} ejects, {hint} shows a hint, {pause} pauses.", {
        stick: keys("up", "gamepad"), split: keys("split", "gamepad"), eject: keys("eject", "gamepad"), hint: keys("hint", "gamepad"), pause: keys("pause", "gamepad"),
      }), tw, "help-text");
      para(T("Pause with Esc or the Pause button. Rank is by mass and survival; ties break on objective completion, fewer invalid actions, then faster time."), tw, "help-text");
    }, { spacing: 12, width: tw });
  }, (w) => {
    button({ id: "btn-help-close", text: T("Close"), act: showTitle }, itemW(w));
  });
}

function modesScreen(L: Layout): void {
  screen("modes", L, 560, (w) => {
    h2(T("Choose a mode"), "modes-heading");
    stack("modes-list", [
      { id: "mode-learn", text: T("Learn"), act: () => showScreen("lessons") },
      { id: "mode-journey", text: T("Journey"), act: () => showScreen("journey") },
      { id: "mode-daily", text: T("Daily Challenge"), act: () => showScreen("daily") },
      { id: "mode-practice", text: T("Practice"), act: () => showScreen("practice") },
      { id: "mode-challenge", text: T("Challenge"), act: () => showScreen("challenge") },
    ], itemW(w));
  }, (w) => {
    button({ id: "btn-modes-back", text: T("Back"), act: showTitle }, itemW(w));
  });
}

/** "done" marks (and Journey stars) from the progress as it is now. */
function doneMark(mode: Mode, id: string): string {
  const p = platform.progress;
  if (mode === "learn") return p.lessonsDone[id] ? T("done") : "";
  if (mode === "journey") {
    const stars = p.journeyStars[id];
    return stars ? T("done") + (stars > 1 ? " ★".repeat(Math.min(3, stars)) : "") : "";
  }
  if (mode === "practice") return p.practiceDone[id] ? T("done") : "";
  if (mode === "challenge") return p.challengeDone[id] ? T("done") : "";
  return "";
}
function listScreen(L: Layout, key: string, title: string, items: Content[], mode: Mode): void {
  screen(key, L, 560, (w) => {
    h2(T(title), `${key}-heading`);
    stack(`${key}-list`, items.map((c) => ({
      id: `item-${c.id}`, text: T(c.name),
      sub: c.brief ? T(c.brief) : c.description ? T(c.description) : c.mastery ? T("mastery stage") : undefined,
      done: doneMark(mode, c.id) || undefined,
      act: () => startRound(c, mode),
    })), itemW(w));
  }, (w) => {
    button({ id: `btn-${key}-back`, text: T("Back"), act: showModeSelect }, itemW(w));
  });
}

function dailyScreen(L: Layout): void {
  const daily = today();
  screen("daily", L, 560, (w) => {
    h2(T("Daily Challenge"), "daily-heading");
    const name = daily.day ? T("Daily Culture — {date}", { date: daily.day }) : T(daily.name);
    para(T("{name} — reach {mass} mass in 3 minutes. Ranked.", { name, mass: daily.goal?.mass ?? 0 }), w, "sub", "daily-blurb", true);
    button({ id: "btn-daily-begin", text: T("Begin the day"), act: () => startRound(today(), "daily") }, itemW(w));
  }, (w) => {
    button({ id: "btn-daily-back", text: T("Back"), act: showModeSelect }, itemW(w));
  });
}

function pauseScreen(L: Layout): void {
  screen("pause", L, 560, (w) => {
    h2(T("Paused"), "pause-heading");
    const iw = itemW(w);
    stack("pause-actions", [
      { id: "btn-resume", text: T("Resume"), quiet: true, act: resumeGame },
      { id: "btn-restart", text: T("Restart round"), act: retry },
      { id: "btn-leave", text: T("Leave to modes"), act: leaveRound },
      { id: "btn-pause-options", text: T("Options"), act: () => openMenu() },
    ], iw);
    ui.column("pause-settings", () => {
      const check = (key: "captions" | "cvdPalette", label: string): void => {
        const cur = !!settings[key];
        const next = ui.id(`set-${key}`).checkbox(label, cur);
        if (next !== cur) platform.setSetting(key, next);
      };
      check("captions", T("Captions / text cues"));
      check("cvdPalette", T("Color-vision-safe palette"));
    }, { spacing: 4, width: iw });
    para(T("Sound, graphics, language, controls, text size, high contrast and reduced motion are in the StarHermit Options."), iw, "sub", "options-note", true);
  }, null);
}

const BREAKDOWN: [string, string][] = [
  ["motes", N("Motes absorbed")], ["pellets", N("Pellets absorbed")], ["rivalMass", N("Rival mass")], ["survival", N("Survival")],
  ["peakMass", N("Peak mass")], ["rankBonus", N("Rank bonus")], ["objectiveBonus", N("Objective bonus")],
];
function resultScreen(L: Layout): void {
  const res = app.results;
  if (!res) { showModeSelect(); return; }
  const showArt = !ui.preferences().highContrast && L.lh >= 420;
  screen("result", L, 560, (w) => {
    if (showArt) {
      const aw = Math.min(300, L.lw * 0.6);
      vignetteWidget(aw, Math.min(aw * 432 / 768, L.lh * 0.2));
    }
    h2(T(res.headline), "result-heading");
    const bw = Math.min(w, 360);
    const ddW = 72;
    ui.grid("breakdown", () => {
      for (const [k, label] of BREAKDOWN) {
        para(T(label), bw - ddW - 18, "bd-dt");
        ui.style("bd-dd").label(String(res.bd.parts[k] || 0));
      }
    }, { columns: [{ width: bw - ddW - 18 }, { width: ddW, align: "end" }], gap: { row: 4, column: 18 }, width: bw });
    para(T("Total score: {total} · Rank {rank}/{players}", { total: res.bd.total, rank: res.bd.rank, players: res.players }) + (res.bd.objectiveMet ? " · " + T("objective met") : ""), w, "total", "result-total", true);
    if (res.earned.length) {
      ui.row("result-earned", () => {
        medal(18);
        para(T("Achievement unlocked: {list}", { list: res.earned.map((k) => T(k)).join(", ") }), w - 30, "sub", "result-earned-text");
      }, { spacing: 6, align: "center" });
    }
    if (res.lb) {
      const lb = res.lb;
      para(lb.pending ? T("Posting score to the leaderboard…") : !lb.posted ? T("Score not posted to the leaderboard.")
        : lb.rank ? T("Leaderboard rank: #{rank}", { rank: lb.rank }) : T("Score posted to the leaderboard."), w, "sub", "result-lb", true);
    }
  }, (w) => {
    const iw = itemW(w);
    button({ id: "btn-retry", text: T("Retry"), act: retry }, iw);
    button({ id: "btn-result-back", text: T("Back to modes"), act: () => { endSession(); showModeSelect(); } }, iw);
  });
}
