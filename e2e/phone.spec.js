import { test, expect, pair, typeInTerminal } from './fixtures.js';

// A phone held upright, with many agents: the case that broke. Nothing may be
// wider than the screen, or the page zooms out and the terminal gets columns
// the user cannot see.
test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

const agents = (host, n) => { for (let i = 1; i <= n; i++) host.tmux('new-window', '-d', '-t', '=main:', '-n', `agente-com-nome-${i}`); };

test('the page never gets wider than the phone', async ({ page, host }) => {
  agents(host, 12);
  await pair(page, host);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => innerWidth)).toBe(360);
});

test('the terminal gets exactly the columns that fit on screen', async ({ page, host }) => {
  agents(host, 12);
  await pair(page, host);
  await typeInTerminal(page, 'tput cols\n');
  const cols = () => Number(host.tmux('list-clients', '-F', '#{client_width}').trim());
  await expect.poll(cols).toBeGreaterThan(30); // anchor: a real terminal, not a collapsed one
  expect(cols()).toBeLessThan(50); // 360 px of monospace, not the 130 columns of a zoomed-out page
  // The right edge of the text must be on screen.
  const screen = await page.locator('#terminal .xterm-screen').boundingBox();
  expect(screen.x + screen.width).toBeLessThanOrEqual(360);
});

test('every key of the bar is on screen, big enough for a thumb, without scrolling', async ({ page, host }) => {
  await pair(page, host);
  const keys = page.locator('#keys button');
  expect(await keys.count()).toBeGreaterThan(8); // anchor: the whole bar is there
  for (const key of await keys.all()) {
    await expect(key).toBeInViewport({ ratio: 1 });
    const box = await key.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(40);
    expect(box.height).toBeGreaterThanOrEqual(36);
  }
  const bar = await page.locator('#keys').evaluate((e) => ({ client: e.clientWidth, scroll: e.scrollWidth }));
  expect(bar.scroll).toBeLessThanOrEqual(bar.client);
});

// The soft keyboard takes half the screen: the terminal must shrink to what is
// left, keeping the line being typed in view.
test('opening the soft keyboard shrinks the terminal instead of hiding the prompt', async ({ page, host }) => {
  await pair(page, host);
  const rows = () => Number(host.tmux('list-clients', '-F', '#{client_height}').trim());
  await expect.poll(rows).toBeGreaterThan(20);
  const tall = rows();
  await page.setViewportSize({ width: 360, height: 420 }); // keyboard up
  await expect.poll(rows).toBeLessThan(tall);
  await typeInTerminal(page, 'echo visivel-$((9+9))\n');
  const line = page.locator('#terminal .xterm-rows > div', { hasText: 'visivel-18' }).last();
  await expect(line).toBeInViewport();
  // The line must be readable at the phone's own width, not a zoomed-out page.
  const box = await line.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => innerWidth)).toBe(360);
});

test('the current agent and the finder stay usable in the top bar', async ({ page, host }) => {
  agents(host, 12);
  await pair(page, host);
  expect(await page.evaluate(() => innerWidth)).toBe(360); // measured on the real screen, not a zoomed-out page
  const current = page.locator('#tab-list li[aria-current="true"]');
  await expect(current).toBeInViewport({ ratio: 0.9 });
  // Collapsed, the finder is a thumb-sized button that leaves the row to the agents.
  const find = await page.locator('#find').boundingBox();
  expect(find.width).toBeGreaterThanOrEqual(44);
  expect(find.width).toBeLessThanOrEqual(60);
  expect(find.height).toBeGreaterThanOrEqual(40);
  // Tapping into the finder gives it room to type a name.
  await page.locator('#find').tap();
  await expect.poll(async () => (await page.locator('#find').boundingBox()).width).toBeGreaterThan(200);
});

test('an agent chosen from the finder scrolls into view in the tab strip', async ({ page, host }) => {
  agents(host, 12);
  await pair(page, host);
  const far = page.locator('#tab-list li', { hasText: 'agente-com-nome-12' });
  await expect(far).not.toBeInViewport(); // anchor: it starts off screen
  await page.locator('#find').tap();
  await page.keyboard.type('nome-12');
  await page.keyboard.press('Enter');
  await expect(page.locator('#tab-list li[aria-current="true"]')).toBeInViewport({ ratio: 0.9 });
});

// Switching agents with a finger must not pop the soft keyboard up: it hides
// half the agent. It opens when the terminal itself is tapped.
test('tapping another tab leaves the soft keyboard closed until the terminal is tapped', async ({ page, host }) => {
  agents(host, 2);
  await pair(page, host);
  const textarea = page.locator('#terminal .xterm-helper-textarea');
  await page.locator('#tab-list li', { hasText: 'agente-com-nome-2' }).tap();
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('agente-com-nome-2');
  await page.waitForTimeout(500); // the socket opens and would have focused by now
  await expect(textarea).not.toBeFocused();
  await page.locator('#terminal').tap();
  await expect(textarea).toBeFocused(); // anchor: the terminal can still take the keyboard
  await page.keyboard.type('echo no-dois-$((1+1))\n');
  const two = host.windows().find((w) => w.name === 'agente-com-nome-2');
  await expect.poll(() => host.capture(two.id)).toContain('no-dois-2');
});

// Creating an agent on a phone must be findable without knowing a shortcut:
// a visible "+" and a finder that says it creates.
test('a visible + creates an agent by touch alone', async ({ page, host }) => {
  await pair(page, host);
  const plus = page.getByRole('button', { name: 'New agent' });
  await expect(plus).toBeInViewport({ ratio: 1 });
  const box = await plus.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(40);
  await plus.tap();
  await expect(page.locator('#find')).toBeFocused();
  await expect(page.locator('#find')).toHaveAttribute('placeholder', /create/i); // says it also creates
  expect(await page.locator('#find').evaluate((e) => getComputedStyle(e, '::placeholder').color)).not.toBe('rgba(0, 0, 0, 0)');
  await page.keyboard.type('pelo-celular');
  await page.locator('#tab-list li.create').tap(); // tap the row, not Enter
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('pelo-celular');
  // Opened by a tap, the agent leaves the soft keyboard closed until its terminal is tapped.
  await expect(page.locator('#terminal .xterm-helper-textarea')).not.toBeFocused();
  await expect(page.locator('#find')).not.toBeFocused();
  await page.locator('#terminal').tap();
  await expect(page.locator('#terminal .xterm-helper-textarea')).toBeFocused();
  await page.keyboard.type('echo criado-$((4*4))\n');
  const w = () => host.windows().find((x) => x.name === 'pelo-celular');
  await expect.poll(() => w() && host.capture(w().id)).toContain('criado-16');
});
