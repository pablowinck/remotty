import { test, expect, pair, typeInTerminal } from './fixtures.js';

// The key bar is this device's own: a touch screen starts with every key, a
// mouse and keyboard with none. The microphone and attach are always there.
const shownKeys = (page) => page.locator('#keys button:visible').evaluateAll((bs) => bs.map((b) => b.textContent || b.getAttribute('aria-label')));
const FIXED = ['Attach a photo or file', 'Record a voice note'];

async function openSettings(page) {
  if (await page.locator('#menu').isVisible()) await page.locator('#menu').click(); // narrow: Settings is in the drawer
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
}

test.describe('with a mouse and keyboard', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test('only the microphone and attach show until a key is turned on, and the choice survives a reload', async ({ page, host }) => {
    await pair(page, host);
    expect(await shownKeys(page)).toEqual(FIXED);
    // Icon-only buttons have no text to give them height: they must still be
    // a key's size, with the icon inside, not a flat pill it spills out of.
    for (const name of FIXED) {
      const box = await page.getByRole('button', { name }).boundingBox();
      expect(box.height, name).toBeGreaterThanOrEqual(32);
      expect(box.width, name).toBeGreaterThanOrEqual(box.height);
    }
    // The bar starts on the left, under the start of the terminal.
    const bar = await page.locator('#keys').boundingBox();
    const first = await page.getByRole('button', { name: FIXED[0] }).boundingBox();
    expect(first.x - bar.x).toBeLessThan(20);
    expect(bar.width).toBeGreaterThan(400); // anchor: the bar spans the stage, so a right-aligned key would be far
    await openSettings(page);
    await expect(page.getByRole('switch')).toHaveCount(10); // anchor: every key is listed
    await page.getByRole('switch', { name: /Escape/ }).check();
    await page.getByRole('switch', { name: /Interrupt/ }).check();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    expect(await shownKeys(page)).toEqual(['Esc', '^C', ...FIXED]);

    await page.reload();
    await expect(page.locator('#stage')).toBeInViewport();
    expect(await shownKeys(page)).toEqual(['Esc', '^C', ...FIXED]);
    // The key turned on is a real key: ^C stops what runs.
    await typeInTerminal(page, 'sleep 300 && echo nao-$((1+1))-devia\n');
    await page.getByRole('button', { name: '^C' }).click();
    await typeInTerminal(page, 'echo parou-$((3+4))\n');
    await expect.poll(() => host.capture(host.windows()[0].id)).toContain('parou-7');
    expect(host.capture(host.windows()[0].id)).not.toContain('nao-2-devia');
  });

  test('Alt+Down on a key moves it later in the bar, and Reset brings back the defaults', async ({ page, host }) => {
    await pair(page, host);
    await openSettings(page);
    for (const k of [/Escape/, /Tab/]) await page.getByRole('switch', { name: k }).check();
    await page.getByRole('switch', { name: /Escape/ }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.getByRole('switch', { name: /Escape/ })).toBeFocused(); // keeps the keyboard on the moved key
    await expect(page.locator('#key-settings li').first()).toHaveAttribute('data-id', 'tab');
    expect(await shownKeys(page)).toEqual(['Tab', 'Esc', ...FIXED]);

    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    await expect(page.locator('#key-settings li').first()).toHaveAttribute('data-id', 'esc');
    expect(await shownKeys(page)).toEqual(FIXED);
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.locator('#stage')).toBeInViewport();
    expect(await shownKeys(page)).toEqual(FIXED);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('every key shows by default; hiding one and dragging another persists', async ({ page, host }) => {
    await pair(page, host);
    const all = await shownKeys(page);
    expect(all).toHaveLength(12);
    expect(all.slice(0, 2)).toEqual(['Esc', 'Tab']);
    await openSettings(page);
    await page.getByRole('switch', { name: /Paste/ }).tap();
    // Drag Enter's grip above Esc.
    const grip = (id) => page.locator(`#key-settings li[data-id="${id}"] .grip`);
    const from = await grip('enter').boundingBox();
    const to = await page.locator('#key-settings li[data-id="esc"]').boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const x = from.x + from.width / 2;
    const at = (y) => ({ touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', ...at(from.y + from.height / 2) });
    for (let i = 1; i <= 12; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', ...at(from.y + from.height / 2 + ((to.y + 5 - from.y - from.height / 2) * i) / 12) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('#key-settings li').first()).toHaveAttribute('data-id', 'enter');
    await page.getByRole('button', { name: 'Done' }).tap();

    await page.reload();
    await expect(page.locator('#stage')).toBeInViewport();
    const now = await shownKeys(page);
    expect(now[0]).toBe('Enter');
    expect(now).not.toContain('Paste');
    expect(now.slice(-2)).toEqual(FIXED);
    expect(now).toHaveLength(11);
  });
});
