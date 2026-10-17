// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset on the real Graphics
// screen, starts the Expert practice dish (six rivals, barbs, motes) and steers the player around with
// the pointer so the camera, membranes, particles and the post chain all run.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

const visible = (page, sel) => page.waitForSelector(`${sel}:visible`, { timeout: 20000 });

export async function setPreset(page, preset) {
  await visible(page, '.cd-title');
  await page.locator('#cd-open-graphics').click();
  await visible(page, '.cd-graphics');
  await page.locator('#gfx-preset').selectOption(preset);
  await page.waitForFunction((p) => document.body.getAttribute('data-gfx-preset') === p, preset);
  await page.keyboard.press('Escape');
  await visible(page, '.cd-title');
}

export async function start(page, { mobile } = {}) {
  await page.locator('.cd-title .cd-play').click();
  await visible(page, '.cd-modesel');
  await page.locator('.cd-modesel .cd-modebtn').filter({ hasText: /^Practice$/ }).click();
  await visible(page, '.cd-pracsel');
  const item = page.locator('.cd-pracsel .cd-itembtn').filter({ hasText: 'Expert' }).first();
  await item.scrollIntoViewIfNeeded();
  await item.click();
  await visible(page, '.cd-hud');
  const box = await page.locator('#cd-canvas').boundingBox();
  let open = true, t = 0;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try {
        // Circle the pointer around the centre: the player keeps drifting through the dish.
        t += 0.35;
        const x = box.x + box.width * (0.5 + 0.35 * Math.cos(t)), y = box.y + box.height * (0.5 + 0.35 * Math.sin(t));
        if (mobile) await page.touchscreen.tap(x, y); else await page.mouse.move(x, y, { steps: 3 });
        await page.waitForTimeout(250);
      } catch { if (!open) return; }
    }
  })();
  await page.waitForTimeout(500);
}
