import { test, expect, pair, typeInTerminal } from './fixtures.js';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

// With tmux mouse on, a drag is tmux's copy mode, not an xterm selection. On
// release tmux copies and sends the text out as OSC 52; the page must honour it.
test('dragging over output copies it to the system clipboard', async ({ page, host }) => {
  host.tmux('set-option', '-g', 'mouse', 'on');
  await pair(page, host);
  await page.evaluate(() => navigator.clipboard.writeText('antes'));
  // Not `clear`: macOS's ncurses leaves the typed line in tmux's history, so the
  // drag began in copy mode one line up. Home, erase screen, erase history (E3).
  await typeInTerminal(page, 'printf "\\033[H\\033[2J\\033[3J"; echo copie-$((6*7))-agora\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('copie-42-agora');

  const row = page.locator('#terminal .xterm-rows > div', { hasText: /^copie-42-agora/ });
  const box = await row.boundingBox();
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 5 });
  await page.mouse.move(box.x + 160, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^copie-42/);
});

// Claude Code (and vim, helix...) copy a selection by printing OSC 52 itself.
// tmux's default set-clipboard is "external", which drops a program's own
// OSC 52; remotty must turn it on, or those copies never reach the page.
test('a program copying with OSC 52 reaches the system clipboard', async ({ page, host }) => {
  host.tmux('set-option', '-s', 'set-clipboard', 'external'); // the tmux default, stated
  await pair(page, host);
  await page.evaluate(() => navigator.clipboard.writeText('antes'));
  const b64 = Buffer.from('copiado-pelo-app').toString('base64');
  await typeInTerminal(page, `printf '\\033]52;c;${b64}\\a'; echo fim-copia\n`);
  await expect(page.locator('#terminal .xterm-rows')).toContainText('fim-copia'); // it ran
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('copiado-pelo-app');
});

// OSC 52 can also ask to READ the clipboard ("?"). Answering would hand the
// user's clipboard to whatever printed the sequence, so the page never does.
// tmux swallows a program's own OSC 52, so the sequences are sent through
// tmux passthrough to reach the page at all; the SET proves they do.
test('a program can set the clipboard but never read it through OSC 52', async ({ page, host }) => {
  host.tmux('set-option', '-g', 'allow-passthrough', 'on');
  await pair(page, host);
  await page.evaluate(() => navigator.clipboard.writeText('segredo-do-usuario'));
  const osc = (payload) => `printf '\\033Ptmux;\\033\\033]52;c;${payload}\\a\\033\\\\'`;
  await typeInTerminal(page, `${osc('?')}; echo fim-osc\n`);
  await expect(page.locator('#terminal .xterm-rows')).toContainText('fim-osc');
  await typeInTerminal(page, 'echo depois\n');
  await expect.poll(() => host.capture(host.windows()[0].id)).toMatch(/^depois$/m); // the shell ran on
  expect(host.capture(host.windows()[0].id)).not.toContain('segredo'); // nothing typed back
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('segredo-do-usuario');
  // Anchor: the same path does reach the page, so the silence above is a refusal.
  await typeInTerminal(page, `${osc(Buffer.from('via-osc').toString('base64'))}\n`);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('via-osc');
});

// Ctrl+V is paste, as in every desktop terminal. xterm.js would send it as the
// ^V byte instead, and Claude Code reads ^V as "paste an image from the host".
test('Ctrl+V pastes the clipboard text into the program', async ({ page, host }) => {
  // Chromium on a Mac binds paste to Cmd+V only; apple.spec.js covers that side.
  test.skip(process.platform === 'darwin', 'Chromium on macOS fires no paste for Ctrl+V');
  await pair(page, host);
  await page.evaluate(() => navigator.clipboard.writeText('colado-ok'));
  await typeInTerminal(page, 'read -r x; echo "got:[$x]"\n');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+V');
  await page.keyboard.press('Enter');
  await expect.poll(() => host.capture(host.windows()[0].id)).toMatch(/^got:\[colado-ok\]$/m);
});
