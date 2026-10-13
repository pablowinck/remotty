import { test, expect, pair } from './fixtures.js';

// Order is tmux's window index: a drop has to move the window on the host, so
// ssh and every other device see it, and Alt+N follows the new order.
const names = (host) => host.windows().map((w) => w.name);
const setup = (host) => {
  host.tmux('rename-window', '-t', host.windows()[0].id, 'um');
  for (const n of ['dois', 'tres']) host.tmux('new-window', '-d', '-t', '=main:', '-n', n);
};
const row = (page, name) => page.locator('#tab-list li', { has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }) });

test('dragging a tab with the mouse reorders the windows in tmux', async ({ page, host }) => {
  setup(host);
  await pair(page, host);
  await expect(page.locator('#tab-list li')).toHaveCount(3);
  await row(page, 'dois').click(); // open another tab than the one dragged
  const from = await row(page, 'um').boundingBox();
  const to = await row(page, 'tres').boundingBox();
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, to.y + to.height * 0.8, { steps: 10 }); // lower half: after "tres"
  await expect(row(page, 'tres')).toHaveClass(/drop-after/); // the user sees where it lands
  await page.mouse.up();

  await expect.poll(() => names(host)).toEqual(['dois', 'tres', 'um']);
  await expect(page.locator('#tab-list .name')).toHaveText(['dois', 'tres', 'um']);
  // Releasing the drag is not a click: the tab that was open stays open.
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('dois');
  // Indexes are closed up again, so Alt+1 is the new first agent.
  const idx = host.tmux('list-windows', '-t', '=main', '-F', '#{window_index}').trim().split('\n').map(Number);
  expect(idx).toEqual([idx[0], idx[0] + 1, idx[0] + 2]);
});

test('a click that does not travel opens the tab instead of dragging it', async ({ page, host }) => {
  setup(host);
  await pair(page, host);
  const b = await row(page, 'dois').boundingBox();
  await page.mouse.move(b.x + 20, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 23, b.y + b.height / 2 + 3); // a hand wobbles a few pixels
  await page.mouse.up();
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('dois');
  await expect(page.locator('#tab-list li.dragging')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(names(host)).toEqual(['um', 'dois', 'tres']);
});

test('Alt+Shift+Up moves the open agent one place up', async ({ page, host }) => {
  setup(host);
  await pair(page, host);
  await row(page, 'tres').click();
  await page.keyboard.press('Alt+Shift+ArrowUp');
  await expect.poll(() => names(host)).toEqual(['um', 'tres', 'dois']);
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('tres'); // still open
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  const touch = async (page, points) => {
    const cdp = await page.context().newCDPSession(page);
    for (const [type, p, wait] of points) {
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [p] : [] });
      if (wait) await page.waitForTimeout(wait);
    }
  };

  test('holding a tab, then sliding it, reorders; a plain swipe does not', async ({ page, host }) => {
    setup(host);
    await pair(page, host);
    const a = await row(page, 'um').boundingBox();
    const c = await row(page, 'tres').boundingBox();
    const y = a.y + a.height / 2;

    // A quick swipe along the strip is a scroll, never a drag.
    await touch(page, [['touchStart', { x: a.x + 10, y }], ['touchMove', { x: c.x + c.width - 5, y }], ['touchEnd', null]]);
    await page.waitForTimeout(300);
    expect(names(host)).toEqual(['um', 'dois', 'tres']);

    // Hold still, then slide to the right half of "tres".
    const steps = [...Array(8)].map((_, i) => ['touchMove', { x: a.x + 10 + ((c.x + c.width * 0.8 - a.x - 10) * (i + 1)) / 8, y }, 20]);
    await touch(page, [['touchStart', { x: a.x + 10, y }, 500], ...steps, ['touchEnd', null]]);
    await expect.poll(() => names(host)).toEqual(['dois', 'tres', 'um']);
  });
});

const folderOf = (host, name) => {
  const w = host.windows().find((x) => x.name === name);
  return host.tmux('show-options', '-wqv', '-t', w.id, '@remotty-folder').trim();
};
const dragTo = async (page, from, to, at) => {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  await page.mouse.move(a.x + 20, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 20, b.y + b.height * at, { steps: 10 });
};

test('dragging a tab onto a folder puts it in, and beside a loose tab takes it out', async ({ page, host }) => {
  setup(host);
  host.tmux('set-option', '-t', '=main:', '@remotty-folders', 'billing');
  await pair(page, host);
  const header = page.locator('#tab-list li.folder');
  await expect(header).toHaveText(/billing/);

  await dragTo(page, row(page, 'dois'), header, 0.5);
  await expect(header).toHaveClass(/drop-into/); // the folder lights up as the target
  await page.mouse.up();
  await expect.poll(() => folderOf(host, 'dois')).toBe('billing');
  await expect(row(page, 'dois')).toHaveClass(/in-folder/);
  expect(folderOf(host, 'um')).toBe(''); // anchor: only the dragged one moved

  await dragTo(page, row(page, 'dois'), row(page, 'tres'), 0.8);
  await expect(row(page, 'tres')).toHaveClass(/drop-after/);
  await page.mouse.up();
  await expect.poll(() => folderOf(host, 'dois')).toBe('');
  await expect(row(page, 'dois')).not.toHaveClass(/in-folder/);
  await expect.poll(() => names(host)).toEqual(['um', 'tres', 'dois']);
});
