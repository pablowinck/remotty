import { test, expect, pair, typeInTerminal } from './fixtures.js';

// Safari's engine. iOS and iPadOS browsers are all WebKit, so this is what
// an iPhone or iPad really runs, emulated in size, touch and platform.
test.use({ browserName: 'webkit' });

// An iPhone in WebKit, Safari's engine: the page must fit, and a focused field
// must not zoom the page in (iOS does that below 16px and never zooms back).
test.describe('on an iPhone', () => {
  test.use({ platform: 'iPhone', viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });

  test('focusable fields are 16px or more, so Safari never zooms in', async ({ page, host }) => {
    await pair(page, host);
    for (const sel of ['#find', '#terminal .xterm-helper-textarea']) {
      const size = await page.locator(sel).evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
      expect(size, sel).toBeGreaterThanOrEqual(16);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  // Glued to the bezel, the first column of text and the outer keys were hard
  // to read and to hit: the terminal and the key bar keep a margin on a phone.
  test('the terminal text and the keys keep a margin from the screen edges', async ({ page, host }) => {
    await pair(page, host);
    const screen = await page.locator('#terminal .xterm-screen').boundingBox();
    expect(screen.width).toBeGreaterThan(300); // anchor: the terminal still fills the width
    expect(screen.x).toBeGreaterThanOrEqual(6);
    // The right margin matches the left, give or take the part of a cell that
    // does not fit: no strip kept for a scrollbar that never shows.
    const cols = Number(host.tmux('list-clients', '-F', '#{client_width}').trim());
    const cell = screen.width / cols;
    expect(cols).toBeGreaterThan(30); // anchor: a real terminal width
    expect(390 - (screen.x + screen.width)).toBeLessThanOrEqual(screen.x + cell);
    const keys = await page.locator('#keys button').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()));
    expect(keys.length).toBeGreaterThan(8); // anchor: the whole bar is there
    expect(Math.min(...keys.map((r) => r.left))).toBeGreaterThanOrEqual(6);
    expect(Math.max(...keys.map((r) => r.right))).toBeLessThanOrEqual(390 - 6);
  });

  test('the device pairs under its own name', async ({ page, host }) => {
    await page.goto(host.origin);
    await page.getByLabel('Code').fill(host.pairCode());
    await page.getByRole('button', { name: 'Pair' }).click();
    await expect(page.locator('#app')).toBeVisible();
    expect(host.cli('devices')).toMatch(/\biOS\b/);
  });

  // iOS covers the page with the soft keyboard instead of resizing it; only the
  // visual viewport shrinks. The app must follow it so the prompt stays in view.
  test('the app follows the visual viewport when the keyboard covers the page', async ({ page, host }) => {
    await pair(page, host);
    const appHeight = () => page.locator('#app').evaluate((e) => e.getBoundingClientRect().height);
    expect(await appHeight()).toBeGreaterThan(600); // anchor: full height first
    // Emulate the keyboard: iOS shrinks visualViewport, not the layout viewport.
    await page.evaluate(() => {
      const vv = window.visualViewport;
      Object.defineProperty(vv, 'height', { get: () => 330, configurable: true });
      vv.dispatchEvent(new Event('resize'));
    });
    await expect.poll(appHeight).toBe(330);
    await expect(page.locator('#keys')).toBeInViewport();
  });
});

// An iPad (it reports itself as a Mac) with a hardware keyboard: Mac symbols, touch layout.
test.describe('on an iPad', () => {
  test.use({ platform: 'MacIntel', viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' });

  test('runs a command and shows its output, with Mac hints', async ({ page, host }) => {
    await pair(page, host);
    await typeInTerminal(page, 'echo ipad-$((6*7))\n');
    await expect(page.locator('#terminal .xterm-rows')).toContainText('ipad-42');
    await expect.poll(() => host.capture(host.windows()[0].id)).toContain('ipad-42');
    await expect(page.locator('#find-key')).toHaveText('⌃⇧K');
  });
});
