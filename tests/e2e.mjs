/**
 * Cellular Drift — end-to-end QA playthrough (tests/e2e.mjs, run via `npm run test:e2e`).
 *
 * Drives the real visible UI in headless Chrome (playwright-core + system Chrome)
 * against the REAL production server (server.js on an ephemeral port), so the
 * headers, MIME types and routing a player actually gets are what is tested.
 *
 * Four passes: desktop 1280x800, short desktop 1280x600 (docked devtools /
 * small laptop), phone portrait 390x844 @3x touch, phone landscape 844x390 @3x
 * touch. Console errors AND warnings fail the run (GPU/swiftshader noise filtered).
 *
 * What each pass proves, with real clicks/keys/pointer on visible elements:
 *   - BOOT: the title screen appears, the boot watchdog in index.html was
 *     cleared, and every asset reference in index.html carries the same version
 *     tag and is served with revalidation headers (a fresh index.html paired
 *     with stale CSS/modules is exactly what reproduced as "dark screen, nothing
 *     happens, UI cut off at the top").
 *   - LAYOUT: on EVERY screen (title, help, modes, all five mode lists, HUD,
 *     pause, results) no child starts above the viewport, nothing is clipped
 *     horizontally, and everything is reachable by scrolling the screen itself.
 *   - RENDER: the WebGL canvas is not a dark void: the player's cell is drawn,
 *     in the player colour, at the screen position the rules engine reports.
 *   - LIVENESS: the fixed-step simulation advances, pointer (and touch)
 *     steering moves the player, Split/Eject/Hint/keys are wired.
 *   - PLAYTHROUGH: lesson 1 is played to completion through the real UI and
 *     the results overlay appears with a headline, then Retry/Back work.
 *   - Pause overlay: settings controls, Resume, Restart, Leave, Esc.
 * Plus one deliberate failure: with a module blocked, the page must show the
 * boot-failure message rather than a silent dark screen.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'test-results', 'e2e');
const SHOT = (stage, vp) => path.join(SHOT_DIR, `${vp}-${stage}.png`);

process.env.PORT = '0'; // server.js listens on import; 0 = ephemeral
const { server } = await import('../server.js');

const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions|swiftshader/i;

const PASSES = [
  { label: 'desktop', viewport: { width: 1280, height: 800 } },
  { label: 'desktop-short', viewport: { width: 1280, height: 600 } },
  { label: 'phone-portrait', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true },
  { label: 'phone-landscape', viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true },
];

let base = '';
const step = async (name, fn) => { await fn(); console.log(`ok - ${name}`); };
const fail = (msg) => { throw new Error(msg); };

async function visibleScreen(page, cls) {
  await page.waitForSelector(`${cls}:visible`, { timeout: 10000 });
}

async function debug(page) {
  return page.evaluate(() => window.CDApp.debug());
}

// ---------- layout probe: nothing above the viewport, nothing clipped, all reachable
async function assertLayout(page, label, stage) {
  const problems = await page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const out = [];
    const screens = [...document.querySelectorAll('.cd-screen')].filter((s) => s.style.display !== 'none' && s.offsetParent !== null);
    if (screens.length !== 1) out.push(`expected exactly one visible screen, found ${screens.length}`);
    for (const s of screens) {
      const cls = s.className.replace('cd-screen', '').trim();
      s.scrollTop = 0;
      const kids = [...s.children];
      kids.forEach((k, i) => {
        const r = k.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const name = `${cls} child#${i} <${k.tagName.toLowerCase()}> "${(k.textContent || '').trim().slice(0, 30)}"`;
        if (r.top < -0.5) out.push(`${name} starts ABOVE the viewport (top=${r.top.toFixed(1)})`);
        if (r.left < -0.5 || r.right > vw + 0.5) out.push(`${name} clipped horizontally (left=${r.left.toFixed(1)}, right=${r.right.toFixed(1)}, vw=${vw})`);
        // reachable: within the container's scroll range
        if (k.offsetTop + k.offsetHeight > s.scrollHeight + 0.5) out.push(`${name} is beyond the scroll range`);
        if (getComputedStyle(s).position === 'absolute' && r.bottom > vh + 0.5 && s.scrollHeight <= s.clientHeight + 0.5) {
          out.push(`${name} extends below the viewport but the screen is not scrollable (bottom=${r.bottom.toFixed(1)}, vh=${vh})`);
        }
      });
      // scrolling to the end must bring the last child fully into view
      if (s.scrollHeight > s.clientHeight + 0.5) {
        s.scrollTop = s.scrollHeight;
        const last = kids[kids.length - 1].getBoundingClientRect();
        if (last.bottom > vh + 0.5) out.push(`${cls} last child still below the viewport after scrolling to the end (bottom=${last.bottom.toFixed(1)}, vh=${vh})`);
        s.scrollTop = 0;
      }
      // text must not be clipped inside its own box
      for (const t of s.querySelectorAll('button, h1, h2, p, dt, dd, span, div')) {
        if (t.children.length && t.tagName !== 'BUTTON') continue;
        if (t.scrollWidth > t.clientWidth + 1 && getComputedStyle(t).overflowX !== 'visible') out.push(`${cls} text overflow in <${t.tagName.toLowerCase()}> "${(t.textContent || '').trim().slice(0, 30)}"`);
      }
    }
    return out;
  });
  if (problems.length) fail(`[${label}] layout defects on ${stage}:\n  ` + problems.join('\n  '));
}

// ---------- render probe: is the player's cell actually drawn where the rules say?
async function assertPlayerRendered(page, label, stage) {
  const r = await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => {
      const d = window.CDApp.debug();
      const gl = document.getElementById('cd-canvas');
      const w = gl.clientWidth, h = gl.clientHeight;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.drawImage(gl, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h).data;
      const lum = (i) => (0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2]) / 255;
      // whole-frame stats on a coarse grid
      let bright = 0, samples = 0;
      for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) { samples++; if (lum((y * w + x) * 4) > 0.2) bright++; }
      // player cell: pixels of the theme's player hue within its radius around the projected centroid
      const hueOf = (r, g, b) => {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
        if (c === 0) return null;
        let hh = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
        return ((hh * 60) + 360) % 360;
      };
      const pc = d.playerColor || '#ffd166';
      const targetHue = hueOf(parseInt(pc.slice(1, 3), 16), parseInt(pc.slice(3, 5), 16), parseInt(pc.slice(5, 7), 16));
      let matched = 0, probed = 0;
      if (d.screen) {
        const rad = Math.max(3, Math.sqrt(d.mass) * 1.2 * (h / (2 * 120)) * 0.5);
        for (let dy = -rad; dy <= rad; dy += 1) for (let dx = -rad; dx <= rad; dx += 1) {
          const x = Math.round(d.screen.x + dx), y = Math.round(d.screen.y + dy);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          probed++;
          const i = (y * w + x) * 4;
          const hue = hueOf(img[i], img[i + 1], img[i + 2]);
          const sat = (Math.max(img[i], img[i + 1], img[i + 2]) - Math.min(img[i], img[i + 1], img[i + 2])) / 255;
          const dh = hue == null ? 999 : Math.min(Math.abs(hue - targetHue), 360 - Math.abs(hue - targetHue));
          if (lum(i) > 0.25 && sat > 0.12 && dh < 40) matched++;
        }
      }
      resolve({ w, h, brightFrac: bright / Math.max(1, samples), matched, probed, playerColor: pc, screen: d.screen, phase: d.phase });
    });
  }));
  if (r.w < 50 || r.h < 50) fail(`[${label}] ${stage}: canvas has no size (${r.w}x${r.h})`);
  if (r.brightFrac === 0) fail(`[${label}] ${stage}: canvas is a uniformly dark void (nothing rendered)`);
  if (!r.screen) fail(`[${label}] ${stage}: no player centroid to render`);
  if (r.matched === 0) fail(`[${label}] ${stage}: player cell (${r.playerColor}) not drawn at its projected position ${JSON.stringify(r.screen)} (probed ${r.probed}px, bright frame fraction ${r.brightFrac.toFixed(3)})`);
}

async function assertNoBootFailure(page, label) {
  const booted = await page.evaluate(() => document.body.getAttribute('data-cd-booted'));
  if (!booted) fail(`[${label}] app never marked itself booted`);
  if (await page.locator('.cd-bootfail').count()) fail(`[${label}] boot watchdog fired: ` + (await page.locator('.cd-bootfail').textContent()));
}

/** Click through: title -> mode select -> <modeBtnText> -> <itemBtnText> -> HUD, checking layout at every screen. */
async function startRoundVia(page, label, modeBtnText, itemBtnText) {
  await visibleScreen(page, '.cd-title');
  await page.locator('.cd-title .cd-play').click();
  await visibleScreen(page, '.cd-modesel');
  await page.locator('.cd-modesel .cd-modebtn').filter({ hasText: new RegExp(`^${modeBtnText}$`) }).click();
  const screenSel = { 'Journey': '.cd-journeylist', 'Learn': '.cd-lessonlist', 'Practice': '.cd-pracsel', 'Challenge': '.cd-challist', 'Daily Challenge': '.cd-dailysetup' }[modeBtnText];
  await visibleScreen(page, screenSel);
  await assertLayout(page, label, `${modeBtnText} list`);
  const item = page.locator(`${screenSel} .cd-itembtn`).filter({ hasText: itemBtnText }).first();
  await item.scrollIntoViewIfNeeded();
  await item.click();
  await visibleScreen(page, '.cd-hud');
  if (!(await page.locator('#cd-canvas').isVisible())) fail('game canvas not visible on HUD');
  await page.waitForTimeout(400);
  await assertLayout(page, label, `${modeBtnText} HUD`);
}

async function runPass(browser, pass) {
  const { label } = pass;
  const context = await browser.newContext({
    viewport: pass.viewport, deviceScaleFactor: pass.deviceScaleFactor || 1,
    hasTouch: !!pass.hasTouch, isMobile: !!pass.isMobile,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text())) errors.push(`[${label}] console.${m.type()}: ${m.text()}`);
  });
  page.on('requestfailed', (r) => errors.push(`[${label}] request failed: ${r.url()} ${r.failure() && r.failure().errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`[${label}] HTTP ${r.status()} ${r.url()}`); });

  await step(`${label}: cold load -> title screen, watchdog cleared`, async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await visibleScreen(page, '.cd-title');
    const title = await page.locator('.cd-title .cd-game-title').textContent();
    if (!/Cellular Drift/.test(title || '')) fail('game title missing');
    await assertNoBootFailure(page, label);
    await assertLayout(page, label, 'title');
    await page.screenshot({ path: SHOT('title', label) });
  });

  await step(`${label}: help screen`, async () => {
    await page.locator('.cd-title .cd-btn', { hasText: 'Help' }).click();
    await visibleScreen(page, '.cd-help');
    await assertLayout(page, label, 'help');
    await page.screenshot({ path: SHOT('help', label) });
    await page.locator('.cd-help .cd-btn', { hasText: 'Close' }).click();
    await visibleScreen(page, '.cd-title');
  });

  await step(`${label}: mode select + every mode list lays out`, async () => {
    await page.locator('.cd-title .cd-play').click();
    await visibleScreen(page, '.cd-modesel');
    await assertLayout(page, label, 'mode select');
    const modes = await page.locator('.cd-modesel .cd-modebtn:visible').allTextContents();
    for (const m of ['Learn', 'Journey', 'Daily Challenge', 'Practice', 'Challenge']) {
      if (!modes.some((t) => t.includes(m))) fail(`mode button missing: ${m}`);
    }
    await page.screenshot({ path: SHOT('modes', label) });
    const lists = { 'Learn': '.cd-lessonlist', 'Journey': '.cd-journeylist', 'Daily Challenge': '.cd-dailysetup', 'Practice': '.cd-pracsel', 'Challenge': '.cd-challist' };
    for (const [mode, sel] of Object.entries(lists)) {
      await page.locator('.cd-modesel .cd-modebtn').filter({ hasText: new RegExp(`^${mode}$`) }).click();
      await visibleScreen(page, sel);
      await assertLayout(page, label, `${mode} list`);
      if (mode === 'Journey') {
        const n = await page.locator(`${sel} .cd-itembtn`).count();
        if (n < 20) fail(`journey list too short: ${n}`);
        await page.screenshot({ path: SHOT('journey-list', label) });
        // a player scrolls the long list with the wheel and reaches the last stage
        await page.locator(sel).hover();
        for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 800);
        const last = page.locator(`${sel} .cd-itembtn`).last();
        const box = await last.boundingBox();
        if (!box || box.y + box.height > pass.viewport.height + 0.5 || box.y < 0) fail(`last journey stage not reachable by wheel scrolling: ${JSON.stringify(box)}`);
        await page.screenshot({ path: SHOT('journey-list-end', label) });
      }
      await page.locator(`${sel} .cd-backbtn`).click();
      await visibleScreen(page, '.cd-modesel');
    }
    await page.locator('.cd-modesel .cd-backbtn').click();
    await visibleScreen(page, '.cd-title');
  });

  await step(`${label}: practice "Calm" -> HUD renders the player, sim advances`, async () => {
    await startRoundVia(page, label, 'Practice', 'Calm');
    await page.screenshot({ path: SHOT('hud-practice', label) });
    const a = await debug(page);
    if (a.phase !== 'active') fail(`round not active after start: ${JSON.stringify(a)}`);
    await assertPlayerRendered(page, label, 'practice HUD');
    await page.waitForTimeout(1000);
    const b = await debug(page);
    if (b.tick - a.tick < 15) fail(`simulation not advancing: tick ${a.tick} -> ${b.tick} in 1s`);
    const prog = (await page.locator('.cd-hud .cd-progress').textContent()) || '';
    if (!/Mass \d+/.test(prog)) fail(`HUD progress not populated: "${prog}"`);
    const obj = (await page.locator('.cd-hud .cd-objective').textContent()) || '';
    if (!obj.trim()) fail('HUD objective never populated');
  });

  await step(`${label}: pointer steering moves the player; keys and action buttons are wired`, async () => {
    const box = await page.locator('#cd-canvas').boundingBox();
    const before = await debug(page);
    // steer to the right for a second
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.5, { steps: 6 });
    await page.waitForTimeout(1000);
    const after = await debug(page);
    if (!(after.centroid.x > before.centroid.x + 5)) fail(`pointer steering had no effect: x ${before.centroid.x.toFixed(1)} -> ${after.centroid.x.toFixed(1)}`);
    if (pass.hasTouch) {
      const b2 = await debug(page);
      await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.08); // up
      await page.waitForTimeout(800);
      const a2 = await debug(page);
      if (!(a2.centroid.y > b2.centroid.y + 3)) fail(`touch steering had no effect: y ${b2.centroid.y.toFixed(1)} -> ${a2.centroid.y.toFixed(1)}`);
    }
    // keyboard steering: hold ArrowLeft
    const k0 = await debug(page);
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(700);
    await page.keyboard.up('ArrowLeft');
    const k1 = await debug(page);
    if (!(k1.centroid.x < k0.centroid.x - 3)) fail(`keyboard steering had no effect: x ${k0.centroid.x.toFixed(1)} -> ${k1.centroid.x.toFixed(1)}`);
    // actions: at start mass these are illegal and must say so (visible explanation), never throw
    await page.keyboard.press('Space');
    await page.keyboard.press('e');
    await page.locator('.cd-hud .cd-actbtn', { hasText: 'Hint' }).click();
    await page.waitForTimeout(200);
    const cap = (await page.locator('.cd-hud .cd-captions').textContent()) || '';
    if (!cap.trim()) fail('Hint produced no caption');
    await assertLayout(page, label, 'HUD after input');
  });

  await step(`${label}: pause overlay: settings, Esc, Resume, Restart, Leave`, async () => {
    await page.locator('.cd-hud .cd-pausebtn').click();
    await visibleScreen(page, '.cd-pause');
    await assertLayout(page, label, 'pause');
    const t0 = (await debug(page)).tick;
    await page.locator('.cd-pause input[type="range"]').first().fill('0.3');
    await page.locator('.cd-pause input[type="checkbox"]').nth(1).check(); // captions
    await page.screenshot({ path: SHOT('pause', label) });
    await page.waitForTimeout(400);
    if ((await debug(page)).tick !== t0) fail('simulation kept running while paused');
    await page.keyboard.press('Escape');
    await visibleScreen(page, '.cd-hud');
    await page.keyboard.press('Escape');
    await visibleScreen(page, '.cd-pause');
    await page.locator('.cd-pause .cd-btn', { hasText: 'Resume' }).click();
    await visibleScreen(page, '.cd-hud');
    await page.locator('.cd-hud .cd-pausebtn').click();
    await page.locator('.cd-pause .cd-btn', { hasText: 'Restart round' }).click();
    await visibleScreen(page, '.cd-hud');
    if ((await debug(page)).tick > 20) fail('Restart round did not reset the simulation');
    await page.locator('.cd-hud .cd-pausebtn').click();
    await page.locator('.cd-pause .cd-btn', { hasText: 'Leave to modes' }).click();
    await visibleScreen(page, '.cd-modesel');
    if ((await debug(page)).phase !== null) fail('Leave to modes did not end the session');
  });

  await step(`${label}: full lesson 1 playthrough -> results -> Retry / Back`, async () => {
    await page.locator('.cd-modesel .cd-backbtn').click();
    await startRoundVia(page, label, 'Learn', 'Drift');
    await page.screenshot({ path: SHOT('hud-lesson', label) });
    await assertPlayerRendered(page, label, 'lesson HUD');
    const canvas = await page.locator('#cd-canvas').boundingBox();
    const deadline = Date.now() + 40000;
    let d = await debug(page);
    if (d.goal.type !== 'reach-marker') fail(`lesson 1 goal is ${d.goal.type}, expected reach-marker`);
    while (d.phase === 'active' && Date.now() < deadline) {
      // a player drags the pointer toward the glowing marker
      const tx = Math.min(canvas.x + canvas.width - 2, Math.max(canvas.x + 2, canvas.x + d.goal.screen.x));
      const ty = Math.min(canvas.y + canvas.height - 2, Math.max(canvas.y + 2, canvas.y + d.goal.screen.y));
      await page.mouse.move(tx, ty, { steps: 2 });
      await page.waitForTimeout(250);
      d = await debug(page);
    }
    if (d.phase !== 'terminal') fail(`lesson 1 did not finish within 40s: ${JSON.stringify(d)}`);
    if (d.terminalReason !== 'goal-complete') fail(`lesson 1 ended with ${d.terminalReason}, expected goal-complete`);
    await visibleScreen(page, '.cd-result');
    await assertLayout(page, label, 'results');
    const headline = (await page.locator('.cd-result h2').textContent()) || '';
    if (!/Goal complete/.test(headline)) fail(`results headline "${headline}"`);
    const total = (await page.locator('.cd-result .cd-total').textContent()) || '';
    if (!/Total score: \d+/.test(total)) fail(`results total "${total}"`);
    await page.screenshot({ path: SHOT('results', label) });
    await page.locator('.cd-result .cd-btn', { hasText: 'Retry' }).click();
    await visibleScreen(page, '.cd-hud');
    if ((await debug(page)).phase !== 'active') fail('Retry did not start a new round');
    await page.locator('.cd-hud .cd-pausebtn').click();
    await page.locator('.cd-pause .cd-btn', { hasText: 'Leave to modes' }).click();
    await visibleScreen(page, '.cd-modesel');
    // progress persisted: lesson marked done
    await page.locator('.cd-modesel .cd-modebtn').filter({ hasText: /^Learn$/ }).click();
    const done = await page.locator('.cd-lessonlist .cd-itembtn').filter({ hasText: 'Drift' }).first().locator('.cd-done').count();
    if (!done) fail('lesson completion not persisted to the lesson list');
    await page.locator('.cd-lessonlist .cd-backbtn').click();
  });

  for (const [mode, item, stage] of [['Journey', 'First Culture', 'journey'], ['Daily Challenge', 'Begin the day', 'daily'], ['Challenge', 'Lean Drift', 'challenge']]) {
    await step(`${label}: ${mode} start -> HUD renders`, async () => {
      await page.reload({ waitUntil: 'networkidle' });
      await startRoundVia(page, label, mode, item);
      await assertPlayerRendered(page, label, `${stage} HUD`);
      await page.screenshot({ path: SHOT(`hud-${stage}`, label) });
    });
  }

  await step(`${label}: rules engine content validation (headless supplement)`, async () => {
    const report = await page.evaluate(() => {
      const C = window.CDContent;
      const bad = [];
      for (const c of [...C.LESSONS, ...C.journeyStages(), ...C.PRACTICE, ...C.CHALLENGES, C.dailyFor(new Date())]) {
        const v = C.validateContent(c);
        if (v.length) bad.push(c.id + ': ' + v.join('; '));
      }
      return bad;
    });
    if (report.length) fail('content validation failed:\n' + report.join('\n'));
  });

  await context.close();
  if (errors.length) fail(`page errors/warnings in ${label} pass:\n` + errors.join('\n'));
}

// ---------- asset freshness: same version tag everywhere, revalidating headers
async function checkAssetVersions() {
  const html = await (await fetch(base)).text();
  const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1])
    .concat([...html.matchAll(/"three":"([^"]+)"/g)].map((m) => m[1]));
  const versions = new Set();
  for (const ref of refs) {
    if (/favicon/.test(ref)) continue;
    const m = ref.match(/[?&]v=([^&]+)/);
    if (!m) fail(`asset reference without a version tag: ${ref}`);
    versions.add(m[1]);
  }
  if (versions.size !== 1) fail(`asset version tags disagree: ${[...versions].join(', ')}`);
  for (const ref of ['/', '/css/style.css', '/js/app.js', '/js/render.js', '/js/rules.js', '/vendor/three.module.js']) {
    const res = await fetch(base + ref.slice(1));
    if (res.status !== 200) fail(`${ref}: HTTP ${res.status}`);
    if (!/no-cache/.test(res.headers.get('cache-control') || '')) fail(`${ref}: missing Cache-Control: no-cache (got "${res.headers.get('cache-control')}")`);
    const etag = res.headers.get('etag');
    if (!etag) fail(`${ref}: missing ETag`);
    const again = await fetch(base + ref.slice(1), { headers: { 'if-none-match': etag } });
    if (again.status !== 304) fail(`${ref}: revalidation returned ${again.status}, expected 304`);
    if (/\.js$/.test(ref) && !/javascript/.test(res.headers.get('content-type') || '')) fail(`${ref}: wrong MIME ${res.headers.get('content-type')}`);
  }
}

// ---------- the boot watchdog must turn a broken load into a visible message
async function checkBootWatchdog(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.route('**/js/render.js*', (route) => route.abort());
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('.cd-bootfail:visible', { timeout: 15000 }).catch(() => fail('module load failure left a silent dark screen: no boot-failure message within 15s'));
  const txt = await page.locator('.cd-bootfail').textContent();
  if (!/could not start/i.test(txt || '')) fail(`boot failure message unexpected: ${txt}`);
  if (await page.locator('.cd-title:visible').count()) fail('title screen shown despite a failed module load');
  await page.screenshot({ path: SHOT('bootfail', 'blocked-module') });
  await context.close();
}

let browser = null;
try {
  await mkdir(SHOT_DIR, { recursive: true });
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  base = `http://127.0.0.1:${server.address().port}/`;
  await step('asset versions + revalidating cache headers from the real server', checkAssetVersions);

  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  await step('boot watchdog reports a blocked module instead of a dark screen', () => checkBootWatchdog(browser));
  // E2E_PASSES=desktop,phone-portrait narrows the viewport passes while iterating
  const only = (process.env.E2E_PASSES || '').split(',').filter(Boolean);
  for (const pass of PASSES) if (!only.length || only.includes(pass.label)) await runPass(browser, pass);
  console.log(`\nE2E PASS — cellular-drift: ${PASSES.length} viewport passes, full lesson playthrough, no page errors/warnings, no layout or render defects. Screenshots: ${SHOT_DIR}`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
