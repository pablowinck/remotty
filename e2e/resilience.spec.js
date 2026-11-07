import { test, expect, pair, typeInTerminal, startHost } from './fixtures.js';

// Travel conditions: the connection drops, the host restarts, windows change
// under you. The agents live in tmux, so the page only has to find them again.

test('when the host restarts, the page reconnects to the same shell by itself', async ({ page, host }) => {
  await pair(page, host);
  await typeInTerminal(page, 'export MARCA=antes-$$\n');
  const port = new URL(host.origin).port;

  host.proc.kill();
  await expect(page.locator('#status')).toContainText(/Reconnecting/i);

  // Same port, same state dir, same tmux: what a service manager restart looks like.
  const again = await startHost(host.dir, ['-addr', `127.0.0.1:${port}`, '-origin', host.origin], { reuseTmux: true });
  host.proc = again.proc; // the fixture's teardown kills whatever runs now
  await expect(page.locator('#status')).toBeEmpty({ timeout: 10_000 });
  await typeInTerminal(page, 'echo "valor=$MARCA"\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText(/valor=antes-\d+/);
});

test('closing the open window from ssh moves the page to another window', async ({ page, host }) => {
  host.tmux('new-window', '-d', '-t', '=main:', '-n', 'sobra');
  await pair(page, host);
  const open = host.windows()[0];
  host.tmux('kill-window', '-t', open.id);
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('sobra', { timeout: 10_000 });
  await typeInTerminal(page, 'echo na-sobra\n');
  const sobra = host.windows().find((w) => w.name === 'sobra');
  await expect.poll(() => host.capture(sobra.id)).toContain('na-sobra');
});

test('a socket to a window that no longer exists never types into another window', async ({ page, host }) => {
  await pair(page, host);
  const live = host.windows()[0];
  const outcome = await page.evaluate(() => new Promise((ok) => {
    const s = new WebSocket(`ws://${location.host}/api/windows/@999/tty`);
    s.binaryType = 'arraybuffer';
    s.onopen = () => { s.send(new TextEncoder().encode('echo MARCA-DA-ABA-MORTA\r')); setTimeout(() => ok('open'), 500); };
    s.onerror = () => ok('refused');
  }));
  expect(outcome).toBe('refused');
  await page.waitForTimeout(300);
  expect(host.capture(live.id)).not.toContain('MARCA-DA-ABA-MORTA');
  // Anchor: the same socket to the live window does reach it.
  await page.evaluate((id) => new Promise((ok) => {
    const s = new WebSocket(`ws://${location.host}/api/windows/${encodeURIComponent(id)}/tty`);
    s.onopen = () => { s.send(new TextEncoder().encode('echo MARCA-VIVA\r')); setTimeout(ok, 500); };
  }), live.id);
  await expect.poll(() => host.capture(live.id)).toContain('MARCA-VIVA');
});

// Over a real network the WebSocket takes a while to open. Whatever the user
// types in that window must still reach the shell, in order.
test('keys typed before the terminal connects are not lost', async ({ page, host }) => {
  // Hold back new terminal sockets for 800 ms, like a slow tailnet handshake.
  // The route must exist before the page loads: one added later intercepts
  // nothing, and this test passed without holding anything until held was counted.
  let slow = false;
  let held = 0;
  await page.routeWebSocket(/\/tty(\?|$)/, async (ws) => { // the URL carries ?cols=&rows=
    if (slow) {
      held++;
      await new Promise((ok) => setTimeout(ok, 800));
    }
    ws.connectToServer();
  });
  await pair(page, host);
  slow = true;
  await page.getByRole('button', { name: 'New agent' }).click();
  await page.keyboard.type('lento');
  await page.keyboard.press('Enter');
  await typeInTerminal(page, 'echo primeira-$((1+1)); echo segunda-$((2+2))\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('segunda-4');
  const lento = host.windows().find((w) => w.name === 'lento');
  expect(host.capture(lento.id)).toMatch(/primeira-2[\s\S]*segunda-4/);
  expect(held).toBeGreaterThan(0); // anchor: the socket really was held back
});

test('a device revoked while the host is down is refused when it comes back', async ({ page, host }) => {
  await pair(page, host, 'viajante');
  const port = new URL(host.origin).port;
  host.proc.kill();
  const id = host.cli('devices').split('\n').find((l) => l.includes('viajante')).split(/\s+/)[0];
  host.cli('revoke', id);
  const again = await startHost(host.dir, ['-addr', `127.0.0.1:${port}`, '-origin', host.origin], { reuseTmux: true });
  host.proc = again.proc;
  await expect(page.getByRole('button', { name: 'Pair' })).toBeVisible({ timeout: 10_000 });
});

test('the reconnect loop stops hammering while the host is down', async ({ page, host }) => {
  await pair(page, host);
  let attempts = 0;
  page.on('websocket', () => attempts++);
  host.proc.kill();
  await page.waitForTimeout(6000);
  // A fixed 1 s retry would make ~6 attempts; backoff keeps it to a handful.
  expect(attempts).toBeGreaterThan(0); // anchor: it does retry
  expect(attempts).toBeLessThanOrEqual(4);
});

// A phone back from sleep can leave the handshake hanging with no error for
// minutes. The page gives up on it and retries instead of saying Reconnecting forever.
test('a handshake that hangs is retried, without switching agents', async ({ page, host }) => {
  let attempts = 0;
  await page.routeWebSocket(/\/tty(\?|$)/, async (ws) => {
    if (attempts++ === 1) return new Promise(() => {}); // the first reconnect never answers
    ws.connectToServer();
  });
  await pair(page, host);
  const port = new URL(host.origin).port;
  host.proc.kill();
  await expect(page.locator('#status')).toContainText(/Reconnecting/i);
  const again = await startHost(host.dir, ['-addr', `127.0.0.1:${port}`, '-origin', host.origin], { reuseTmux: true });
  host.proc = again.proc;
  await expect(page.locator('#status')).toBeEmpty({ timeout: 15_000 });
  await typeInTerminal(page, 'echo volta-$((4+4))\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('volta-8');
  expect(attempts).toBeGreaterThanOrEqual(3); // anchor: the hung one was really held
});

// The list's poll and the terminal fail apart. An error from a poll that failed
// once must go away when the next one works, not stay until you switch agents.
test('an error from one failed poll clears once the host answers again', async ({ page, host }) => {
  await pair(page, host);
  let fail = true;
  await page.route(/\/api\/windows$/, (r) => (fail ? r.abort('connectionrefused') : r.continue()));
  await expect(page.locator('#status')).not.toBeEmpty();
  fail = false;
  await expect(page.locator('#status')).toBeEmpty({ timeout: 5000 });
});

// After a long outage the terminal waits 8 s between tries. Once the list sees
// the host again, the terminal tries at once instead of waiting that out.
test('once the host is back, the terminal does not wait out its backoff', async ({ page, host }) => {
  test.setTimeout(45_000);
  await pair(page, host);
  const port = new URL(host.origin).port;
  host.proc.kill();
  await page.waitForTimeout(10_000); // past 0.5+1+2+4 s: the next try is 8 s away
  const again = await startHost(host.dir, ['-addr', `127.0.0.1:${port}`, '-origin', host.origin], { reuseTmux: true });
  host.proc = again.proc;
  const back = Date.now();
  await typeInTerminal(page, 'echo cedo-$((3+3))\n'); // queued until the terminal is connected
  await expect(page.locator('#terminal .xterm-rows')).toContainText('cedo-6', { timeout: 10_000 });
  expect(Date.now() - back).toBeLessThan(3500); // one poll (2 s) and a handshake
});
