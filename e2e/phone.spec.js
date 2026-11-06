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

// The top bar names the open agent, so you know where you are with the list
// closed, and opens the list as a drawer over the terminal.
test('the top bar names the open agent and opens the list as a drawer', async ({ page, host }) => {
  agents(host, 12);
  await pair(page, host);
  expect(await page.evaluate(() => innerWidth)).toBe(360); // measured on the real screen, not a zoomed-out page
  const toggle = page.getByRole('button', { name: 'Agents' });
  await expect(page.locator('#top-name')).toHaveText(host.windows()[0].name);
  const box = await toggle.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('#tabs')).not.toBeInViewport();
  await toggle.tap();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#tabs')).toBeInViewport({ ratio: 1 });
  // Vertical, the same list as on a desktop, with room for whole names.
  const rows = page.locator('#tab-list li[data-id]');
  await expect(rows).toHaveCount(13);
  const [a, b] = [await rows.nth(0).boundingBox(), await rows.nth(1).boundingBox()];
  expect(b.y).toBeGreaterThan(a.y + a.height - 1);
  expect(a.height).toBeGreaterThanOrEqual(44);
  // The scrim closes it.
  await page.mouse.click(350, 400);
  await expect(page.locator('#tabs')).not.toBeInViewport();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('an agent picked in the drawer opens, closes the drawer and gets the keys', async ({ page, host }) => {
  agents(host, 12);
  await pair(page, host);
  await page.getByRole('button', { name: 'Agents' }).tap();
  await page.locator('#find').tap();
  await page.keyboard.type('nome-12');
  await page.locator('#tab-list li', { hasText: 'agente-com-nome-12' }).tap();
  await expect(page.locator('#tabs')).not.toBeInViewport();
  await expect(page.locator('#top-name')).toHaveText('agente-com-nome-12');
  await page.keyboard.type('echo no-doze-$((6*7))\n');
  const w = host.windows().find((x) => x.name === 'agente-com-nome-12');
  await expect.poll(() => host.capture(w.id)).toContain('no-doze-42');
});

// Creating an agent on a phone must be findable without knowing a shortcut:
// a visible "+" and a finder that says it creates.
test('a visible + creates an agent by touch alone', async ({ page, host }) => {
  await pair(page, host);
  const plus = page.getByRole('button', { name: 'New agent' }).first();
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
  await page.keyboard.type('echo criado-$((4*4))\n');
  const w = () => host.windows().find((x) => x.name === 'pelo-celular');
  await expect.poll(() => w() && host.capture(w().id)).toContain('criado-16');
});
