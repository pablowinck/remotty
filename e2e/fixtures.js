// Every test gets a private world: its own host process on a random port, its
// own tmux server socket, its own state dir and a clean environment. Nothing
// touches the developer's tmux or credentials.
import { test as base, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

export const BIN = resolve(process.env.REMOTTY_BIN || join(import.meta.dirname, '..', 'bin', 'remotty'));

// tmux may live outside the system dirs (Homebrew on macOS: /opt/homebrew/bin).
const TMUX_DIR = (process.env.PATH || '').split(delimiter).find((d) => d && existsSync(join(d, 'tmux')));

// Only what a shell needs. HOME points at the temp dir so rc files and
// credentials of the real user are out of reach.
function cleanEnv(dir) {
  const PATH = [TMUX_DIR, '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(delimiter);
  // macOS's /bin/bash (3.2) greets every shell with a "default shell is now zsh" banner.
  return { PATH, HOME: dir, SHELL: '/bin/bash', LANG: 'C.UTF-8', REMOTTY_STATE_DIR: join(dir, 'state'), BASH_SILENCE_DEPRECATION_WARNING: '1' };
}

export class Host {
  constructor(dir, proc, origin) {
    this.dir = dir;
    this.proc = proc;
    this.origin = origin;
    this.socket = join(dir, 'tmux.sock');
    this.env = cleanEnv(dir);
  }

  cli(...args) {
    return execFileSync(BIN, args, { env: this.env, encoding: 'utf8' });
  }

  pairCode() {
    return JSON.parse(this.cli('pair', '--json')).code;
  }

  tmux(...args) {
    return execFileSync('tmux', ['-S', this.socket, ...args], { encoding: 'utf8' });
  }

  // What tmux itself shows in a window: the ground truth the browser is compared to.
  // -J joins lines tmux wrapped only because the pane was narrow, so a long
  // path or sentence reads back as one line.
  capture(windowId) {
    return this.tmux('capture-pane', '-p', '-J', '-t', windowId);
  }

  windows() {
    return this.tmux('list-windows', '-t', '=main', '-F', '#{window_id}\t#{window_name}')
      .trim().split('\n').map((l) => { const [id, name] = l.split('\t'); return { id, name }; });
  }
}

// startHost runs the binary against dir. reuseTmux restarts only the host, the
// way a service manager would, leaving the tmux server and its shells running.
export async function startHost(dir, extraArgs = [], { reuseTmux = false } = {}) {
  const env = cleanEnv(dir);
  if (!reuseTmux) {
    // Start tmux with a bare shell first, so new windows never read the user's rc files.
    execFileSync('tmux', ['-S', join(dir, 'tmux.sock'), '-f', '/dev/null', 'new-session', '-d', '-s', 'main', '-x', '120', '-y', '40', 'bash --norc --noprofile'], { env });
    execFileSync('tmux', ['-S', join(dir, 'tmux.sock'), 'set-option', '-g', 'default-command', 'bash --norc --noprofile'], { env });
  }
  const proc = spawn(BIN, ['serve', '-addr', '127.0.0.1:0', '-tmux-socket', join(dir, 'tmux.sock'), ...extraArgs], { env });
  const origin = await new Promise((ok, fail) => {
    let out = '';
    const timer = setTimeout(() => fail(new Error(`host did not start: ${out}`)), 10_000);
    proc.stdout.on('data', (d) => {
      out += d;
      const port = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
      if (port) { clearTimeout(timer); ok(`http://localhost:${port}`); }
    });
    proc.stderr.on('data', (d) => (out += d));
    proc.on('exit', (code) => fail(new Error(`host exited ${code}: ${out}`)));
  });
  return new Host(dir, proc, origin);
}

function stop(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((ok) => { proc.once('exit', ok); proc.kill(); });
}

export const test = base.extend({
  host: async ({}, use) => {
    // realpath: on macOS the temp dir is under /var, a symlink tmux reports as /private/var.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'remotty-e2e-')));
    // The UI is reached as http://localhost:PORT, so that is the allowed origin.
    const host = await startHost(dir, ['-origin', 'http://localhost:0']);
    await use(host);
    // kill() only sends the signal: wait for the exit, or the host may still be
    // writing its state (device renewal) while the directory is being removed.
    await stop(host.proc);
    try { execFileSync('tmux', ['-S', host.socket, 'kill-server']); } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  },

  // A page that records every request leaving the host's origin and every CSP
  // violation. Both are needed: CSP blocks before the network, so the request
  // log alone would stay empty and prove nothing.
  // navigator.platform is the host's, whatever device is emulated: headless
  // Chromium on a Mac says "MacIntel" while it plays an Android tablet. Pinned,
  // so a test means the same everywhere; apple.spec.js sets an Apple one.
  platform: ['Linux x86_64', { option: true }],

  page: async ({ page, host, platform }, use) => {
    await page.addInitScript((p) => Object.defineProperty(Navigator.prototype, 'platform', { get: () => p, configurable: true }), platform);
    const foreign = [];
    const violations = [];
    page.on('request', (r) => { if (!r.url().startsWith(host.origin) && !r.url().startsWith('data:')) foreign.push(r.url()); });
    await page.exposeFunction('__reportViolation', (v) => violations.push(v));
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.__reportViolation(`${e.violatedDirective} ${e.blockedURI}`)));
    await use(page);
    expect(foreign, 'requests left the host origin').toEqual([]);
    expect(violations, 'CSP violations').toEqual([]);
  },
});

export { expect };

// pair() walks the real pairing UI with a code minted by the real CLI.
export async function pair(page, host, name = 'e2e') {
  await page.goto(host.origin);
  await page.getByLabel('Code').fill(host.pairCode());
  await page.getByLabel('Device name').fill(name);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.locator('#app')).toBeVisible();
  // #app can be "visible" while the pairing card still covers the screen above it.
  await expect(page.locator('#pair')).toBeHidden();
  await expect(page.locator('#stage')).toBeInViewport();
}

// typeInTerminal sends keystrokes through xterm.js exactly as a keyboard would.
export async function typeInTerminal(page, text) {
  await page.locator('#terminal .xterm-helper-textarea').focus();
  await page.keyboard.type(text);
}
