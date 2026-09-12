# Cellular Drift — Game Design Document (running spec)

This document describes Cellular Drift as it ships today. Present tense throughout; where the design calls for something the code does not yet do, it is listed under "Design intent not yet implemented" at the end and nowhere else.

## 1. Overview

**Pitch.** You are one translucent cell in a lit petri dish. Drift toward the pointer, graze on nutrient motes, split to lunge, eject to shed weight, and outgrow the rivals that hunt you — before a barb bursts you or the clock runs out.

| | |
|---|---|
| Genre | Realtime mass arena, single player versus seeded AI rivals |
| Players | 1 human (`p0`) plus 0–10 AI rivals per content item |
| Session | 30 s (Lesson 1) to 4 min (Apex Culture); rounds hard-capped at 30 sim-minutes |
| Platforms | Desktop and mobile browsers with WebGL; portrait and landscape |
| Rendering | Three.js r-module (`vendor/three.module.js`), orthographic top-down camera, semantic HTML overlay for every menu and the HUD |
| Simulation | Fixed 30 Hz deterministic step in `js/rules.js`; rendering interpolates between ticks |
| Persistence | Versioned, checksummed `localStorage` document (`js/store.js`) |
| Server | `server.js` — static files with revalidating headers, `/api/v1/time`, `/api/v1/scores` |

### File map

| Path | Responsibility |
|---|---|
| `index.html` | Entry point; loads CSS, import map, classic scripts (`rng`, `rules`, `content`, `store`) then the `app.js` module; boot watchdog that shows "Cellular Drift could not start" after 8 s |
| `js/rng.js` | mulberry32 PRNG, FNV-1a `hashString`, three derived streams (rules / decor / AV) |
| `js/rules.js` | The whole rules engine: `createGame`, `applyCommand`, `step`, `legalActions`, `hint`, `scoreBreakdown`, `rankings`, `serialize`/`deserialize`, `stateHash` |
| `js/content.js` | Themes, 6 lessons, 40 journey stages, daily generator, 3 practice presets, 6 challenges, `toConfig`, `validateContent` |
| `js/store.js` | Save document (settings + progress), local leaderboard entries, tie-break sort |
| `js/app.js` | UI shell (all screens built once), input, fixed-step loop, HUD, results, persistence, score submission, `window.CDApp.debug()` |
| `js/render.js` | Three.js scene: environment, pooled cell views, instanced motes/pellets, barbs, FX particles, marker/hint rings, camera, quality tiers |
| `js/audio.js` | WebAudio: 4 buses, sampled events with synth fallback, procedural pad music, ambience bed + authored loop, captions |
| `js/platform.js` | Server-time sync with 2.5 s timeout, score POST, board GET |
| `css/style.css` | Layout shell, screens, buttons, HUD tray, captions, results breakdown, title/results art |
| `sfx/` | 18 Opus clips; `manifest.txt` (canonical), `manifest.json` (generator input), `manifest.md` (generated) |
| `assets/` | `title-backdrop.webp`, `results-vignette.webp` |
| `coverart.png`, `icon.png`, `favicon.svg` | Platform cover (1200x675), 256 px icon, tab icon |
| `tests/rules-regression.mjs` | `npm test`: determinism, duplicate rejection, constraint rule, content validation |
| `tests/e2e.mjs` | `npm run test:e2e`: headless Chrome playthrough on 4 viewports through the real UI |
| `starhermit.txt` | `name=Cellular Drift`, `launch=index.html`, `server=server.js`, `cover=coverart.png` |

## 2. Vision and design pillars

1. **Mass is the only stat.** Every number the player sees derives from mass: radius is `1.2·√mass`, speed falls as `(20/mass)^0.28`, split needs 32, eject needs 25, barbs burst 60+. Rules in: growth that visibly slows you, shedding weight to get fast again. Rules out: power-ups, buffs, hidden multipliers, cosmetics that touch hitboxes.
2. **The dish is the hero.** The circular arena, its glowing rim, the drifting motes and the membranes of every cell are the whole picture; menus are dark scrims over it. Rules in: instanced motes, membrane breathing, one warm key light. Rules out: HUD chrome that competes with the playfield, minimaps, permanent side rails.
3. **Threat you can read.** Danger is always geometric: a bigger cell is bigger on screen, a barb is a red spiked star, and the hint engine says "flee" using the same legality math the AI uses. Rules in: the danger ping, the hint ring, invalid-action captions. Rules out: off-screen indicators, surprise mechanics, timers you cannot see.
4. **One rule per lesson, one seed per day.** Lessons introduce drift, graze, eject, divide, barbs, hunt in that order and each requires the action; the daily is one shared seed per UTC day. Rules in: seeded content everywhere, "done" badges, three-star journey stages. Rules out: random modifiers mid-round, rerolls, unranked dailies.
5. **Deterministic to the tick.** Same seed plus same quantised commands produce the same `stateHash`; audio variants are seeded too. Rules in: `step()` order fixed, AI randomness on the rules stream, integer scores. Rules out: wall-clock physics, per-frame rules updates, floating targets.

## 3. Player experience

**Target player.** Someone who liked mass-arena games on a phone and wants a short, fair, offline-friendly single-player version with authored progression instead of a public lobby.

**First 60 seconds.** Title → Play → Learn → Lesson 1 "Drift". The HUD objective reads the lesson brief ("Your cell drifts toward the pointer (or arrow keys). Move to the glowing marker."), a pulsing yellow ring marks the target, the cell follows the pointer immediately, and reaching the ring ends the round with "Goal complete!" and a score breakdown. Each later lesson adds exactly one rule in its brief. At any point the Hint button (or H) shows a cyan ring and a one-line instruction from `rules.hint`; illegal Split/Eject presses print the reason ("Cannot split: cells too small or cooling") in the caption strip.

**Session shape.** Pick a mode, play one 1–4 minute round, read the breakdown, Retry or go back. Journey stages earn 1–3 stars; the daily updates a streak; practice and challenges get a "done" badge.

**Emotional beat.** The pivot from prey to predator: the first time a rival that chased you at mass 30 is now 15 % smaller than you and the hint says "Split now to launch onto the smaller cell."

## 4. Core loop and rules contract

All rules live in `js/rules.js` (UMD, no DOM). Constants below are `RULES_VERSION = 1` tunables and change only with a version bump.

### Entities

| Entity | Fields | Notes |
|---|---|---|
| Player | `id`, `name`, `kind` human/ai, `hue`, `skill`, `alive`, `invalidCount`, `target{x,y}`, `ejectCooldownUntil`, AI scratch | `p0` is always the local human; rivals are `p1..pN` |
| Cell | `id`, `playerId`, `x`,`y`, `vx`,`vy`, `ix`,`iy` (impulse), `mass`, `bornTick`, `lastSplitTick`, `mergeAfter` | radius `radiusOf(mass) = √mass · 1.2` |
| Mote | `id`, `x`,`y`, `mass = 1` | spawned uniformly by area inside `radius − 12`; respawn `moteRespawnPerTick` (default 0.12/tick) up to `moteCap`, backlog capped at 4 |
| Pellet | `id`, `x`,`y`, `vx`,`vy`, `mass = 3`, `ownerId`, `bornTick` | launched at 13 units/tick, friction 0.90 |
| Barb | `id`, `x`,`y`, `radius = 8` | placed at least 140 units from every spawn cell (24 tries) |
| Arena | `radius` (320–700 in shipped content) | everything is clamped inside `radius − r` |

Spawn: the human at 15 % of the arena radius from centre, rivals at 45–75 % spread by angle, all at `START_MASS = 20`.

### Commands (`applyCommand(state, playerId, cmd)`)

| Command | Legal when (`legalActions`) | Effect |
|---|---|---|
| `setTarget {x,y}` | round active and player alive; finite numbers | target clamped to `arena.radius + 200` and quantised to 0.5 units |
| `split` | a cell has mass ≥ 32 and ≥ 24 ticks since its last split; fewer than 16 cells; not `splitDisabled` | queued as a wish, executed at the start of the next tick |
| `eject` | a cell has mass ≥ 25 (22 + 3); player eject cooldown elapsed (5 ticks); not `ejectDisabled` | queued wish |
| `surrender` | round active | eliminates the player, `terminalReason = 'surrender'` |

An optional `cmd.id` is tracked in a 64-entry ring per player; a repeated id returns `{ok:false, reason:'duplicate'}` without touching state. `app.js` tags Split/Eject with `'c' + ++cmdSeq`. Every rejected command except `duplicate` increments `invalidCount`, which feeds the tie-break and the journey star for a clean round.

### Resolution order (one `step()`)

`tick++` → `aiThink` → `applyWishes` (split, then eject, players in order) → `moveCells` → `movePellets` → `absorbMotes` → `absorbPellets` → `absorbCells` → `barbBursts` → `recombine` → `decay` → `respawnMotes` → `updateSurvival` → `checkTerminal` → hard stop at `MAX_TICKS = 54 000`.

- **Movement.** Wanted velocity is `min(speed, d·0.25)` toward the target (cells settle instead of orbiting); `v += (want − v)·0.18 + impulse`, impulse decays ×0.90. `speedOf(mass) = clamp(6.4·(20/mass)^0.28, 1.7, 6.4)` units/tick: 6.4 at mass 20, 4.1 at 100, 3.3 at 220. Same-owner cells that are not yet allowed to merge push apart softly.
- **Split (`doSplit`).** Each eligible cell (ascending id) halves; the child spawns one radius toward the target with impulse 24 along that direction; both halves get `mergeAfter = tick + 600` (20 s) and the cooldown. Stops when 16 cells would be exceeded.
- **Eject (`doEject`).** Each cell with mass ≥ 25 loses 3 and fires a pellet from just outside its rim toward the target. The owner may re-absorb its own pellet only after 40 ticks (1.33 s); anyone else immediately.
- **Absorb motes/pellets.** A mote or pellet whose centre is inside a cell's radius is eaten; first cell in array order wins.
- **Absorb cells.** Eaters and prey are processed in ascending id. Eater needs `mass ≥ prey.mass · 1.15` and the prey's centre inside `eaterRadius − preyRadius·0.35`. Prey mass is added once; `rivalMass`, `rivalCells` stats update. A player with no cells left becomes `alive = false`. With `noRivalAbsorb` (Gentle Giant), the human eating any rival ends the round as `constraint-violated` immediately.
- **Barbs.** A cell with mass ≥ 60 whose rim overlaps a barb bursts into `min(8, floor(mass/12))` equal pieces flung radially with impulse 14.4; one burst per cell per tick. Cells under 60 pass through.
- **Recombine.** Largest-first: two same-owner cells past `mergeAfter` merge when the smaller's centre is inside the larger's radius (`merges` stat rises).
- **Decay.** Mass above 220 sheds 0.06 % per tick, never below 220.
- **AI (`aiThink`).** Every 12 ticks per rival: flee from the mass-weighted centroid of bigger cells within `240 + skill·160` units (panic-split at skill > 0.55 when within 120); else hunt the nearest edible cell, split-killing when 2.6× its mass and within 150 units with probability `0.2 + skill·0.5`; else graze the nearest of the first 40 motes, steering off barbs when ≥ 60 mass. Low skill adds ±20–30 unit jitter. All AI randomness uses the rules RNG.

### Goals and terminal states (`objectiveMet`, `checkTerminal`)

| Goal type | Met when | Used by |
|---|---|---|
| `reach-marker {x,y,radius}` | player centroid within `radius` of the point | Lesson 1 |
| `reach-mass {mass}` | total player mass ≥ `mass` | Lessons 2 & 5, all journey stages, daily, practice, most challenges |
| `eject-count {count}` | `ejects` stat ≥ count | Lesson 3 |
| `split-then-mass {splits, mass}` | splits ≥ 1 and mass ≥ target | Lesson 4 |
| `absorb-cells {count}` | `rivalCells` ≥ count | Lesson 6, Apex Culture |

Terminal reasons, checked in this order each tick: `eliminated` (human has no cells) → `goal-complete` (winner `p0`) → `last-cell` (only the human alive and rivals existed; winner `p0`) → `time-up` (`durationTicks` reached) → `constraint-violated` (from `absorbCells`) → `surrender`. `finalize` assigns ranks. The round is won for progression purposes on `goal-complete`, `last-cell`, or `time-up` with the objective met.

### Ranking and tie-break (`rankings`)

Sort by objective met (desc), total mass (desc), fewer invalid actions, more survived ticks, then player id. Local leaderboard entries (`store.sortEntries`) sort by objective, score, invalid, lower `durationMs`, then `sessionId`.

### Scoring (`scoreBreakdown`, integers)

`motes·2 + pellets·3 + round(rivalMass)·5 + floor(survivedTicks/30)·2 + floor(peakMass) + rankBonus + objectiveBonus`, where `rankBonus = (players − rank)·100` once terminal and `objectiveBonus = 500` if the objective is met.

Worked example — Practice "Calm" (you + 1 rival), goal 100 mass reached at 1:40 after 70 motes, 4 pellets and one 38-mass rival cell, peak mass 160, rank 1: `140 + 12 + 190 + 200 + 160 + 100 + 500 = 1302`. Lesson 2 solo, 40 motes in 45 s, peak 60: `80 + 0 + 0 + 90 + 60 + 0 + 500 = 730`.

Journey stars (`app.js showResults`): `1 + (tick ≤ parTicks) + (invalidCount === 0)`, `parTicks = 60 %` of the stage duration.

### RNG and seeding

`createGame` hashes a string seed with FNV-1a; the rules stream starts at `seed ^ 0x9e3779b9` and is stored in `state.rngState`, so `serialize()` captures everything. Content seeds are literal strings (`'lesson-1'`, `'journey-17'`, `'daily:2026-09-08'`, `'practice-calm'`, `'challenge-apex'`). Rival names, skills and hues come from a separate LCG on `hashString('names:' + seed)`. `render.js` derives decor blotches and drift particles from `game.seed`; `audio.js` seeds ±6 % pitch variants from it. `stateHash` covers tick, phase, rng, entity ids/positions/masses (×1000 rounded), and player alive/invalid counts.

### Hints and undo

`hint(state, p0)`: flee if a bigger cell is within 200 units → hunt/split if an edible cell is within 260 (split when 2.6× and within 150 and legal) → graze the nearest mote to the centroid → "drift". The same function drives the content validator bot and adaptive music intensity. There is no undo; `allowRewind` is set for practice but nothing consumes it.

## 5. Modes and progression

All modes funnel through `startRound(content, mode)`; `content.toConfig` turns a descriptor into a rules config with `rivalSet(seed, count, skill, ±0.12)`.

| Mode | Content | Differences | Progress stored |
|---|---|---|---|
| Learn | 6 lessons (`LESSONS`): Drift, Graze, Eject, Divide, Barbs, Hunt | 0 rivals except Hunt (2 at skill 0.2); small arenas 320–520; 1–4 min limits | `lessonsDone[id]` on win |
| Journey | 40 generated stages `j01..j40`, 8 per theme tier; every 8th is a mastery stage | arena `560 + 40·tier`, goal `80 + 25·tier + 8·step` (×1.35 mastery), rivals 0→4 (+2 mastery, max 6), skill 0.25→0.83, barbs 0→5 | `journeyStars[id]` (1–3), `journeyBest[id]` |
| Daily Challenge | `dailyFor(platform.now())`: one descriptor per UTC day, `ranked: true` | arena 580–700, 130–170 motes, 3–6 rivals at skill 0.4–0.7, 2–6 barbs, 3 min, goal 140–220, theme by hash | `dailiesDone[day]` = best score, `dailyStreak {last, count}` (consecutive UTC days) |
| Practice | Calm / Standard / Expert presets | 1/3/6 rivals at 0.25/0.5/0.75, 1/3/6 barbs, goals 100/160/220; never ranked | `practiceDone[id]` |
| Challenge | Lean Drift (no eject), Sprint Culture (75 s), Crowded Dish (10 rivals), Barb Garden (12 barbs), Gentle Giant (no rival absorbs), Apex Culture (absorb 8) | per-item constraints via `ejectDisabled`, `durationTicks`, `noRivalAbsorb`, goal type | `challengeDone[id]`, `challengeBest[id]` |

Difficulty curve: tier 0 (Lagoon) teaches grazing alone, a single timid rival appears at stage 6; tier 1 (Amethyst) is 1–2 rivals; tier 2 (Verdant) adds 2–5 barbs; tier 3 (Cinder) has 2–3 rivals plus barbs at skill 0.45+; tier 4 (Aurora) is 3–4 rivals at 0.55–0.83 with 3–5 barbs and goals up to 297 at the mastery stage. Nothing is locked: every list is fully selectable; badges show completion. Lifetime stats (`rounds`, `goals`, `wins`, `massAbsorbed`, `cellsAbsorbed`, `splits`, `playMs`) accumulate in the save document.

## 6. Controls and interaction

| Input | Desktop | Touch | Effect / feedback |
|---|---|---|---|
| Steer | pointer move over the canvas (no button needed), or Arrow keys / WASD nudging the target 260 units from the centroid | drag or tap anywhere on the canvas (pointer capture) | all your cells accelerate toward the world point; no cursor is drawn — the cells themselves are the feedback |
| Split | Space or HUD **Split** | HUD **Split** (64×44 px min) | `cell-split` cue, halves fly toward the target; button disabled when illegal; caption explains a rejected press |
| Eject | E or HUD **Eject** | HUD **Eject** | `mass-eject` cue, pellet leaves toward the target |
| Hint | H or HUD **Hint** | HUD **Hint** | `hint-ping` cue, cyan ring for 2.6 s, one-line caption |
| Pause / resume | Esc or P, or HUD **Pause** | HUD **Pause** | `ui-tick`, pause overlay; Esc toggles back |
| Menus | Tab/Enter on real buttons; first control auto-focused on every screen except the HUD | tap | `ui-tick` on every button |

Locking: steering, Split, Eject and Hint are ignored unless `inPlay()` (round active and not paused). Keyboard steering is ignored while focus is in an input. Backgrounding the tab pauses the round and suspends audio; returning resumes audio but leaves the pause overlay for the player. Frame `dt` is clamped to 250 ms and at most 8 ticks run per frame, then the backlog is dropped rather than fast-forwarded.

## 7. Screens and UI flow

Screens are `<section class="cd-screen …">` elements built once in `buildUI` and switched by `showScreen(name)` — exactly one is displayed at a time:

`title` ⇄ `help`; `title` → `modesel` → {`lessons` | `journey` | `daily` | `practice` | `challenge`} → `hud` ⇄ `pause` → (`hud` restart | `modesel` leave); `hud` → `result` → (`hud` retry | `modesel`). Two extra states live outside this map: the boot-failure alert in `index.html` and the "3D unavailable" compat panel when `WebGLRenderer` throws.

Layout: `.cd-root` is `position: fixed; inset: 0; overflow: hidden`; the canvas fills it; every screen is an absolutely positioned flex column with `overflow-y: auto`, `padding: max(16px, env(safe-area-inset-*))`, and auto margins on the first/last child so short content centres and long content (the 40-stage journey list) scrolls from the top. Menu screens carry an 82 % dark scrim; the title adds the authored backdrop under a lighter gradient; the HUD has no scrim and `pointer-events: none` except on its buttons.

HUD: objective + progress text top-left (`max-width: 70ch`), **Pause** top-right, the Split / Eject / Hint tray bottom-right inside the safe area, captions centred at the bottom. Nothing in the HUD may cover the player's cell, which the camera keeps centred. Desktop 1280×800, short desktop 1280×600, phone portrait 390×844 and phone landscape 844×390 are all verified by `tests/e2e.mjs`: no child above the viewport, none clipped horizontally, the last child reachable by scrolling, no text overflow in buttons or paragraphs.

## 8. Art direction

**Palette** (from `content.js THEMES` and `css/style.css`): shell background `#071c26` / `#04131b`, text `#eafcff`, accent `#4fd8c2` (buttons at 12 % fill / 55 % border, hover 25 %), focus ring `#9bf6e4`, goal marker `#fff3a0`, hint ring `#9be8ff`.

| Theme | bg / deep | membrane | player | motes | barb |
|---|---|---|---|---|---|
| Lagoon Culture | `#071c26` / `#03101a` | `#4fd8c2` | `#ffd166` | `#9bf6e4 #6ee7d8 #c5fff3` | `#ff6b81` |
| Amethyst Depth | `#170f2b` / `#0b0618` | `#9b7bff` | `#7be0ad` | `#cbb7ff #a88fe8 #e3d8ff` | `#ff8f5c` |
| Verdant Bloom | `#0c2013` / `#04100a` | `#7fd069` | `#6ec9ff` | `#b9f0a4 #8fd97a #dcf7cd` | `#ffb347` |
| Cinder Field | `#241016` / `#120508` | `#ff7a66` | `#7ad7f0` | `#ffb09a #ff8d75 #ffd6c8` | `#ffd23f` |
| Aurora Veil | `#0a1a2b` / `#050d18` | `#5fb4ff` | `#f9f871` | `#a5d8ff #7cc4f5 #d0ebff` | `#ff6fd8` |

The colour-vision-safe patch replaces membrane/player/barb/motes with `#0072B2 / #E69F00 / #D55E00 / #56B4E9 #F0E442 #CC79A7`. Rival hues come from the seed and are rendered at HSL(hue, 0.62, 0.55); the player is always the theme's `player` colour plus a pulsing rim on layer 2 — the only entity with a rim.

**Shape language.** Everything is round: cells are flattened spheres (`scale.z 0.42`) with a 30 %-opacity nucleus, motes and pellets are low-poly icosahedra, the dish is a circle with a 5-unit glowing rim and four faint concentric rings, the only spiky silhouette is the 9-point barb star. Menus use 10 px radii and thin accent borders.

**Typography.** `'Segoe UI', system-ui, -apple-system, sans-serif`; title `clamp(1.8rem, 6vw, 3.2rem)`; buttons `clamp(0.95rem, 2.5vw, 1.1rem)`; HUD text carries a 1 px shadow for legibility over the dish.

**Lighting and camera.** ACES tone mapping at exposure 1.05, one directional key from upper-left plus 0.75 ambient. Orthographic camera follows the player centroid with critically damped smoothing (`FOLLOW_RATE 6.5`, `ZOOM_RATE 4`); view half-height `clamp(46 + radius·28.8, 80, 900)` — about 200 units at mass 20, 390 at mass 100. Shake is capped at 6 units and decays exponentially.

**Motion principles.** Membranes breathe ±2 %, motes pulse ±12 %, barbs spin 0.35 rad/s, decor drifts 0.008 rad/s, the marker ring pulses ±8 %. Vanished entities pop into 4 (mote) or 14 (cell) particles from a 1 200-particle pool bounded per tier (150 / 500 / 1 200). Reduced motion removes breathing, pulses, spin, drift, shake and caps particle bursts at 3 while keeping event timing. High contrast raises membrane opacity to 0.95, saturates rival hues and brightens the rim and rings.

**Quality tiers.** `low / medium / high` cap device pixel ratio at 1 / 1.5 / 2 and decor particles at 40 / 110 / 220; tiers never touch rules or hazard visibility. The default is `auto`, which currently leaves the renderer at `high`.

**Visual assets the design calls for**

| Asset | Purpose |
|---|---|
| `coverart.png` | Platform cover: the dish from above, golden player cell centred, rival hues, barbs, motes |
| `assets/title-backdrop.webp` | Title screen key art under the scrim: out-of-focus teal membranes, empty centre for the wordmark |
| `assets/results-vignette.webp` | Results overlay hero: one fully grown golden cell drawing motes in |
| `icon.png`, `favicon.svg` | Launcher icon and tab icon |

No mesh assets: cells, motes, barbs and the dish are procedural geometry by design.

## 9. Audio direction

**Mix.** Four independent gain buses — `music` 0.6, `effects` 0.9, `ambience` 0.5, `voice` 0.8 — under one master; "Mute all" zeroes every bus. WebAudio unlocks on the first pointerdown/keydown; before that, and while muted, events still emit captions. Sampled clips are lazily fetched and decoded on first use; until a clip is ready (or if it 404s) the synth version plays, so every cue exists with no assets at all. Pitch variants (±6 %) come from an LCG seeded by the round seed.

**Music.** Procedural minor-pentatonic pad over G3 stepping every 420 ms; note length and a low triangle drone scale with `intensity`, which `afterTick` sets to 1 while the hint says "flee" and to `0.2 + 0.5·(mass/goal)` otherwise. Music stops while the tab is hidden.

**Ambience.** A low-passed noise bed (240 Hz, 0.07 Hz LFO) starts at unlock; the authored 12 s loop `ambience-medium.opus` cross-fades in over 2.5 s once decoded, and the bed drops to 8 %.

**SFX event table** (source of `sfx/manifest.txt`; every id is an `audio.play` name in `js/audio.js`):

| Event id | File | Sound | Usage context |
|---|---|---|---|
| `ui` | `ui-tick.opus` | short soft plastic tick | every menu/back button, Pause, Resume |
| `absorb` | `mote-absorb.opus` | wet plip into jelly | player's `motes` stat rose this tick |
| `pellet` | `pellet-gulp.opus` | quick underwater gulp | player's `pellets` stat rose |
| `absorbBig` | `cell-absorb-big.opus` | deep membrane thump + squelch | player absorbed a rival cell; shake 2.5 |
| `split` | `cell-split.opus` | wet elastic tear | player split executed |
| `eject` | `mass-eject.opus` | short wet spurt | player ejected pellets |
| `burst` | `barb-burst.opus` | sharp membrane crack | a player cell burst on a barb; shake 4 |
| `danger` | `danger-ping.opus` | low sonar ping | hint action is `flee`; at most one per 2.2 s |
| `merge` | `cell-merge.opus` | two blobs fusing, low plop | player's split halves recombined |
| `hint` | `hint-ping.opus` | glassy ping with watery tail | Hint pressed, ring shown |
| `go` | `round-start-go.opus` | bright rising chime | every round start, Retry, Restart |
| `win` | `goal-win.opus` | four-note ascending fanfare | results for `goal-complete` / `last-cell` |
| `lose` | `round-lose.opus` | three descending tones | results for `eliminated` / `constraint-violated` / `surrender` |
| `timeup` | `time-up.opus` | three flat buzzer beeps | results for `time-up` |
| `ambience` | `ambience-medium.opus` | quiet petri-dish fluid loop | ambience bus loop from unlock |
| `countdown` | `countdown-beep.opus` | neutral countdown beep | bound; no trigger yet (intent) |
| `rewind` | `time-rewind.opus` | reverse whoosh | bound; no trigger yet (intent) |
| `achievement` | `achievement-unlock.opus` | sparkling three-note chime | bound; no trigger yet (intent) |

Captions: with "Captions / text cues" on, every played event writes its text ("absorbed a rival cell", "cells recombined", …) to the `aria-live` caption strip for 1.6 s. The voice bus exists but nothing plays on it.

## 10. Localization

The game ships in English only: every string is a literal in `js/app.js` (UI), `js/content.js` (lesson briefs, stage, preset and challenge names, rival names) and `js/rules.js` (hint sentences). There is no locale detection, no string table and no language setting. Layout already tolerates expansion: buttons are `max-width: 100%` with wrapping text, the objective wraps at 70ch, list buttons are `min(420px, 100%)` wide, and the e2e layout probe fails on any overflowing text. The target set — en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT — and the mechanism are listed under design intent.

## 11. Accessibility

- **Keyboard-only path.** Every screen auto-focuses its first control; Tab/Enter operate real `<button>`/`<input>` elements; in play, Arrow/WASD steer, Space splits, E ejects, H hints, Esc/P pauses. The HUD deliberately does not take focus so Space is never swallowed by a button.
- **Focus.** `:focus-visible` shows a 2 px `#9bf6e4` outline with 2 px offset on buttons and inputs.
- **Announcements.** The HUD objective is `role="status" aria-live="polite"`; captions and the results section are `aria-live="polite"`; the boot-failure box is `role="alert"`.
- **Captions.** Text cues for all meaningful audio (off by default, toggle in Pause); invalid actions and hints always print regardless of the setting.
- **Contrast.** `#eafcff` on `#04131b` for all text; High contrast mode raises membrane and nucleus opacity, rim brightness and drops decorative backdrops; the colour-vision-safe palette swaps to the Okabe–Ito set, and ownership is also shown by the rim (player only) and shape (barb star).
- **Reduced motion.** Removes breathing, pulses, spin, drift and shake, caps particle bursts; event timing unchanged.
- **Targets.** Action buttons are at least 64×44 CSS px with 8 px gaps; list buttons are 44+ px tall; the tray sits inside `env(safe-area-inset-*)`.
- **Failure states.** WebGL missing shows an explanation instead of a blank page; a blocked module shows the boot-failure alert with a Reload button.

## 12. StarHermit integration

Manifest `starhermit.txt`: `name=Cellular Drift`, `launch=index.html`, `owner=…`, `cover=coverart.png`, `server=server.js`.

| Platform feature (wiki.starhermit.com conventions) | Used | How |
|---|---|---|
| Launch manifest and cover | yes | `starhermit.txt`, `coverart.png` 1200×675 |
| Server script | yes | `server.js`: same-origin static hosting with `Cache-Control: no-cache` + ETag revalidation, refuses `tests/`, `tools/`, `node_modules/` and dotfiles; `GET /api/v1/time` → `{now}`; `POST /api/v1/scores` (≤ 16 KB JSON, in-memory ring of 10 000); `GET /api/v1/scores?content=<id>` |
| Server time | yes | `platform.syncTime()` at boot with a 2.5 s abort; the daily descriptor is chosen from server-adjusted time; falls back to the local clock |
| Score submission | yes | every terminal round posts `{contentId, score, objective, invalid, durationMs, sessionId}`; a copy goes to the local board in `localStorage` |
| Launch token / identity | yes | `#game_token=<jwt>` read from the URL fragment (stripped after the read; query `?token=` kept for local dev), decoded for `sub` + `game_scope` (never hard-coded), kept in memory only and sent as `Authorization: Bearer`; re-minted every 45 min via `POST /api/v1/games/{slug}/launch-token` (60 s retry). Hosted mode activates iff a token was read |
| Profile / account line | yes | `GET /api/v1/users/{sub}/profile` → nickname (never usernames, never `/api/v1/me`; `Player <id8>` fallback); the title screen shows "Playing as <nickname> · sync status". Offline the line says progress stays on this device |
| Server time | yes | `platform.syncTime()` at boot with a 2.5 s abort; the daily descriptor is chosen from server-adjusted time; falls back to the local clock |
| Score submission | yes | every terminal round posts `{contentId, score, objective, invalid, durationMs, sessionId}` (Bearer when hosted) to the own-server route; a copy goes to the local board in `localStorage`; failures are swallowed silently (no console errors when the route 404s off-platform) |
| Leaderboard display, friends boards | no | entries are submitted and stored but no screen reads them |
| Achievements | local | six idempotent keys (`first-round`, `first-goal`, `first-win`, `rounds-25`, `cells-250`, `splits-100`) unlock from lifetime stats at round end, play the `achievement` clip, and are stored in the save document — no platform unlock endpoint |
| Realtime rooms, invitations, chat, voice, relay | no | single-player only; rivals are local AI |
| Cloud save | yes | the checksummed save doc mirrors to one zip+base64 slot at `GET/PUT /api/v1/me/cloud-saves/{slug}`: remote wins on boot (validated through `CDStore.loadRaw`), saves debounce 2 s and flush on `pagehide`/hidden with keepalive, and the title line shows sync status. localStorage stays the offline cache |

## 13. Technical architecture

- **Boot** (`app.js boot`): clear body → create canvas → `createRenderer` (compat panel on throw) → `createAudio(settings)` → `createPlatform().syncTime()` → build every screen → apply presentation settings → wire input → `requestAnimationFrame(frame)` → `data-cd-booted` clears the watchdog.
- **Loop** (`frame`): accumulate `dt·1000` ms; while ≥ 33.3 ms and fewer than 8 steps: `R.step`, `renderer.syncState`, `afterTick` (stat-diff audio, intensity, danger ping); then `renderer.draw(alpha, dt, focus, 'p0')`, `updateHUD`, and `showResults` once on terminal.
- **Rules isolation.** `rules.js` and `content.js` are UMD and DOM-free; Node tests `require`/import them directly. Rendering only reads snapshots; the only mutation path is `applyCommand`.
- **Replay/determinism.** `serialize`/`deserialize` round-trip the full state including `rngState` and the duplicate-id ring; `stateHash` is the verification key. `tests/rules-regression.mjs` proves two seeded runs with identical commands hash identically.
- **Persistence** (`store.js`): key `cellulardrift.save.v1` holds `{sum, payload}` where `sum` is FNV-1a of the payload; a checksum mismatch or a newer `v` yields a fresh document; a memory fallback keeps the session working without `localStorage`. Boards live under `cellulardrift.leaderboards.v1`.
- **Renderer budgets.** Pooled cell views per entity id (max 16 cells × up to 11 players), instanced motes (420) and pellets (160), one `Points` for decor and one for FX; environment rebuilt only when the arena radius or theme/contrast changes. DPR capped by tier. `webglcontextlost` is intercepted (`preventDefault`); no automatic rebuild is attempted.
- **Server.** Zero-dependency `node:http`; `PORT` env (default 8080, `0` = ephemeral, which the e2e uses); MIME for html/js/css/json/svg/png/webp/ico/opus; binary responses go out as Buffers.
- **e2e driving.** `tests/e2e.mjs` imports `server.js`, launches system Chrome via `playwright-core`, and only clicks visible controls; `window.CDApp.debug()` is a read-only probe used to assert rules-vs-render agreement (player colour pixels at the projected centroid) and simulation liveness.

## 14. Testing and acceptance criteria

`npm test` (`tests/rules-regression.mjs`) verifies: identical seeded command streams give identical `stateHash`; a duplicate command id is rejected after serialize/deserialize; the Gentle Giant constraint ends the round on a rival absorb and adds prey mass exactly once; every lesson, journey stage, practice preset, challenge and today's daily passes `validateContent` (bounds, a hint-driven bot finishes within the tick cap, no elimination without rivals, no NaN).

`npm run test:e2e` (`tests/e2e.mjs`, ~5 min) verifies, on desktop 1280×800, 1280×600, phone portrait 390×844 @3x touch and phone landscape 844×390 @3x touch: every `index.html` asset reference shares one version tag and is served with `no-cache` + ETag → 304; blocking `render.js` produces the boot-failure alert; title, help, mode select, all five lists (journey ≥ 20 items and wheel-scrollable to the end), HUD, pause and results have no layout defects; Practice "Calm" renders the player cell in the theme colour at the rules-reported position and the tick counter advances ≥ 15 per second; pointer, touch and ArrowLeft steering move the centroid; Space/E at start mass are rejected without errors and Hint produces a caption; pause stops the tick counter, sliders and checkboxes work, Esc toggles, Restart resets, Leave ends the session; Lesson 1 is played to `goal-complete` through the real pointer, the results headline and total appear, Retry starts a new round, the lesson shows "done"; Journey, Daily and Challenge rounds start and render; content validation passes in the browser; zero console errors, warnings, failed requests or HTTP ≥ 400.

QA bar (agents/qa.md) as checkable statements: (1) Lesson 1's brief tells a new player how to move and what to reach; each lesson brief names its new mechanic; Hint is available in every round. (2) Every feature exposed by the UI is exercised by clicks in `tests/e2e.mjs`. (3) No console error or warning occurs during the e2e run. (4) No text or control is cut off at any of the four viewports. (5) Time sync and score submission use the platform server routes.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `coverart.png` (1200×675, 256-colour PNG, 203 KB) | platform cover | FLUX.2 klein, seed 9701, 1200×688 cropped | generated in this pass (replaced generic placeholder) |
| `assets/title-backdrop.webp` (1536×864, 18 KB) | title screen backdrop | FLUX.2 klein, seed 9702 | generated in this pass, wired in `css/style.css` |
| `assets/results-vignette.webp` (768×432, 13 KB) | results overlay hero | FLUX.2 klein, seed 9703 | generated in this pass, wired in `app.js showResults` |
| `icon.png` (256×256), `favicon.svg` | launcher / tab icons | authored earlier | shipped |
| `sfx/ui-tick.opus` … `sfx/achievement-unlock.opus` (15 clips) | event SFX, see §9 | MOSS-SoundEffect v2, 100 steps | shipped |
| `sfx/cell-merge.opus`, `sfx/hint-ping.opus` | merge and hint cues | MOSS-SoundEffect v2, 100 steps | generated in this pass, wired |
| `sfx/ambience-medium.opus` (12 s loop) | ambience bed | MOSS-SoundEffect v2, 100 steps | generated in this pass, wired |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | canonical table / generator input / generated table | — | shipped |
| 3D models, character animation | — | — | none by design (procedural geometry, no humanoid) |

## 16. Known limitations

- English only; no string table (§10).
- `countdown` and `rewind` clips are bound in `audio.js` but no code path triggers them; the `achievement` clip now plays on local unlocks.
- Scores are posted and stored locally but no screen shows a leaderboard; the server store is in-memory and lost on restart; submissions are not validated server-side.
- Settings `graphicsTier`, `theme`, `largeText`, `leftHanded`, `haptics`, `boardMirror` and `confirmActions` are persisted with defaults but have no UI and (except `graphicsTier`/`theme`) no effect.
- The `voice` bus and its slider control nothing audible.
- `surrender` exists in the rules but has no control; Leave to modes simply discards the round.
- Lesson 3's brief mentions "the marker cell"; the goal is simply to eject 5 pellets and no target cell is drawn.
- Practice sets `allowRewind` but there is no rewind/undo.
- A lost WebGL context is not rebuilt; reload is required.
- The daily uses server time when `/api/v1/time` answers; on static hosting it silently uses the device clock.
- Rival AI evaluates only the first 40 motes and its largest cell; it never ejects.

### Design intent not yet implemented

1. Localization into en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT via a string table keyed by id, chosen from `navigator.languages` with a setting override.
2. A 3-2-1 countdown before ranked (daily) rounds using the `countdown` cue.
3. Practice rewind (5 s state snapshot ring) using the `rewind` cue.
4. Achievements: first lesson set complete, first split-kill, 7-day daily streak, all mastery stages, 1 000 lifetime cells absorbed — unlocked idempotently with the `achievement` cue.
5. A daily leaderboard screen reading `/api/v1/scores?content=<daily id>` with the store's tie-break order, and a friends filter once identity is wired.
6. Pause-menu controls for graphics tier and theme.
