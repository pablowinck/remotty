import { test, expect, pair, typeInTerminal } from './fixtures.js';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readTerminalQR } from './qr.js';

test('an unpaired browser gets the pairing screen and no API access', async ({ page, host }) => {
  await page.goto(host.origin);
  await expect(page.getByRole('button', { name: 'Pair' })).toBeVisible();
  const status = await page.evaluate(async () => (await fetch('/api/windows')).status);
  expect(status).toBe(401);
});

test('the link printed by `remotty pair` pairs in one step and drops the code from the URL', async ({ page, host }) => {
  const printed = host.cli('pair');
  const link = printed.match(/open this link on the device: (\S+)/)?.[1];
  expect(link, printed).toBeTruthy();
  await page.goto(link);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#pair')).toBeHidden();
  expect(page.url()).not.toContain('#'); // the code does not linger in history or bookmarks
});

test('a wrong code is refused and a used code cannot pair twice', async ({ page, host, browser }) => {
  await page.goto(host.origin);
  await page.getByLabel('Code').fill('AAAAA-AAAAA');
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.locator('#pair-error')).toContainText('invalid');

  const code = host.pairCode();
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.locator('#app')).toBeVisible(); // anchor: the right code works

  const other = await browser.newPage();
  await other.goto(host.origin);
  await other.getByLabel('Code').fill(code);
  await other.getByRole('button', { name: 'Pair' }).click();
  await expect(other.locator('#pair-error')).toContainText('invalid');
  await other.close();
});

// Tests reach the host as http://localhost, where the cookie cannot be Secure
// (Safari drops it); it is still HttpOnly and Strict. The tailnet's __Host-
// cookie, Secure included, is pinned by TestPairingCookieIsLockedDown in Go.
test('the device cookie is HttpOnly and SameSite=Strict', async ({ page, host, context }) => {
  await pair(page, host);
  const [cookie] = (await context.cookies()).filter((c) => c.name === 'remotty-local');
  expect(cookie).toMatchObject({ httpOnly: true, secure: false, sameSite: 'Strict', path: '/' });
  expect(await page.evaluate(() => document.cookie)).not.toContain('remotty');
});

test('revoking a device closes its terminal and sends it back to pairing', async ({ page, host }) => {
  await pair(page, host, 'para-revogar');
  await typeInTerminal(page, 'echo antes\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('antes');
  const id = host.cli('devices').split('\n').find((l) => l.includes('para-revogar')).split(/\s+/)[0];
  host.cli('revoke', id);
  await expect(page.getByRole('button', { name: 'Pair' })).toBeVisible({ timeout: 5000 });
});

// A real attacker site on another port, open in the same browser that holds
// the victim's cookie. WebSockets ignore CORS and a no-cors form-style POST
// still reaches the server, so only the host's Origin check stands in the way.
test('a page on another origin cannot open a terminal or create windows', async ({ page, host }) => {
  await pair(page, host);
  const attacker = createServer((_, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<h1>evil</h1>'); });
  await new Promise((ok) => attacker.listen(0, '127.0.0.1', ok));
  const evil = await page.context().newPage();
  await evil.goto(`http://localhost:${attacker.address().port}/`);

  const attempt = await evil.evaluate(async (target) => {
    await fetch(`${target}/api/windows`, { method: 'POST', mode: 'no-cors', credentials: 'include', body: '{"name":"invasor"}' }).catch(() => {});
    return new Promise((ok) => {
      const s = new WebSocket(`${target.replace('http', 'ws')}/api/windows/@0/tty`);
      s.onopen = () => ok('open');
      s.onerror = () => ok('refused');
    });
  }, host.origin);

  expect(attempt).toBe('refused');
  expect(host.windows().map((w) => w.name)).not.toContain('invasor');
  // Anchor: the same two calls from the real origin succeed, so the refusals above come from the Origin check.
  const legit = await page.evaluate(async () => {
    const post = await fetch('/api/windows', { method: 'POST', body: '{"name":"legitimo"}' });
    const id = (await post.json()).id;
    return new Promise((ok) => {
      const s = new WebSocket(`ws://${location.host}/api/windows/${encodeURIComponent(id)}/tty`);
      s.onopen = () => { s.close(); ok('open'); };
      s.onerror = () => ok('refused');
    });
  });
  expect(legit).toBe('open');
  expect(host.windows().map((w) => w.name)).toContain('legitimo');
  attacker.close();
});

test('every response carries the strict CSP, even errors', async ({ request, host }) => {
  for (const path of ['/', '/api/windows', '/does-not-exist.js']) {
    const res = await request.get(`${host.origin}${path}`);
    expect(res.headers()['content-security-policy'], path).toContain("script-src 'self'");
    expect(res.headers()['content-security-policy'], path).not.toContain('unsafe-eval');
    expect(res.headers()['content-security-policy-report-only'], path).toBeUndefined();
  }
});

test('the host only listens on loopback', async ({ host }) => {
  const port = new URL(host.origin).port;
  const lines = process.platform === 'darwin' // no ss on macOS
    ? execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('n'))
    : execFileSync('ss', ['-ltnH', `sport = :${port}`], { encoding: 'utf8' }).trim().split('\n');
  expect(lines.length).toBeGreaterThan(0); // anchor: we found the listener
  for (const l of lines) expect(l).toMatch(/127\.0\.0\.1:\d+/);
});

test('the QR code printed by `remotty pair` pairs the device that scans it', async ({ page, host }) => {
  const printed = host.cli('pair');
  const scanned = readTerminalQR(printed);
  const typedLink = printed.match(/open this link on the device: (\S+)/)?.[1];
  expect(scanned).toBe(typedLink); // the picture says what the text says
  await page.goto(scanned);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#pair')).toBeHidden();
});
