# Cellular Drift — Game Design Document (running spec)

This document describes Cellular Drift as it ships today: a StarHermit engine script game (engine 1.17.0, host API 1.19), played natively by the StarHermit client and in browsers by the engine's web runtime. Present tense throughout; where the design calls for something the code does not yet do, it is listed under "Design intent not yet implemented" at the end and nowhere else.

## 1. Overview

**Pitch.** You are one translucent cell in a lit petri dish. Drift toward the pointer (or steer with keys or a stick), graze on nutrient motes, split to lunge, eject to shed weight, and outgrow the rivals that hunt you — before a barb bursts you or the clock runs out.

| | |
|---|---|
| Genre | Realtime mass arena, single player versus seeded AI rivals |
| Players | 1 human (`p0`) plus 0–10 AI rivals per content item |
| Session | 30 s (Lesson 1) to 4 min (Apex Culture); rounds hard-capped at 30 sim-minutes |
| Platforms | StarHermit client (Windows/Linux, native engine) and browsers (engine web runtime); desktop, phone portrait and landscape; keyboard, mouse, touch, gamepad |
| Rendering | `starhermit:scene` (three.js-like): orthographic top-down camera, WGSL caustic and rim-halo shaders, renderer bloom / grade / anti-aliasing per graphics level; `starhermit:ui` immediate-mode menus and HUD |
| Simulation | The runtime's fixed steps at the rules' 30 Hz (`setFixedRate(R.TICK_RATE)`), deterministic `js/rules.js`; rendering interpolates between ticks |
| Persistence | The engine save (`starhermit:storage` `saves`, `{ v: 1, progress }`, device + cloud slot), the game's settings (`settings`, synced), the device round board (`storage`) |
| Server | `score-script.js` — StarHermit platform script that range-checks and posts finished rounds to the `high-score` board; `server.js` — local dev server only (static files, `/api/v1/time`) |

### File map

| Path | Responsibility |
|---|---|
| `starhermit.txt` | Manifest: name, description, owner, cover, `server=score-script.js`, `launch=index.html`, `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.17.0`, `engine.minor=17`, `engine.capabilities=platform,storage,clipboard`, `control.*` keys, `engine.group.*`, `engine.gamepad.*` |
| `index.html`, `starhermit-files.json` | The engine's web loader page and file index, written by `npm run package` (`starhermit package --web .`); never edited by hand |
| `native/main.ts` | Entry: screen flow, `startRound` for every mode, steering (pointer, keys, stick), Split / Eject / Hint, per-tick stat diffs → audio and shake, music intensity and danger ping, results with progression, achievements, the device board and score posting, lifecycle |
| `native/screens.ts` | Every screen and the HUD in `starhermit:ui`, the toast and caption strip, the results vignette and the drawn medal |
| `native/render.ts` | The dish on `starhermit:scene`: floor canvas texture, caustics, rim and halo, rings, pooled cell views, instanced motes and pellets, barbs, plankton, burst particles, marker and hint rings, camera follow / zoom / shake, look per graphics level |
| `native/audio.ts` | One-shot clips on the runtime's buses, the ambience loop, the adaptive pentatonic pad rendered into clips, captions |
| `native/platform.ts` | Save, conflict merge and the browser build's foreign save; game settings and legacy settings migration; device board; platform clock; player, invite link; score posting |
| `native/quality.ts` | The browser build's graphics presets and budgets keyed by the runtime's quality tier and level |
| `native/style.ts`, `assets/ui-style.json`, `tools/ui-style.css` | The UI style sheet (class-based CSS converted with `starhermit css`), tokens and the high-contrast token set |
| `native/i18n.ts` | Locale from the runtime's interface language, `T()` over `js/strings.js` |
| `native/classic.ts` | Loads the classic UMD scripts (`loadClassic`) with a `localStorage` shim over device storage, types for what the client reads |
| `js/rng.js`, `js/rules.js`, `js/content.js`, `js/store.js` | Unchanged browser-build rules engine, content, save document and merge (UMD; shared with the Node tests) |
| `js/migrate.js` | The engine save document and the browser build's account data (foreign save, legacy settings) as the engine client takes them over |
| `js/strings.js` | Translation tables (English text is the key) for the nine locales |
| `sfx/` | 18 Opus clips; `manifest.txt` (canonical), `manifest.json`, `manifest.md` |
| `assets/` | `title-backdrop.webp`, `results-vignette.webp`, `ui-style.json` |
| `cover.jpg`, `coverart.png`, `icon.png` | Platform cover, cover art, icon |
| `tests/` | `npm test`: i18n, migration, rules regression, `native.mjs` (tsc, `starhermit check`, play scripts, web index) |
| `tools/` | `package-web.mjs`, `css.mjs`, `plan.mjs` (keyboard bot), `gen-plays.mjs` (play scripts from plans), `browser-play.mjs` (headless Chrome) |

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

`createGame` hashes a string seed with FNV-1a; the rules stream starts at `seed ^ 0x9e3779b9` and is stored in `state.rngState`, so `serialize()` captures everything. Content seeds are literal strings (`'lesson-1'`, `'journey-17'`, `'daily:2026-09-08'`, `'practice-calm'`, `'challenge-apex'`). Rival names, skills and hues come from a separate LCG on `hashString('names:' + seed)`. `native/render.ts` derives decor blotches and drift particles from `game.seed`; `native/audio.ts` seeds ±6 % pitch variants from it. `stateHash` covers tick, phase, rng, entity ids/positions/masses (×1000 rounded), and player alive/invalid counts.

### Hints and undo

`hint(state, p0)`: flee if a bigger cell is within 200 units → hunt/split if an edible cell is within 260 (split when 2.6× and within 150 and legal) → graze the nearest mote to the centroid → "drift". The same function drives the content validator bot and adaptive music intensity. There is no undo; `allowRewind` is set for practice but nothing consumes it.

## 5. Modes and progression

All modes funnel through `startRound(content, mode)`; `content.toConfig` turns a descriptor into a rules config with `rivalSet(seed, count, skill, ±0.12)`.

| Mode | Content | Differences | Progress stored |
|---|---|---|---|
| Learn | 6 lessons (`LESSONS`): Drift, Graze, Eject, Divide, Barbs, Hunt | 0 rivals except Hunt (2 at skill 0.2); small arenas 320–520; 1–4 min limits | `lessonsDone[id]` on win |
| Journey | 40 generated stages `j01..j40`, 8 per theme tier; every 8th is a mastery stage | arena `560 + 40·tier`, goal `80 + 25·tier + 8·step` (×1.35 mastery), rivals 0→4 (+2 mastery, max 6), skill 0.25→0.83, barbs 0→5 | `journeyStars[id]` (1–3), `journeyBest[id]` |
| Daily Challenge | `dailyFor(platform.now())`: one descriptor per UTC day of the platform clock (`serverNow`; the device's UTC date offline), `ranked: true` | arena 580–700, 130–170 motes, 3–6 rivals at skill 0.4–0.7, 2–6 barbs, 3 min, goal 140–220, theme by hash | `dailiesDone[day]` = best score, `dailyStreak {last, count}` (consecutive UTC days) |
| Practice | Calm / Standard / Expert presets | 1/3/6 rivals at 0.25/0.5/0.75, 1/3/6 barbs, goals 100/160/220; never ranked | `practiceDone[id]` |
| Challenge | Lean Drift (no eject), Sprint Culture (75 s), Crowded Dish (10 rivals), Barb Garden (12 barbs), Gentle Giant (no rival absorbs), Apex Culture (absorb 8) | per-item constraints via `ejectDisabled`, `durationTicks`, `noRivalAbsorb`, goal type | `challengeDone[id]`, `challengeBest[id]` |

Difficulty curve: tier 0 (Lagoon) teaches grazing alone, a single timid rival appears at stage 6; tier 1 (Amethyst) is 1–2 rivals; tier 2 (Verdant) adds 2–5 barbs; tier 3 (Cinder) has 2–3 rivals plus barbs at skill 0.45+; tier 4 (Aurora) is 3–4 rivals at 0.55–0.83 with 3–5 barbs and goals up to 297 at the mastery stage. Nothing is locked: every list is fully selectable; badges show completion. Lifetime stats (`rounds`, `goals`, `wins`, `massAbsorbed`, `cellsAbsorbed`, `splits`, `playMs`) accumulate in the save document.


## 6. Controls and interaction

Actions are declared in `starhermit.txt`; players rebind keys and pads in the runtime's Options (F1 natively). The game reads actions, never keys.

| Action | Keyboard | Gamepad | Touch / mouse | Effect / feedback |
|---|---|---|---|---|
| Steer (`up`/`down`/`left`/`right`, group "Steering") | Arrow keys / WASD | Left stick / D-pad | the pointer over the dish (no button needed); a touch drag or tap on the dish | keys and stick set the target 260 units from the centroid in the held direction before every tick (stick magnitude scales it); a pointer move sets the target to the dish point under it, except over the HUD's Pause button and action tray |
| `split` (group "Actions") | Space | South (A) | HUD **Split** | `cell-split` cue; button disabled when illegal; a refused press prints the reason in the caption strip |
| `eject` | E | West (X) | HUD **Eject** | `mass-eject` cue, pellet toward the target |
| `hint` | H | North (Y) | HUD **Hint** | `hint-ping` cue, cyan ring for 2.6 s, one-line caption |
| `pause` | Esc / P | Start | HUD **Pause** | pauses / resumes; on menu screens it goes one screen back (results → modes) |
| Menus | Tab / arrows / Enter | D-pad / South | tap / click | the first control of every screen is focused; the HUD never keeps focus (Space stays Split) |

Steering, Split, Eject and Hint act only while the round runs unpaused on the HUD. A hidden window or tab pauses the round (pause screen) and stops the pad. The simulation advances only on the runtime's fixed steps, so a slow frame or a suspended page never fast-forwards the round.

## 7. Screens and UI flow

`title` ⇄ `help`; `title` → `modes` → {`lessons` | `journey` | `daily` | `practice` | `challenge`} → `hud` ⇄ `pause` → (`hud` restart | `modes` leave); `hud` → `result` → (`hud` retry | `modes`). One screen shows at a time (`app.screen`).

- **Title** over the title backdrop and a light scrim: wordmark, tagline, the account line ("Offline — progress saves on this device." for guests, "Playing as <name> · progress synced / saving… / cloud sync unavailable" signed in), Play, Help & rules, Options (the runtime's menu), Invite a friend (signed in; copies the link with a toast), Sign in with StarHermit (guests; the runtime's sign-in).
- **Mode select**, **lesson / Journey / practice / challenge lists** (name, brief or description, "mastery stage", the done mark and Journey stars), **daily setup** ("<Daily Culture — date> — reach N mass in 3 minutes. Ranked.", Begin the day). Every list button is at most 420 px wide.
- **HUD**: objective (brief + goal) and progress ("Mass n / goal · m:ss · Rank r/n") top-left at most 70 ch wide; Pause right below it on the right; the Split / Eject / Hint tray bottom-right (64 × 44 px minimum); captions centred above the tray.
- **Pause**: Resume, Restart round, Leave to modes, Options, the game's own toggles (Captions / text cues, Color-vision-safe palette) and a note that sound, graphics, language, controls, text size, high contrast and reduced motion are in the StarHermit Options.
- **Results**: the vignette art (dropped under high contrast or below 420 px of height), headline, the seven-line breakdown, total and rank, achievements unlocked (with a drawn medal), the leaderboard line when signed in, Retry, Back to modes.
- **Toast** at the bottom (at the top over pause and results).

Layout: every screen is a scrim over the dish with its column centred (at most 560 px, 16 px gutters, the safe area respected); a column taller than the window scrolls with its Back / Close / Retry buttons pinned below it. Sizes follow the runtime's interface scale and text size. Verified at 960 × 540 (play scripts), 1366 × 768, phone 390 × 844 and phone landscape 844 × 390 (`tools/browser-play.mjs`).

## 8. Art direction

**Palette** (from `content.js THEMES` and `tools/ui-style.css`): shell background `#04131b`, scrim `rgba(4,19,27,0.82)`, text `#eafcff`, accent `#4fd8c2` (buttons at 12 % fill / 55 % border, hover 25 %), focus ring `#9bf6e4`, goal marker `#fff3a0`, hint ring `#9be8ff`.

| Theme | bg / deep | membrane | player | motes | barb |
|---|---|---|---|---|---|
| Lagoon Culture | `#071c26` / `#03101a` | `#4fd8c2` | `#ffd166` | `#9bf6e4 #6ee7d8 #c5fff3` | `#ff6b81` |
| Amethyst Depth | `#170f2b` / `#0b0618` | `#9b7bff` | `#7be0ad` | `#cbb7ff #a88fe8 #e3d8ff` | `#ff8f5c` |
| Verdant Bloom | `#0c2013` / `#04100a` | `#7fd069` | `#6ec9ff` | `#b9f0a4 #8fd97a #dcf7cd` | `#ffb347` |
| Cinder Field | `#241016` / `#120508` | `#ff7a66` | `#7ad7f0` | `#ffb09a #ff8d75 #ffd6c8` | `#ffd23f` |
| Aurora Veil | `#0a1a2b` / `#050d18` | `#5fb4ff` | `#f9f871` | `#a5d8ff #7cc4f5 #d0ebff` | `#ff6fd8` |

The colour-vision-safe palette (the game's setting) replaces membrane/player/barb/motes with `#0072B2 / #E69F00 / #D55E00 / #56B4E9 #F0E442 #CC79A7`. Rival hues come from the seed at HSL(hue, 0.62, 0.55); the player's cells carry a pulsing rim in the player colour — the only entity with one.

**Shape language.** Cells are flattened spheres (z × 0.42) with a 30 %-opacity nucleus; motes and pellets are low-segment spheres; the dish is a circle with a 5-unit glowing rim, a soft halo and four faint concentric rings; the only spiky silhouette is the 9-point extruded barb star. Menus use 10 px radii and thin accent borders.

**Lighting and camera.** ACES tone mapping at exposure 1.05; a pale fill light from the camera's side (the browser build's hemisphere fill), a 0.3 ambient and one warm key from the upper left (intensities three.js's ÷ π); membranes are Lambert, standard or physical (clearcoat) by budget, with a WGSL fresnel edge light; motes and pellets are emissive. The key light casts shadows of motes, pellets and barbs on the floor (the floor's light hook darkens it by 42 % of the shadow); each cell lays a soft disc where its shadow falls (the engine's shadow pass leaves the translucent membranes out). With reflections the room environment (`PMREMGenerator.fromScene(new RoomEnvironment())`) lights the scene at `environmentIntensity` 0.3. The orthographic camera follows the centroid with critically damped smoothing (stiffness 6.5), zooms out with the largest cell (`46 + 28.8·r` half-height, 80–900), frames the lesson marker with the player, and shakes on absorbing a rival (2.5) and bursting (4).

**Motion.** Membranes breathe ±2 %, motes pulse ±12 %, barbs spin 0.35 rad/s, plankton drift 0.008 rad/s, the marker pulses ±8 %, the caustic shimmer drifts. Vanished entities pop into 4 (mote) or 14 (cell) soft particles from a pool bounded by the budget. The runtime's Reduced motion removes breathing, pulses, spin, drift, caustic motion and shake and caps bursts at 3.

**Graphics levels.** The runtime's Graphics options (Auto or a level) give `frame().quality` and `levelIndex`; `native/quality.ts` maps them to the browser build's presets:

| | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Key-light shadow map | off | 1024 | 2048 | 4096 (held to the level's size) |
| Bloom (strength 0.45, radius 0.2, threshold 0.9) · grade | – | on | on | on |
| Anti-aliasing | MSAA | FXAA | SMAA | MSAA |
| Reflections (room environment) | – | on | on | on |
| Caustic shimmer · detailed floor (lamp pool, ghost walls, glass light, grain) | – | on | on | on |
| Floor texture (detailed; plain = half) | 512 | 1024 | 1024 | 2048 |
| Membrane segments · material | 16×10 Lambert | 24×16 standard | 28×20 physical | 40×28 physical |
| Burst particles · plankton (×1.64 per level above the tier's first, ≤ 4×, Particles cap 300/60 or 1200/480) | 200 · 50 | 500 · 120 | 900 · 200 | 1200 · 320 |

The grade is display-space: contrast 0.11, saturation 1.1, cool shadows / warm highlights (split 0.25–0.85), vignette 0.26 (0.38–0.9, scale 1 × 0.9). Render scale, resolution, adaptive resolution, the frame-rate limit and readout belong to the runtime.

**Visual assets**: `coverart.png` / `cover.jpg` (platform cover), `assets/title-backdrop.webp` (title, under the scrim; a plain scrim under high contrast), `assets/results-vignette.webp` (results hero, rounded corners). No mesh assets: everything else is procedural.

## 9. Audio direction

**Mix.** The runtime's buses: music (the pad, at the old 60 % bus level), effects (event clips at 90 %, ambience loop at 0.8 × 50 %), interface (the menu tick). Volumes, mute and the voice limit are the runtime's Options. In browsers sound starts after the first press. Clips load one at a time once the mixer runs.

**Music.** A minor-pentatonic pad over G3 stepping every 420 ms (degree `(3s + s>>2) mod 7`, an octave down on steps 4–7 of 8), rendered once into clips (sine + 2.01× overtone, 12 ms attack, exponential decay) in a calm (1.46 s) and a tense (0.9 s) length; gain `0.07 + 0.05·intensity`; a triangle drone at G2 every other step above intensity 0.45. Intensity is 1 while the hint says flee, else `0.2 + 0.5·mass/goal`, updated every 15 ticks. The pad stops while the window is hidden.

**Ambience.** `ambience-medium.opus`, a 12 s loop, from the first unlocked frame.

**SFX event table** (`sfx/manifest.txt`; every id is a `native/audio.ts` event):

| Event id | File | Usage |
|---|---|---|
| `ui` | `ui-tick.opus` | every menu button, Pause, Resume |
| `absorb` | `mote-absorb.opus` | player's `motes` stat rose this tick |
| `pellet` | `pellet-gulp.opus` | player's `pellets` stat rose |
| `absorbBig` | `cell-absorb-big.opus` | player absorbed a rival cell; shake 2.5 |
| `split` | `cell-split.opus` | player split executed |
| `eject` | `mass-eject.opus` | player ejected |
| `burst` | `barb-burst.opus` | a player cell burst on a barb; shake 4 |
| `danger` | `danger-ping.opus` | hint action is flee; at most one per 66 ticks (2.2 s) |
| `merge` | `cell-merge.opus` | split halves recombined |
| `hint` | `hint-ping.opus` | Hint pressed |
| `go` | `round-start-go.opus` | every round start, Retry, Restart |
| `win` / `lose` / `timeup` | `goal-win.opus` / `round-lose.opus` / `time-up.opus` | results by terminal reason |
| `achievement` | `achievement-unlock.opus` | a local achievement unlocked |
| `countdown`, `rewind` | `countdown-beep.opus`, `time-rewind.opus` | loaded; no trigger yet (intent) |

Pitch variants (±6 %) come from an LCG seeded by the round seed. Captions: with Captions on (pause screen), each event's text ("absorbed a mote", "cells recombined", …, translated) shows in the caption strip for 1.6 s and is announced to screen readers.

## 10. Localization

Nine locales: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**. The locale is the runtime's interface language (`preferences().language`: the player's choice in Options › Language, else the account's preferred language or the device's), mapped to the nearest shipped locale (`es-MX → es-419`, `en-AU → en-GB`, `pt-PT → pt-BR`), and follows changes live (the UI is rebuilt every frame). `js/strings.js` holds one row per English key with es-419, de-DE, fr-FR, pt-BR and it-IT; en-GB, es-ES and fr-CA list only their differences; `T()` falls back regional → parent → English and fills `{name}` placeholders. Every player-facing string goes through it, including content names and briefs, hint texts, refused-action reasons, captions, account, invite and leaderboard lines. "Cellular Drift" and rival names stay as they are. `tests/i18n.test.mjs` collects every key from `native/*.ts` (`T(…)`, `N(…)`), the captions, the content and the rules' hints, and fails when a locale lacks one or a translation drops a placeholder.

## 11. Accessibility

- **Keyboard and pad**: every screen focuses its first control; Tab / arrows / Enter and the pad navigate; in play, steering, Split, Eject, Hint and Pause are actions; the HUD drops focus so Space stays Split.
- **The runtime's accessibility options** apply: interface and text size (layouts measure text and follow the scale), high contrast (denser scrims, brighter borders and ink, opaque membranes, stronger rings, no decorative art), reduced motion (see §8).
- **Game options**: Captions / text cues, Color-vision-safe palette (Okabe–Ito). Ownership also shows by the rim (player only) and shape (barb star).
- **Announcements**: toasts, hints, refused actions and captions go to `ui.announce`.
- **Targets**: action buttons ≥ 64 × 44 px with 8 px gaps; list buttons ≥ 44 px tall; the tray sits inside the safe area.

## 12. StarHermit integration

| Feature | How |
|---|---|
| Manifest, cover, loader | `starhermit.txt` (engine pin 1.17.0, minor 17, capabilities platform, storage, clipboard); `index.html` + `starhermit-files.json` from `npm run package` |
| Player | `player()`; signing in and out is the runtime's (Sign in with StarHermit calls `requestSignIn`); a session ending shows a toast |
| Cloud save | `saves`: `{ v: 1, progress }`, saved at every round's end; a conflict merges both devices' progress (`CDStore.mergeProgress`: better stars and bests, every done mark, larger lifetime counters, earliest achievements, later daily streak); a save another device wrote is merged in |
| Browser-build migration | the JS SDK's slot `game:<slug>` (checksummed `{ sum, payload }` document) shows as foreign: its progress is merged and replaced once (`replaceForeign`), its captions / palette / theme kept where the account has none; the old per-player settings keys are imported the same way and removed (`settings.legacyKeys`, `removeLegacy`) |
| Game settings | `settings` (game.captions, game.cvdPalette, game.theme), synced with the account |
| Options | volumes, mute, voice limit, graphics level, frame rate, language, controls, accessibility: the runtime's menu (Options buttons call `openMenu`) |
| Platform clock | the daily's day from `serverNow()` (read at start and on player change), the device's UTC date while unknown |
| Leaderboard | signed in, every finished round outside Learn posts its total through `score-script.js` (a practice session whose socket sends `{ type: 'result', scores: { 'high-score': total } }`); the results show posting / rank #N / posted / not posted |
| Invite | signed in, Invite a friend copies `inviteLink()` with the clipboard capability |
| Device round board | every round goes to `cellulardrift.leaderboards.v1` in device storage (newest 200) |
| Achievements | local (six keys in the progress); no platform achievements |
| Sessions, matchmaking, chat, replays, realtime, voice | not used: single player |

## 13. Technical architecture

- **Boot** (`onStart`): fixed rate 30 Hz, styles, platform (save, foreign migration, settings, invite, server time), presentation settings, graphics look, audio clip queue, art, title.
- **Loop**: `onFixedUpdate` (one tick while the round runs unpaused on the HUD: stick/keys steering → `R.step` → `render.syncState` → `afterTick`, results on terminal); `onUpdate` (look per graphics level, audio, timers, HUD focus); `onRender` (screens, then the dish with the interpolation alpha).
- **Rules isolation**: `js/rules.js` and `js/content.js` are unchanged UMD, loaded with `loadClassic`; the only mutation path is `applyCommand`; render reads snapshots.
- **Determinism**: same seed and commands give the same `stateHash` (`tests/rules-regression.mjs`); play scripts reproduce the bot's planned scores exactly.

## 14. Testing and acceptance criteria

`npm test` runs `tests/i18n.test.mjs`, `tests/migrate.test.mjs` (foreign save read and merged, corrupt / future refused, the engine save round trip, the two-device merge, settings kept or dropped), `tests/rules-regression.mjs` (determinism, duplicate rejection, the constraint rule, all content validated), then `tests/native.mjs`: the web index matches the files, `tsc` (strict, with the runtime's declarations), `starhermit check .` with no warnings, and the play scripts as signed-out render checks:

- `learn-lessons.play` — Drift to the marker, Graze to 60 (planned score expected), results, done marks.
- `learn-actions.play` — Eject (E presses) and Divide (Space) lessons to their planned scores, Retry, pause, Leave.
- `journey-stage.play` — stage 1 to 80 mass inside par, the list shows "done ★ ★ ★".
- `practice-pause.play` — Calm: hint caption, refused split, pause options, palette toggle, Resume, Restart, Leave, Help.
- `daily-challenge.play` — the daily started, paused, left; Lean Drift's refused eject.

The scripts are written by `node tools/gen-plays.mjs` from `tools/plan.mjs` (a keyboard bot over the rules that simulates the play-script timing). `npm run test:browser` (`tools/browser-play.mjs`) plays the packaged loader in headless Chrome at desktop, phone and phone landscape, by keys and taps, failing on console errors or warnings or the runtime's error screen.

## 15. Asset inventory

| Path | Purpose | Source |
|---|---|---|
| `coverart.png`, `cover.jpg` | platform cover | FLUX.2 klein, seed 9701 |
| `assets/title-backdrop.webp` | title backdrop | FLUX.2 klein, seed 9702 |
| `assets/results-vignette.webp` | results hero | FLUX.2 klein, seed 9703 |
| `icon.png` | launcher icon | authored |
| `sfx/*.opus` (18 clips) | event SFX and ambience, see §9 | MOSS-SoundEffect v2 |
| `assets/ui-style.json` | UI styles | `npm run css` from `tools/ui-style.css` |

## 16. Known limitations

- `countdown` and `rewind` clips are loaded but no code path triggers them.
- No in-game screen lists leaderboard entries; the results show only the player's own rank; `score-script.js` only range-checks the total.
- The theme setting has no UI (rounds use their content's theme).
- `surrender` exists in the rules but has no control; Leave to modes discards the round.
- Lesson 3's brief mentions "the marker cell"; the goal is simply to eject 5 pellets and no target cell is drawn.
- Practice sets `allowRewind` but there is no rewind.
- Rival AI evaluates only the first 40 motes and its largest cell; it never ejects.
- Lesson 1's objective repeats "Move to the glowing marker." (the brief already ends with it).
- Membrane iridescence and sheen (three.js physical material) are not drawn; cells' shadows are soft discs, not the key light's shadow map (the engine leaves transparent materials out of shadow maps).
- Progress a guest kept in the browser build's `localStorage` cannot migrate (only the account's cloud save does).
- The leftHanded, haptics, boardMirror and confirmActions settings of the browser build (never wired) and its own graphics, sound and language panels are gone; the runtime's Options replace the latter.

### Design intent not yet implemented

1. A 3-2-1 countdown before ranked (daily) rounds using the `countdown` cue.
2. Practice rewind (5 s state snapshot ring) using the `rewind` cue.
3. Further achievements: first split-kill, 7-day daily streak, all mastery stages, 1 000 lifetime cells absorbed.
4. A daily leaderboard screen with the store's tie-break order, and a friends filter.
5. A pause-menu control for the theme.
