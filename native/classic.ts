// The browser build's pure game scripts, unchanged and shared with the Node
// tests: rng, rules, content, store (the save document, its cross-device
// merge and the device's round board), the string tables (js/*.js, UMD) and
// js/migrate.js (the engine save document and what the browser build left
// in the account), evaluated as classic scripts so their globals (CDRNG,
// CDRules, CDContent, CDStore, CD_STRINGS, CDMigrate) are this module's
// exports.
//
// js/store.js keeps the device's local round board in `localStorage`: here
// that is a small shim over the device's starhermit:storage, installed
// before the scripts run. Progress is the game's save (platform.ts).
import { storage } from "starhermit:storage";
import { loadClassic } from "starhermit:script";

const shim = {
  getItem(key: string): string | null {
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    try { storage.set(key, String(value)); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key: string): void {
    try { storage.remove(key); } catch { /* gone */ }
  },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;

for (const f of ["js/rng.js", "js/rules.js", "js/content.js", "js/store.js", "js/strings.js", "js/migrate.js"]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export type GoalType = "reach-marker" | "reach-mass" | "eject-count" | "split-then-mass" | "absorb-cells" | "survive";
export interface Goal { type: GoalType; mass?: number; count?: number; splits?: number; x?: number; y?: number; radius?: number }
export interface Cell { id: number; playerId: string; x: number; y: number; vx: number; vy: number; mass: number }
export interface Mote { id: number; x: number; y: number }
export interface Barb { id: number; x: number; y: number; radius: number }
export interface Player { id: string; name: string; kind: string; hue: number; alive: boolean; invalidCount: number }
export interface Stats {
  motes: number; pellets: number; rivalMass: number; rivalCells: number; peakMass: number; spawnedMass: number;
  survivedTicks: number; splits: number; ejects: number; barbBursts: number; merges: number;
}
export interface State {
  tick: number; phase: "active" | "terminal"; terminalReason: string | null; winnerId: string | null; seed: number;
  config: { contentId: string; mode: string; durationTicks: number; goal: Goal; [k: string]: unknown };
  arena: { radius: number }; players: Player[]; cells: Cell[]; motes: Mote[]; pellets: Mote[]; barbs: Barb[];
  stats: Record<string, Stats>;
}
export interface Legal { active: boolean; alive: boolean; split: { ok: boolean; reason?: string }; eject: { ok: boolean; reason?: string } }
export interface Hint { action: string; x?: number; y?: number; text: string }
export interface Breakdown { total: number; rank: number; objectiveMet: boolean; parts: Record<string, number> }
export interface Command { type: string; x?: number; y?: number; id?: string }
export interface Theme { id: string; name: string; bg: string; bgDeep: string; membrane: string; player: string; motes: string[]; barb: string }
export interface Content {
  id: string; name: string; seed: string; theme?: string; brief?: string; description?: string; day?: string;
  mastery?: boolean; parTicks?: number; ranked?: boolean; index?: number;
  goal?: Goal; params: Record<string, number>;
}
export interface Progress {
  lessonsDone: Record<string, boolean>; journeyStars: Record<string, number>; journeyBest: Record<string, number>;
  practiceDone: Record<string, boolean>; challengeDone: Record<string, boolean>; challengeBest: Record<string, number>;
  dailiesDone: Record<string, number>; dailyStreak: { last: string | null; count: number };
  achievements: Record<string, number>;
  stats: { rounds: number; goals: number; wins: number; massAbsorbed: number; cellsAbsorbed: number; splits: number; playMs: number };
}
export interface Doc { v: number; settings: Record<string, unknown>; progress: Progress }
export interface BoardEntry { contentId: string; score: number; objective: boolean; invalid: number; durationMs: number; sessionId: string }

interface RulesApi {
  TICK_RATE: number; START_MASS: number;
  radiusOf(mass: number): number;
  createGame(cfg: unknown): State;
  applyCommand(s: State, playerId: string, cmd: Command): { ok: boolean; reason?: string };
  step(s: State): void;
  legalActions(s: State, playerId: string): Legal;
  cellsOf(s: State, playerId: string): Cell[];
  playerMass(s: State, playerId: string): number;
  centroid(s: State, playerId: string): { x: number; y: number } | null;
  rankings(s: State): { playerId: string; rank: number }[];
  scoreBreakdown(s: State, playerId: string): Breakdown;
  hint(s: State, playerId: string): Hint;
}
interface ContentApi {
  THEMES: Theme[]; CVD_THEME_PATCH: { membrane: string; player: string; barb: string; motes: string[] };
  LESSONS: Content[]; PRACTICE: Content[]; CHALLENGES: Content[];
  journeyStages(): Content[];
  dailyFor(date: Date): Content;
  toConfig(c: Content, opts: { mode: string }): unknown;
  themeById(id: string): Theme;
}
interface StoreApi {
  DEFAULT_SETTINGS: Record<string, unknown>;
  fresh(): Doc;
  loadBoards(): { entries: BoardEntry[] };
  saveBoards(b: { entries: BoardEntry[] }): void;
}
interface MigrateApi {
  GAME_SETTING_KEYS: string[];
  BROWSER_SETTING_KEYS: string[];
  progressFromSave(doc: unknown): Progress | null;
  docFromBrowserSave(text: string | null): Doc | null;
  saveDoc(progress: Progress): { v: 1; progress: Progress };
  mergeProgress(remote: Progress | null, local: Progress | null): Progress;
  migrateSetting(key: string, value: unknown): unknown;
}

const g = globalThis as unknown as {
  CDRules: RulesApi; CDContent: ContentApi; CDStore: StoreApi; CDMigrate: MigrateApi;
  CD_STRINGS: Record<string, Record<string, string>>;
};
export const Rules = g.CDRules;
export const Content = g.CDContent;
export const Store = g.CDStore;
export const Migrate = g.CDMigrate;
export const STRINGS = g.CD_STRINGS;
