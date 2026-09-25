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
  const second = sizes.at(-1);
  await expect.poll(clientSize).toBe(`${second.cols}x${second.rows}`);
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
