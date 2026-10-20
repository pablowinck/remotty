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

test('a folder can be renamed, reordered by dragging, and deleted without closing its agents', async ({ page, host }) => {
  host.tmux('new-window', '-d', '-t', '=main:', '-n', 'faturas');
  const faturas = host.windows().find((w) => w.name === 'faturas');
  host.tmux('set-option', '-t', '=main:', '@remotty-folders', 'a\nfront/back');
  host.tmux('set-option', '-w', '-t', faturas.id, '@remotty-folder', 'front/back');
  await pair(page, host);
  const folders = page.locator('#tab-list li.folder .name');
  const folderList = () => host.tmux('show-options', '-qv', '-t', '=main:', '@remotty-folders');
  await expect(folders).toHaveText(['a', 'front/back']);

  // Rename: a "/" in the name must survive the URL path.
  page.once('dialog', (d) => d.accept('billing'));
  await page.getByRole('button', { name: 'Options for folder front/back' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await expect(folders).toHaveText(['a', 'billing']);
  expect(host.tmux('show-options', '-wv', '-t', faturas.id, '@remotty-folder').trim()).toBe('billing');

  // Drag "billing" above "a".
  const from = await page.locator('#tab-list li.folder', { hasText: 'billing' }).boundingBox();
  const to = await page.locator('#tab-list li.folder', { hasText: /^a/ }).boundingBox();
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, to.y + to.height * 0.2, { steps: 10 });
  await expect(page.locator('#tab-list li.folder', { hasText: /^a/ })).toHaveClass(/drop-before/);
  await page.mouse.up();
  await expect.poll(folderList).toBe('billing\na\n');
  await expect(folders).toHaveText(['billing', 'a']);

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Options for folder billing' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(folders).toHaveText(['a']);
  await expect.poll(folderList).toBe('a\n');
  // The agent is still there, now loose.
  await expect(page.locator('#tab-list li[data-id]', { hasText: 'faturas' })).not.toHaveClass(/in-folder/);
  expect(host.windows().map((w) => w.name)).toContain('faturas');
});

test('Alt+1..9 follow the list as shown, and collapsing a folder renumbers the agents below', async ({ page, host }) => {
  for (const n of ['um', 'dois', 'tres']) host.tmux('new-window', '-d', '-t', '=main:', '-n', n);
  const id = (name) => host.windows().find((w) => w.name === name).id;
  // "tres" was made last, so tmux numbers it last; in a folder it is shown first.
  host.tmux('set-option', '-t', '=main:', '@remotty-folders', 'topo');
  host.tmux('set-option', '-w', '-t', id('tres'), '@remotty-folder', 'topo');
  await pair(page, host);
  await page.keyboard.press('Alt+1'); // open "tres", so the next step can show it moved away
  const chips = () => page.locator('#tab-list li[data-id]').evaluateAll((rows) =>
    rows.map((r) => `${r.querySelector('.name').textContent}=${r.querySelector('.hotkey')?.textContent ?? ''}`));
  await expect.poll(chips).toEqual(['tres=Alt 1', 'bash=Alt 2', 'um=Alt 3', 'dois=Alt 4']);

  await page.keyboard.press('Alt+4');
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('dois');
  await page.locator('#tab-list li.folder').click(); // collapse "topo": "tres" is hidden, not open
  await expect.poll(chips).toEqual(['bash=Alt 1', 'um=Alt 2', 'dois=Alt 3']);

  await page.keyboard.press('Alt+2');
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('um');
  await page.keyboard.type('echo em-um-$((2*3))\n');
  await expect.poll(() => host.capture(id('um'))).toContain('em-um-6');
});

test("a folder's ⋯ creates an agent inside it and opens it", async ({ page, host }) => {
  host.tmux('set-option', '-t', '=main:', '@remotty-folders', 'billing');
  await pair(page, host);
  page.once('dialog', (d) => d.accept('fatura-nova'));
  await page.getByRole('button', { name: 'Options for folder billing' }).click();
  await page.getByRole('menuitem', { name: 'New agent' }).click();
  const open = page.locator('#tab-list li[aria-current="true"]');
  await expect(open.locator('.name')).toHaveText('fatura-nova');
  await expect(open).toHaveClass(/in-folder/);
  const w = host.windows().find((x) => x.name === 'fatura-nova');
  expect(host.tmux('show-options', '-wv', '-t', w.id, '@remotty-folder').trim()).toBe('billing');
  // The keyboard is already in the new agent.
  await page.keyboard.type('echo dentro-$((6*7))\n');
  await expect.poll(() => host.capture(w.id)).toContain('dentro-42');
});

test("an agent's ⋯ Duplicate reruns its command in the same directory and folder", async ({ page, host }) => {
  host.tmux('set-option', '-t', '=main:', '@remotty-folders', 'billing');
  const [orig] = host.windows();
  host.tmux('set-option', '-w', '-t', orig.id, '@remotty-folder', 'billing');
  await pair(page, host);
  await typeInTerminal(page, "cd /tmp && sh -c 'echo \"rodando-$((3*5))-$(pwd)\"; sleep 300' x\n");
  await expect.poll(() => host.capture(orig.id)).toContain('rodando-15-/tmp');

  await page.locator('#tab-list li[aria-current="true"] .more').click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page.locator('#tab-list li[data-id]')).toHaveCount(2);
  const copy = host.windows().find((w) => w.id !== orig.id);
  await expect(page.locator('#tab-list li[aria-current="true"]')).toHaveAttribute('data-id', copy.id);
  await expect(page.locator('#tab-list li[aria-current="true"]')).toHaveClass(/in-folder/);
  await expect.poll(() => host.capture(copy.id)).toContain('rodando-15-/tmp');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('rodando-15-/tmp');
});

test('dragging the line resizes the agent list, double-clicking fits the longest name, and it survives a reload', async ({ page, host }) => {
  const long = 'um-agente-com-um-nome-bem-comprido-para-telas-grandes';
  host.tmux('new-window', '-d', '-t', '=main:', '-n', long);
  await pair(page, host);
  const tabs = page.locator('#tabs');
  const name = page.locator('#tab-list .name', { hasText: long });
  const cut = () => name.evaluate((e) => e.scrollWidth > e.clientWidth);
  await expect.poll(cut).toBe(true); // anchor: at the default width the name is cut

  const line = await page.locator('#tabs-resize').boundingBox();
  const before = (await tabs.boundingBox()).width;
  await page.mouse.move(line.x + line.width / 2, line.y + 100);
  await page.mouse.down();
  await page.mouse.move(line.x + 120, line.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await tabs.boundingBox()).width).toBeGreaterThan(before + 100);

  await page.locator('#tabs-resize').dblclick();
  await expect.poll(cut).toBe(false);
  const fitted = (await tabs.boundingBox()).width;
  expect(fitted).toBeGreaterThan(before + 120);

  await page.reload();
  await expect(name).toBeVisible();
  expect((await tabs.boundingBox()).width).toBeCloseTo(fitted, 0);
  expect(await cut()).toBe(false);
});

test('a folder goes inside another by dragging or by its ⋯ Move to, and carries its agents', async ({ page, host }) => {
  host.tmux('new-window', '-d', '-t', '=main:', '-n', 'seo');
  const seo = host.windows().find((w) => w.name === 'seo');
  host.tmux('set-option', '-t', '=main:', '@remotty-folders', 'jobs\nmovvia\nlpr');
  host.tmux('set-option', '-w', '-t', seo.id, '@remotty-folder', 'movvia');
  await pair(page, host);
  const folderList = () => host.tmux('show-options', '-qv', '-t', '=main:', '@remotty-folders');
  const folderOf = () => host.tmux('show-options', '-wqv', '-t', seo.id, '@remotty-folder').trim();
  const header = (name) => page.locator('#tab-list li.folder', { has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }) });
  // The poll redraws the list: a row measured mid-redraw has no box yet, so ask again.
  const box = async (loc) => { let b = null; await expect.poll(async () => (b = await loc.boundingBox())).not.toBeNull(); return b; };

  // Drag "movvia" onto the middle of "jobs": it goes inside, with "seo".
  const from = await box(header('movvia'));
  const to = await box(header('jobs'));
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, to.y + to.height / 2, { steps: 10 });
  await expect(header('jobs')).toHaveClass(/drop-into/);
  await page.mouse.up();
  await expect.poll(folderList).toBe('jobs\njobs\x1fmovvia\nlpr\n');
  await expect.poll(folderOf).toBe('jobs\x1fmovvia');
  await expect(page.locator('#tab-list li.folder .name')).toHaveText(['jobs', 'movvia', 'lpr']);
  const seoRow = page.locator('#tab-list li[data-id]', { hasText: 'seo' });
  // Each level sits further in: read all three in one go, so a redraw cannot split them.
  const indents = () => page.locator('#tab-list li').evaluateAll((rows) => rows
    .filter((r) => /^(jobs|movvia|seo)$/.test(r.querySelector('.name').textContent))
    .map((r) => parseFloat(getComputedStyle(r).paddingLeft)));
  await expect.poll(async () => { const [j, m, s] = await indents(); return j < m && m < s; }).toBe(true);

  // Collapsing "jobs" hides the folder inside it and its agent.
  await header('jobs').click();
  await expect(header('movvia')).toHaveCount(0);
  await expect(seoRow).toHaveCount(0);
  await expect(header('lpr')).toBeVisible();
  await header('jobs').click();

  // ⋯ Move to… lists the folders by path; "lpr" takes "jobs" and everything in it.
  await page.getByRole('button', { name: 'Options for folder jobs' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  await expect(page.getByRole('menuitem', { name: 'jobs / movvia' })).toHaveCount(0); // never into itself
  await page.getByRole('menuitem', { name: 'lpr' }).click();
  await expect.poll(folderList).toBe('lpr\nlpr\x1fjobs\nlpr\x1fjobs\x1fmovvia\n');
  await expect.poll(folderOf).toBe('lpr\x1fjobs\x1fmovvia');
  await expect(header('jobs')).toHaveAttribute('style', /--depth: 1\b/); // the list has caught up, so its ⋯ is the moved folder's

  // And back out to the top level.
  await page.getByRole('button', { name: 'Options for folder jobs' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  await page.getByRole('menuitem', { name: 'Top level' }).click();
  await expect.poll(folderList).toBe('lpr\njobs\njobs\x1fmovvia\n');
  await expect(seoRow).toBeVisible();
});
