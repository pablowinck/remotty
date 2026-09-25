import { test, expect, pair, typeInTerminal } from './fixtures.js';

test('pairs with a CLI code, runs a command and shows its output', async ({ page, host }) => {
  await pair(page, host);
  await typeInTerminal(page, 'echo resultado-$((6*7))\n');
  // Browser side: xterm rendered the evaluated result, not just the echoed command.
  await expect(page.locator('#terminal .xterm-rows')).toContainText('resultado-42');
  // Host side: tmux itself holds the same output, so the bytes really reached the shell.
  expect(host.capture(host.windows()[0].id)).toContain('resultado-42');
});

test('the browser view hides the tmux status bar without touching the user session', async ({ page, host }) => {
  await pair(page, host);
  await typeInTerminal(page, 'echo pronto\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('pronto');
  // The attached client is the browser; its session is the one to inspect.
  const [web] = host.tmux('list-clients', '-F', '#{client_session}').trim().split('\n');
  expect(web).not.toBe('main');
  // -A resolves inherited values; show-options does not accept the "=" exact-match prefix.
  const status = (session) => host.tmux('show-options', '-Av', '-t', session, 'status').trim();
  expect(status(web)).toBe('off');
  expect(status('main')).toBe('on'); // anchor: ssh/mosh still see their status bar
  await expect(page.locator('#terminal .xterm-rows')).not.toContainText('[main');
});

test('the terminal and its process survive a page reload', async ({ page, host }) => {
  await pair(page, host);
  await typeInTerminal(page, 'export MARCA=viva-$$; echo pronto\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('pronto');
  await page.reload();
  await typeInTerminal(page, 'echo "valor=$MARCA"\n');
  // Same shell after reload: only an expanded variable turns "$MARCA" into digits.
  await expect(page.locator('#terminal .xterm-rows')).toContainText(/valor=viva-\d+/);
});

test('key bar sends Ctrl+C to interrupt a running command', async ({ page, host }) => {
  await pair(page, host);
  // "$((1+1))" is echoed literally; only execution would print "nao-2-devia".
  // "&&", not ";": bash 3.2 (macOS) runs the rest of a ";" list after ^C.
  await typeInTerminal(page, 'sleep 300 && echo nao-$((1+1))-devia\n');
  await page.getByRole('button', { name: '^C' }).click();
  await typeInTerminal(page, 'echo interrompido-$((2+2))\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('interrompido-4');
  expect(host.capture(host.windows()[0].id)).not.toContain('nao-2-devia');
});

// Shift+Enter is "new line" in Claude Code; xterm.js sent a plain Enter, which
// submitted the prompt. It must reach the program as ESC CR (Meta+Enter).
// od shows the bytes (the pty's icrnl turns each CR into \n): a plain Enter
// would show as a bare \n, without the ESC (033) in front of it.
test('Shift+Enter and Alt+Enter send ESC CR, not a plain Enter', async ({ page, host }) => {
  await pair(page, host);
  await typeInTerminal(page, 'od -c\n');
  await page.waitForTimeout(300);
  for (const key of ['Shift+Enter', 'Alt+Enter']) await page.keyboard.press(key);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+D');
  await expect.poll(() => host.capture(host.windows()[0].id)).toMatch(/^0000000\s+033\s+\\n\s+033\s+\\n\s+\\n\s*$/m);
});

test('key bar Enter runs the typed command', async ({ page, host }) => {
  await pair(page, host);
  // No "\n": only the button can submit the line, and only execution turns $((3*5)) into 15.
  await typeInTerminal(page, 'echo enter-$((3*5))');
  await page.getByRole('button', { name: 'Enter' }).click();
  await expect(page.locator('#terminal .xterm-rows')).toContainText('enter-15');
  expect(host.capture(host.windows()[0].id)).toContain('enter-15');
});

test('Ctrl toggle turns the next key into a control character', async ({ page, host }) => {
  await pair(page, host);
  await typeInTerminal(page, 'echo linha-que-some');
  await page.getByRole('button', { name: 'Ctrl' }).click();
  await expect(page.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'true');
  await typeInTerminal(page, 'u'); // Ctrl+U erases the line
  await expect(page.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'false');
  await typeInTerminal(page, 'echo limpo\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('limpo');
  expect(host.capture(host.windows()[0].id)).not.toMatch(/linha-que-somee?cho limpo/);
});

// A plain window resize is one resize for tmux. Following every visual viewport
// event sent a size the page only passed through first, and every agent redrew
// twice; under load, tmux could keep the stale one for a moment.
test('a window resize sends one size, not a step through a passing one', async ({ page, host }) => {
  const sizes = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload === 'string') sizes.push(JSON.parse(f.payload)); }));
  await pair(page, host);
  await expect.poll(() => sizes.length).toBeGreaterThan(0); // anchor: the page reports its size
  await page.waitForTimeout(500);
  const before = sizes.length;
  await page.setViewportSize({ width: 700, height: 500 });
  await expect.poll(() => sizes.length).toBeGreaterThan(before);
  await page.waitForTimeout(800); // room for a second, stale step to show up
  expect(sizes.slice(before).map((s) => `${s.cols}x${s.rows}`)).toHaveLength(1);
});

test('tmux gets the size the browser measured, and follows it on resize', async ({ page, host }) => {
  const sizes = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    if (typeof f.payload === 'string') sizes.push(JSON.parse(f.payload));
  }));
  const clientSize = () => host.tmux('list-clients', '-F', '#{client_width}x#{client_height}').trim();

  await pair(page, host);
  await expect.poll(() => sizes.length).toBeGreaterThan(0);
  const first = sizes.at(-1);
  expect(first.cols).not.toBe(80); // the tablet is wider than the PTY default
  await expect.poll(clientSize).toBe(`${first.cols}x${first.rows}`);

  await page.setViewportSize({ width: 700, height: 500 });
  await expect.poll(() => sizes.at(-1).cols).toBeLessThan(first.cols);
  // A resize can arrive in steps (the visual viewport settles a frame later):
  // tmux must end at the last size the page sent, not the first.
  await expect.poll(() => clientSize() === `${sizes.at(-1).cols}x${sizes.at(-1).rows}`).toBe(true);
});

// Local: a gentle trackpad swipe barely scrolled. xterm sends at most one wheel
// report per event and keeps 30% of small ones; small events are now summed,
// one report per 36px. A little faster, never more than one report per 30px.
test('a gentle trackpad swipe sends a wheel step per 36px, not per ~57px', async ({ page, host }) => {
  host.tmux('set-option', '-g', 'mouse', 'on');
  const sent = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload !== 'string') sent.push(Buffer.from(f.payload).toString()); }));
  await pair(page, host);
  await typeInTerminal(page, 'for i in $(seq 1 300); do echo linha-$i; done\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('linha-300');
  await page.evaluate(() => {
    window.__px = 0;
    document.querySelector('#terminal .xterm-screen').addEventListener('wheel', (e) => { if (e.isTrusted) window.__px += Math.abs(e.deltaY); }, true);
  });
  const box = await page.locator('#terminal').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  sent.length = 0;
  for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, -30); await page.waitForTimeout(25); }
  await page.waitForTimeout(500);
  const px = await page.evaluate(() => window.__px);
  const reports = sent.filter((s) => /^\x1b\[<64;/.test(s)).length;
  expect(px).toBeGreaterThan(100); // anchor: the swipe really happened
  expect(reports).toBeGreaterThanOrEqual(Math.floor(px / 36) - 1);
  expect(reports).toBeLessThanOrEqual(Math.ceil(px / 30));
  expect(Number(host.tmux('display', '-p', '-t', host.windows()[0].id, '#{scroll_position}').trim())).toBeGreaterThan(0);
});

// tmux keeps the scrollback, not xterm: the tablet has to reach it by touch.
test('dragging a finger down scrolls back into the tmux history', async ({ page, host }) => {
  host.tmux('set-option', '-g', 'mouse', 'on'); // tmux's own default is off; most users turn it on
  await pair(page, host);
  await typeInTerminal(page, 'for i in $(seq 1 200); do echo linha-$i; done\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('linha-200');
  const box = await page.locator('#terminal').boundingBox();
  const x = box.x + box.width / 2;
  const drag = async (fromY, toY) => {
    const client = await page.context().newCDPSession(page);
    const point = (y) => [{ x, y }];
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(fromY) });
    for (let i = 1; i <= 10; i++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(fromY + ((toY - fromY) * i) / 10) });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const topLine = async () => Number((await page.locator('#terminal .xterm-rows').textContent()).match(/linha-(\d+)/)[1]);
  const before = await topLine();
  await drag(box.y + 60, box.y + box.height - 60); // finger moves down = look further up
  await expect.poll(topLine).toBeLessThan(before - 10);
  expect(host.tmux('display-message', '-p', '-t', host.windows()[0].id, '#{pane_in_mode}').trim()).toBe('1');
});

// Claude Code (fullscreen) takes the wheel itself, one line per notch under
// tmux: the content only keeps up with the finger if every row of travel
// reaches it as one wheel. xterm used to swallow ~2 of 3 small pixel deltas.
test('a finger drag reaches a mouse-reporting app as one wheel per row', async ({ page, host }) => {
  host.tmux('set-option', '-g', 'mouse', 'on');
  await pair(page, host);
  // SGR mouse reporting on; the tty echoes each report, e.g. ^[[<64;60;20M.
  await typeInTerminal(page, "printf '\\033[?1000h\\033[?1006h'; echo pronto-$((3*5)); cat -v\n");
  await expect(page.locator('#terminal .xterm-rows')).toContainText('pronto-15');
  const box = await page.locator('#terminal .xterm-screen').boundingBox();
  const rows = await page.evaluate(() => document.querySelectorAll('#terminal .xterm-rows > div').length);
  const client = await page.context().newCDPSession(page);
  const point = (y) => [{ x: box.x + box.width / 2, y }];
  const fromY = box.y + 40;
  const toY = box.y + box.height - 40;
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(fromY) });
  for (let i = 1; i <= 20; i++) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(fromY + ((toY - fromY) * i) / 20) });
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const travelled = (toY - fromY) / (box.height / rows);
  const wheels = () => (host.capture(host.windows()[0].id).match(/\[<64;/g) || []).length;
  await expect.poll(wheels).toBeGreaterThanOrEqual(Math.floor(travelled) - 1);
  expect(wheels()).toBeLessThanOrEqual(Math.ceil(travelled) + 1);
});
