// The look per graphics level. The engine-owned effects (shadows and their
// map size, bloom and its resolution, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (materials, membrane segments, floor detail and texture,
// reflections, the caustic shimmer) is the browser build's four presets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// Auto gave it) keyed by the level's quality tier, with the burst particles
// and the drifting plankton scaled within the tier by the level's particle
// budget against the tier's anchor level (quantum, molecular, terrestrial,
// galactic), at most 4×, under the Particles tier's caps. The runtime owns
// what the old Graphics panel did besides: Auto and the level choice, render
// scale and the pixel-ratio cap, adaptive resolution and the frame-rate
// limit and readout.
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's bloom resolution as a fraction of the frame (null: off). */
  bloom: number | null;
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

type Art = Pick<Look, "reflections" | "particles" | "animated" | "detailed">;
const TABLE: Record<Preset, Art> = {
  low: { reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { reflections: true, particles: "high", animated: true, detailed: true },
  high: { reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { floorTexture: 512, cellSegments: [16, 10], material: "lambert", particles: 200, decor: 50 },
  balanced: { floorTexture: 1024, cellSegments: [24, 16], material: "standard", particles: 500, decor: 120 },
  high: { floorTexture: 1024, cellSegments: [28, 20], material: "physical", particles: 900, decor: 200 },
  ultra: { floorTexture: 2048, cellSegments: [40, 28], material: "physical", particles: 1200, decor: 320 },
};
const PARTICLE_CAP = { low: 300, high: 1200 };
const DECOR_CAP = { low: 60, high: 480 };
/** Each tier's reference level: its budgets are tuned there. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const row = TABLE[preset] ?? TABLE.balanced;
  const b: Budget = { ...(BUDGETS[preset] ?? BUDGETS.balanced) };
  // Counts grow with the level's particle budget above the tier's anchor,
  // at most 4× (the browser build's scaleBudget cap).
  const k = Math.min(4, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.particles = Math.min(PARTICLE_CAP[row.particles], Math.round(b.particles * k));
  b.decor = Math.min(DECOR_CAP[row.particles], Math.round(b.decor * k));
  b.floorTexture = Math.min(b.floorTexture, s.maxTextureSize);
  return {
    preset, ...row, budget: b,
    shadows: s.shadows ? s.shadowMapSize : 0,
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
  };
}
