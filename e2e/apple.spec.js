import { test, expect, pair, typeInTerminal } from './fixtures.js';

// A Mac keyboard in Chromium: the platform says Apple, the keys are Option and Cmd.
test.describe('on a Mac', () => {
  test.use({ platform: 'MacIntel', viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test('hints are written with the Mac modifier symbols', async ({ page, host }) => {
    host.tmux('new-window', '-d', '-t', '=main:', '-n', 'agente-1');
    await pair(page, host);
    await expect(page.locator('#find-key')).toHaveText('⌃⇧K');
    await expect(page.locator('#tabs-hint')).toContainText('⌥1–9');
    await expect(page.locator('#tab-list li[data-index="1"] .hotkey')).toHaveText('⌥1');
    await expect(page.locator('#tabs-hint')).not.toContainText('Alt'); // anchor above: the hint is there
  });

  // Option+2 on a Mac types "™" (key) on the Digit2 key (code). Matching on the
  // key made every Alt+N shortcut dead on a Mac, and "™" reached the shell.
  test('Option+number opens that agent and types nothing', async ({ page, host }) => {
    for (let i = 1; i <= 3; i++) host.tmux('new-window', '-d', '-t', '=main:', '-n', `agente-${i}`);
    const sent = [];
    page.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload !== 'string') sent.push(Buffer.from(f.payload).toString()); }));
    await pair(page, host);
    await typeInTerminal(page, 'x');
    await expect.poll(() => sent.includes('x')).toBe(true); // anchor: keys reach the socket
    await page.evaluate(() => document.querySelector('#terminal .xterm-helper-textarea')
      .dispatchEvent(new KeyboardEvent('keydown', { key: '™', code: 'Digit2', altKey: true, bubbles: true, cancelable: true })));
    await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('agente-2');
    expect(sent.filter((s) => s.includes('™') || s === '\x1b2')).toEqual([]);
    await page.keyboard.type('echo no-dois-$((1+1))\n');
    const two = host.windows().find((w) => w.name === 'agente-2');
    await expect.poll(() => host.capture(two.id)).toContain('no-dois-2');
  });

  // Chromium on a Mac pastes with Cmd+V only; Ctrl+V fires no paste event. So
  // Ctrl+V must reach the program as ^V (the literal-next key), as in Terminal.app.
  test('Ctrl+V is the ^V byte and Cmd+V pastes', async ({ page, host }) => {
    test.skip(process.platform !== 'darwin', 'Cmd+V pastes only in Chromium on macOS');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await pair(page, host);
    await page.evaluate(() => navigator.clipboard.writeText('colado-mac'));
    await typeInTerminal(page, 'IFS= read -r x; echo "got:[$x]" | od -c | head -1\n'); // IFS=: keep the leading tab
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+V'); // quoted insert: the next key goes in literally
    await page.keyboard.press('Tab');
    await page.keyboard.press('Meta+V');
    await page.keyboard.press('Enter');
    await expect.poll(() => host.capture(host.windows()[0].id)).toMatch(/g\s+o\s+t\s+:\s+\[\s+\\t\s+c\s+o\s+l\s+a\s+d\s+o/);
  });
});
