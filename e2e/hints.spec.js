import { test, expect, pair } from './fixtures.js';

// The finder's hint and shortcut chip must be readable, not clipped, on the
// tablet (the default project viewport) and on a desktop window.
for (const [label, viewport] of [['tablet', null], ['desktop', { width: 1440, height: 900 }]]) {
  test(`${label}: the finder shows its whole hint and its shortcut chip`, async ({ page, host }) => {
    if (viewport) await page.setViewportSize(viewport);
    await pair(page, host);
    const fit = await page.locator('#find').evaluate((input) => {
      const s = getComputedStyle(input);
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const text = ctx.measureText(input.placeholder).width;
      const room = input.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
      const textEnd = input.getBoundingClientRect().left + input.clientLeft + parseFloat(s.paddingLeft) + text;
      return { text, room, textEnd, placeholder: input.placeholder };
    });
    expect(fit.placeholder.length).toBeGreaterThan(5); // anchor: there is a hint to fit
    expect(fit.text).toBeLessThanOrEqual(fit.room);

    const chip = page.locator('#find-key');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/Ctrl.*K/);
    const box = await page.locator('#find').boundingBox();
    const c = await chip.boundingBox();
    expect(c.x).toBeGreaterThanOrEqual(box.x);
    expect(c.x + c.width).toBeLessThanOrEqual(box.x + box.width); // inside the field, not clipped
    // The chip sits in the padding the text never reaches.
    const padRight = await page.locator('#find').evaluate((e) => parseFloat(getComputedStyle(e).paddingRight));
    expect(c.width).toBeLessThanOrEqual(padRight);
    expect(c.x - fit.textEnd).toBeGreaterThanOrEqual(8); // breathing room between hint and chip
  });
}

test('each of the first agents shows the Alt shortcut that opens it', async ({ page, host }) => {
  for (let i = 1; i <= 11; i++) host.tmux('new-window', '-d', '-t', '=main:', '-n', `agente-${i}`);
  await pair(page, host);
  const rows = page.locator('#tab-list li:not(.create)');
  await expect(rows).toHaveCount(12);
  let withChip = 0;
  for (const [i, row] of (await rows.all()).entries()) {
    const chip = row.locator('.hotkey');
    if (i >= 9) { // only Alt+1..Alt+9 exist
      await expect(chip).toHaveCount(0);
      continue;
    }
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(`Alt ${i + 1}`); // the place in the list, not the tmux index
    withChip++;
  }
  expect(withChip).toBe(9); // anchor: the loop really checked the chips
});

test('Alt+number opens that agent and hands it the keyboard, sending nothing to the shell', async ({ page, host }) => {
  for (let i = 1; i <= 3; i++) host.tmux('new-window', '-d', '-t', '=main:', '-n', `agente-${i}`);
  const sent = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload !== 'string') sent.push(Buffer.from(f.payload)); }));
  await pair(page, host);
  await page.keyboard.type('x');
  await expect.poll(() => sent.some((b) => b.toString() === 'x')).toBe(true); // anchor: keys reach the socket

  await page.keyboard.press('Alt+2'); // the second row: tmux's own "bash" is the first
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('agente-1');
  // xterm would send ESC 2 for Alt+2: readline reads it as "repeat the next key twice".
  // (Switching windows also produces terminal replies, which are not keystrokes.)
  expect(sent.filter((b) => b.toString() === '\x1b2')).toEqual([]);

  await page.keyboard.type('echo no-dois-$((1+1))\n');
  const two = host.windows().find((w) => w.name === 'agente-1');
  await expect.poll(() => host.capture(two.id)).toContain('no-dois-2');
});

test('Alt+Down and Alt+Up move to the next and previous agent', async ({ page, host }) => {
  for (let i = 1; i <= 3; i++) host.tmux('new-window', '-d', '-t', '=main:', '-n', `agente-${i}`);
  await pair(page, host);
  const current = page.locator('#tab-list li[aria-current="true"] .name');
  const first = await current.textContent();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(current).toHaveText('agente-1');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(current).toHaveText('agente-2');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(current).toHaveText('agente-1');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(current).toHaveText(first);
  await page.keyboard.press('Alt+ArrowUp'); // wraps to the last
  await expect(current).toHaveText('agente-3');
});

test('the sidebar says how to move between agents', async ({ page, host }) => {
  await pair(page, host);
  await expect(page.locator('#tabs-hint')).toBeVisible();
  await expect(page.locator('#tabs-hint')).toContainText('Alt');
  // One shortcut per line, each on a single line: a hint that wraps mid-phrase
  // is hard to read at a glance.
  const lines = page.locator('#tabs-hint li');
  await expect(lines).toHaveText([/open/, /next/, /reorder/]);
  for (const line of await lines.all()) {
    const { height, lineHeight } = await line.evaluate((e) => ({ height: e.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(e).lineHeight) }));
    expect(height).toBeLessThan(lineHeight * 1.6);
  }
});

// Chips must not cost the names: with the sidebar at its normal width, a
// typical agent name ("pe-api-banking") is shown whole on every row.
for (const [label, viewport] of [['tablet', null], ['desktop', { width: 1440, height: 900 }]]) {
  test(`${label}: agent names are not squeezed by the shortcut chips`, async ({ page, host }) => {
    if (viewport) await page.setViewportSize(viewport);
    for (const n of ['pe-api-banking', 'revisor-pr', 'migrations']) host.tmux('new-window', '-d', '-t', '=main:', '-n', n);
    await pair(page, host);
    const names = page.locator('#tab-list li:not(.create) .name');
    await expect(names).toHaveCount(4);
    let chips = 0;
    for (const name of await names.all()) {
      const clipped = await name.evaluate((e) => e.scrollWidth > e.clientWidth);
      expect(clipped, `"${await name.textContent()}" is cut off`).toBe(false);
      chips += await name.locator('xpath=..').locator('.hotkey').count();
    }
    expect(chips).toBe(4); // anchor: every row has its chip while the names fit
  });
}
