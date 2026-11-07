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

test('Alt+Shift+Up follows the list as shown, into the folder above', async ({ page, host }) => {
  setup(host);
  const folderOf = (name) => host.tmux('show-options', '-wqv', '-t', host.windows().find((w) => w.name === name).id, '@remotty-folder').trim();
  host.tmux('set-option', '-t', '=main:', '@remotty-folders', 'a');
  host.tmux('set-option', '-w', '-t', host.windows()[2].id, '@remotty-folder', 'a');
  await pair(page, host);
  const agents = page.locator('#tab-list li:not(.folder) .name');
  await expect(agents).toHaveText(['tres', 'um', 'dois']); // folders first, so "um" shows below "tres"
  await row(page, 'um').click();
  await page.keyboard.press('Alt+Shift+ArrowUp');
  await expect.poll(() => folderOf('um')).toBe('a'); // like a drop beside "tres": it joins its folder
  expect(names(host)).toEqual(['dois', 'um', 'tres']);
  await expect(agents).toHaveText(['um', 'tres', 'dois']);
  await expect(row(page, 'um')).toHaveClass(/in-folder/);
  expect(folderOf('dois')).toBe(''); // the other loose one stays loose
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

  test('in the drawer, holding a tab, then sliding it, reorders; a plain swipe does not', async ({ page, host }) => {
    setup(host);
    await pair(page, host);
    await page.getByRole('button', { name: 'Agents' }).tap();
    await expect(page.locator('#tabs')).toBeInViewport({ ratio: 1 });
    const a = await row(page, 'um').boundingBox();
    const c = await row(page, 'tres').boundingBox();
    const x = a.x + 40;

    // A quick swipe down the list is a scroll, never a drag.
    await touch(page, [['touchStart', { x, y: a.y + 10 }], ['touchMove', { x, y: c.y + c.height - 5 }], ['touchEnd', null]]);
    await page.waitForTimeout(300);
    expect(names(host)).toEqual(['um', 'dois', 'tres']);

    // Hold still, then slide to the lower half of "tres".
    const steps = [...Array(8)].map((_, i) => ['touchMove', { x, y: a.y + 10 + ((c.y + c.height * 0.8 - a.y - 10) * (i + 1)) / 8 }, 20]);
    await touch(page, [['touchStart', { x, y: a.y + 10 }, 500], ...steps, ['touchEnd', null]]);
    await expect.poll(() => names(host)).toEqual(['dois', 'tres', 'um']);
  });
});

const folderOf = (host, name) => {
  const w = host.windows().find((x) => x.name === name);
  return host.tmux('show-options', '-wqv', '-t', w.id, '@remotty-folder').trim();
};
const dragTo = async (page, from, to, at) => {
  // The poll redraws the list: a row measured mid-redraw has no box yet, so ask again.
  const box = async (loc) => { let r = null; await expect.poll(async () => (r = await loc.boundingBox())).not.toBeNull(); return r; };
  const a = await box(from);
  const b = await box(to);
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
