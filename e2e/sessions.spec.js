import { test, expect, pair, typeInTerminal } from './fixtures.js';

test('creates, switches, renames and closes agent tabs', async ({ page, host }) => {
  await pair(page, host);
  const tabs = page.locator('#tab-list li');
  await expect(tabs).toHaveCount(1);

  // "+" opens the finder; typing a new name and Enter creates it.
  await page.getByRole('button', { name: 'New agent' }).click();
  await page.keyboard.type('revisor');
  await page.keyboard.press('Enter');
  await expect(tabs).toHaveCount(2);
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('revisor');
  expect(host.windows().map((w) => w.name)).toContain('revisor');

  // Typing lands in the selected window only.
  await typeInTerminal(page, 'echo so-no-revisor\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('so-no-revisor');
  const [first, second] = host.windows();
  expect(host.capture(second.id)).toContain('so-no-revisor');
  expect(host.capture(first.id)).not.toContain('so-no-revisor');

  page.once('dialog', (d) => d.accept('testador'));
  await page.locator('#tab-list li[aria-current="true"]').dblclick();
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('testador');

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Options for testador' }).click();
  await page.getByRole('menuitem', { name: 'Close' }).click();
  await expect(tabs).toHaveCount(1);
  expect(host.windows().map((w) => w.name)).not.toContain('testador');
});

test('upright, the tabs move to a top strip and the terminal takes the full width', async ({ page, host }) => {
  await pair(page, host);
  const width = () => page.locator('#stage').evaluate((e) => e.getBoundingClientRect().width);
  // Anchor: in landscape the sidebar takes a slice of the width.
  expect(await width()).toBeLessThan(page.viewportSize().width - 100);
  await page.setViewportSize({ width: 800, height: 1280 });
  await expect.poll(width).toBeGreaterThan(780);
  expect((await page.locator('#tabs').boundingBox()).height).toBeLessThan(120);
});

test('windows created over ssh or mosh show up without reloading', async ({ page, host }) => {
  await pair(page, host);
  host.tmux('new-window', '-d', '-t', '=main:', '-n', 'via-mosh');
  await expect(page.locator('#tab-list .name', { hasText: 'via-mosh' })).toBeVisible();
});

test('handles 30 agent tabs', async ({ page, host }) => {
  for (let i = 1; i < 30; i++) host.tmux('new-window', '-d', '-t', '=main:', '-n', `agente-${i}`);
  await pair(page, host);
  await expect(page.locator('#tab-list li')).toHaveCount(30);
  await page.locator('#tab-list .name', { hasText: 'agente-29' }).click();
  await typeInTerminal(page, 'echo no-29\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('no-29');
  const target = host.windows().find((w) => w.name === 'agente-29');
  expect(host.capture(target.id)).toContain('no-29');
});

test('a bell in a background window lights up its tab', async ({ page, host }) => {
  host.tmux('new-window', '-d', '-t', '=main:', '-n', 'barulhento');
  await pair(page, host);
  const noisy = host.windows().find((w) => w.name === 'barulhento');
  host.tmux('send-keys', '-t', noisy.id, "printf '\\a'", 'Enter');
  await expect(page.locator('#tab-list li', { hasText: 'barulhento' })).toHaveAttribute('data-state', 'bell');
});

test('a window name with markup is shown as text', async ({ page, host }) => {
  host.tmux('new-window', '-d', '-t', '=main:', '-n', '<img src=x onerror=alert(1)>');
  let dialog = false;
  page.on('dialog', (d) => { dialog = true; d.dismiss(); });
  await pair(page, host);
  await expect(page.locator('#tab-list .name', { hasText: '<img src=x onerror=alert(1)>' })).toBeVisible();
  expect(dialog).toBe(false);
  await expect(page.locator('#tab-list img')).toHaveCount(0);
});

test('folders group agents, collapse, and live in tmux', async ({ page, host }) => {
  host.tmux('new-window', '-d', '-t', '=main:', '-n', 'faturas');
  await pair(page, host);
  const row = (name) => page.locator('#tab-list li', { has: page.locator('.name', { hasText: name }) });

  // No folder yet: "Move to…" is there but disabled.
  await page.getByRole('button', { name: 'Options for faturas' }).click();
  await expect(page.getByRole('menuitem', { name: 'Close' })).toBeEnabled();
  await expect(page.getByRole('menuitem', { name: 'Move to…' })).toBeDisabled();
  await page.keyboard.press('Escape');

  // Folders are made in the finder: type a name, then pick "New folder" below "New agent".
  await page.keyboard.press('Control+Shift+K');
  await page.keyboard.type('billing');
  await expect(page.locator('#tab-list li.create')).toHaveText('+ New agent "billing"');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#tab-list li.folder')).toHaveText(/billing/);
  expect(host.windows().map((w) => w.name)).not.toContain('billing'); // a folder, not an agent

  await page.getByRole('button', { name: 'Options for faturas' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  await page.getByRole('menuitem', { name: 'billing' }).click();
  await expect(row('faturas')).toHaveClass(/in-folder/);
  const faturas = host.windows().find((w) => w.name === 'faturas');
  expect(host.tmux('show-options', '-wv', '-t', faturas.id, '@remotty-folder').trim()).toBe('billing');

  // Collapse hides it (it is not the open tab); expanding brings it back.
  await page.locator('#tab-list li.folder').click();
  await expect(row('faturas')).toHaveCount(0);
  await expect(page.locator('#tab-list li[data-id]')).toHaveCount(1);
  await page.locator('#tab-list li.folder').click();
  await expect(row('faturas')).toBeVisible();

  // Typing then Enter on the finder's "New folder" row also creates one.
  await page.getByRole('button', { name: 'New agent' }).click();
  await page.keyboard.type('infra');
  await page.locator('#tab-list li.create-folder', { hasText: 'New folder "infra"' }).click();
  await expect(page.locator('#tab-list li.folder', { hasText: 'infra' })).toBeVisible();
  expect(host.tmux('show-options', '-v', '-t', '=main:', '@remotty-folders')).toBe('billing\ninfra\n');
});
