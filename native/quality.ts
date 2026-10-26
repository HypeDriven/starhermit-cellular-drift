// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the burst particles and the drifting plankton scaled within the tier by
// the level (frame().levelIndex), as the browser build scaled them by its
// hardware level (StarHermitGpu.scaleBudget), under the Particles tier's
// caps. The runtime owns the rest of what the old Graphics panel did: Auto
// and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and readout, and the shadow-map size and
// MSAA samples it holds to the level.
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Dish-floor texture edge in px (surface detail plain uses half). */
  floorTexture: number;
  /** Membrane sphere [width, height] segments. */
  cellSegments: [number, number];
  /** Membrane shading: Lambert, standard, or physical (clearcoat) with surface detail on. */
  material: "lambert" | "standard" | "physical";
  /** Burst-particle budget. */
  particles: number;
  /** Drifting plankton. */
  decor: number;
}
export interface Look {
  preset: Preset;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based lighting (the room environment) on membranes and barbs. */
  reflections: boolean;
  particles: "low" | "high";
  /** The caustic shimmer drifting across the dish floor. */
  animated: boolean;
  /** The agar floor's detail (lamp pool, ghost cell walls, grain) and glossy membranes. */
  detailed: boolean;
  budget: Budget;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, bloom: false, grade: false, antialias: "msaa", reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { shadows: 1024, bloom: true, grade: true, antialias: "fxaa", reflections: true, particles: "high", animated: true, detailed: true },
  high: { shadows: 2048, bloom: true, grade: true, antialias: "smaa", reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { shadows: 4096, bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { floorTexture: 512, cellSegments: [16, 10], material: "lambert", particles: 200, decor: 50 },
  balanced: { floorTexture: 1024, cellSegments: [24, 16], material: "standard", particles: 500, decor: 120 },
  high: { floorTexture: 1024, cellSegments: [28, 20], material: "physical", particles: 900, decor: 200 },
  ultra: { floorTexture: 2048, cellSegments: [40, 28], material: "physical", particles: 1200, decor: 320 },
};
const PARTICLE_CAP = { low: 300, high: 1200 };
const DECOR_CAP = { low: 60, high: 480 };
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const row = TABLE[preset] ?? TABLE.balanced;
  const b: Budget = { ...(BUDGETS[preset] ?? BUDGETS.balanced) };
  // Levels are about 1.64× apart in GPU throughput: counts grow with the
  // level above the tier's first, at most 4× (the browser build's scaleBudget cap).
  const k = Math.min(4, Math.pow(1.64, Math.max(0, levelIndex - (TIER_FLOOR[preset] ?? 0))));
  b.particles = Math.min(PARTICLE_CAP[row.particles], Math.round(b.particles * k));
  b.decor = Math.min(DECOR_CAP[row.particles], Math.round(b.decor * k));
  return { preset, ...row, budget: b };
}
