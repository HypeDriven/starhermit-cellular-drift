// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, the event table of sfx/manifest.txt) on the runtime's
// mixer with the seeded ±6 % pitch variants, the authored petri-dish
// ambience loop, and the adaptive pad: a minor-pentatonic step over G3
// every 420 ms whose notes shorten and get louder with the intensity, with
// a low drone above intensity 0.45. Every event also emits its caption
// (onCaption), sample or not.
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects", the menu tick → "interface"; the old bus levels
// (music 60 %, effects 90 %, ambience 50 %) are folded into each sound's
// gain. The voice bus played nothing and is gone.
//
// The browser build made the pad and its stand-in synth with Web Audio
// oscillators; here the pad's notes are rendered once into clips
// (createClip) with the same envelopes, and the synthesized stand-ins it
// played while a sample loaded, and the low-passed noise bed under the
// ambience loop (8 % once the loop played), are not ported: the engine's
// browser runtime drops clip loads and plays while a synthesis graph runs
// (the arrow-exodus port's finding). Clips load one at a time once the
// mixer runs (natively at once, in a browser after the first press).
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

const LEVEL = { music: 0.6, effects: 0.9, ambience: 0.5 };
const SAMPLES: Record<string, string> = {
  ui: "ui-tick", absorb: "mote-absorb", pellet: "pellet-gulp", absorbBig: "cell-absorb-big", split: "cell-split",
  eject: "mass-eject", burst: "barb-burst", danger: "danger-ping", countdown: "countdown-beep", go: "round-start-go",
  rewind: "time-rewind", win: "goal-win", lose: "round-lose", timeup: "time-up", achievement: "achievement-unlock",
  merge: "cell-merge", hint: "hint-ping",
};
/** Text cues for meaningful audio (the Captions setting), shown whether the sample plays or not. */
export const CAPTIONS: Record<string, string> = {
  absorb: "absorbed a mote", pellet: "absorbed a pellet", absorbBig: "absorbed a rival cell",
  split: "split", eject: "ejected mass", burst: "burst on a barb", danger: "larger cell nearby",
  merge: "cells recombined", hint: "hint", go: "round start", rewind: "rewound",
  win: "goal complete", lose: "absorbed", timeup: "time up", achievement: "achievement unlocked",
};
/** Events whose pitch varies ±6 % from the round's seed (replays sound the same). */
const VARIANT = new Set(["ui", "absorb", "pellet", "absorbBig", "split", "eject", "merge", "hint"]);

const clips = new Map<string, AudioClip>();
let onCaption: ((key: string) => void) | null = null;
let variantSeed = 1;
let queue: string[] | null = null;
let loading = false;

export function setOnCaption(cb: (key: string) => void): void { onCaption = cb; }
export function setSeed(seed: number): void { variantSeed = (seed & 0x7fffffff) || 1; }
function variant(): number {
  variantSeed = (variantSeed * 1103515245 + 12345) & 0x7fffffff;
  return 1 + ((variantSeed % 1000) / 1000 - 0.5) * 0.12;
}

/** Plays an event's clip and emits its caption. */
export function play(name: string): void {
  if (CAPTIONS[name] && onCaption) onCaption(CAPTIONS[name]!);
  const pitch = VARIANT.has(name) ? variant() : 1;
  const clip = clips.get(name);
  if (!clip) return;
  const bus: Bus = name === "ui" ? "interface" : "effects";
  try { playClip(clip, { bus, gain: LEVEL.effects, pitch }); }
  catch { clips.delete(name); queue?.push(name); } // a clip the mixer lost: load it again
}

// -- the pad ----------------------------------------------------------------------------------
const RATE = 22050;
const SCALE = [0, 3, 5, 7, 10, 12, 15]; // minor pentatonic over the root
const ROOT = 196; // G3
/** A blip's envelope: 0.0001 → 1 over 12 ms, then down to 0.0001 by `dur` (exponential ramps). */
function env(t: number, dur: number): number {
  if (t < 0.012) return 0.0001 * Math.pow(1 / 0.0001, t / 0.012);
  if (t > dur) return 0;
  return Math.pow(0.0001, (t - 0.012) / (dur - 0.012));
}
/** One pad note: the sine at `freq` (gain 1) and its overtone at 2.01× (gain 0.3, 0.8 of the length). */
function noteClip(freq: number, dur: number): AudioClip {
  const n = Math.round((dur + 0.03) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    out[i] = Math.sin(2 * Math.PI * freq * t) * env(t, dur) + 0.3 * Math.sin(2 * Math.PI * freq * 2.01 * t) * env(t, dur * 0.8);
  }
  return createClip([out], RATE);
}
/** The drone: a triangle at half the root. */
function droneClip(dur: number): AudioClip {
  const n = Math.round((dur + 0.03) * RATE);
  const out = new Float32Array(n);
  const f = ROOT / 2;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const ph = (f * t) % 1;
    out[i] = (1 - 4 * Math.abs(ph - 0.5)) * env(t, dur);
  }
  return createClip([out], RATE);
}
// Two lengths, as the browser build's 1.6 − 0.7 × intensity: calm (≈1.5 s) and tense (0.9 s).
const DURS = [1.46, 0.9];
const notes: AudioClip[][] = [[], []]; // [length][degree * 2 + octave]
const drones: AudioClip[] = [];
const NOTE_COUNT = SCALE.length * 2;
let intensity = 0;
let stepIdx = 0;
let nextStep = 0;
let musicOn = false;
let ambience: Sound | null = null;
let ambienceClip: AudioClip | null = null;

export function setIntensity(v: number): void { intensity = Math.max(0, Math.min(1, v)); }
/** Asks for the clips and the music; they start once the mixer runs (see update). */
export function start(): void {
  if (queue) return;
  queue = [...Object.keys(SAMPLES), "ambience"];
  musicOn = true;
}
/** Hidden window: the pad stops (the browser build's stopMusic); it resumes with resume(). */
export function suspend(): void { musicOn = false; }
export function resume(): void { musicOn = true; }

function loadNext(): void {
  if (loading || !queue || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  const path = name === "ambience" ? "sfx/ambience-medium.opus" : `sfx/${SAMPLES[name]}.opus`;
  loadClip(path).then((c) => {
    if (name === "ambience") ambienceClip = c;
    else clips.set(name, c);
  }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`)).finally(() => { loading = false; });
}

/** Each frame: the next clip to load, one rendered pad note a frame, the ambience loop, then the pad's step every 420 ms. */
export function update(): void {
  if (context.state !== "running" || !queue) return;
  loadNext();
  try {
    for (let d = 0; d < DURS.length; d++) {
      if (notes[d]!.length < NOTE_COUNT) {
        const i = notes[d]!.length;
        const degree = SCALE[i >> 1]!;
        notes[d]!.push(noteClip(ROOT * Math.pow(2, degree / 12) * (i & 1 ? 0.5 : 1), DURS[d]!));
        return;
      }
    }
    if (drones.length < DURS.length) { drones.push(droneClip(DURS[drones.length]!)); return; }
    if (ambienceClip && !ambience) { ambience = playClip(ambienceClip, { bus: "effects", gain: 0.8 * LEVEL.ambience, loop: true }); return; }
  } catch (e) { console.warn(`audio: ${String(e)}`); queue = []; return; }
  if (!musicOn) return;
  const now = context.currentTime;
  if (now < nextStep) return;
  nextStep = now + 0.42;
  const degreeIdx = (stepIdx * 3 + (stepIdx >> 2)) % SCALE.length;
  const low = stepIdx % 8 >= 4;
  const tense = intensity >= 0.6 ? 1 : 0;
  try {
    playClip(notes[tense]![degreeIdx * 2 + (low ? 1 : 0)]!, { bus: "music", gain: (0.07 + intensity * 0.05) * LEVEL.music });
    if (intensity > 0.45 && stepIdx % 2 === 0) playClip(drones[tense]!, { bus: "music", gain: 0.05 * LEVEL.music });
  } catch { /* the mixer is full */ }
  stepIdx++;
}
