import { test, expect, pair, typeInTerminal } from './fixtures.js';

// A Mac keyboard in Chromium: the platform says Apple, the keys are Option and Cmd.
test.describe('on a Mac', () => {
  test.use({ platform: 'MacIntel', viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test('hints are written with the Mac modifier symbols', async ({ page, host }) => {
    host.tmux('new-window', '-d', '-t', '=main:', '-n', 'agente-1');
    await pair(page, host);
    await expect(page.locator('#find-key')).toHaveText('⌃⇧K');
    await expect(page.locator('#tab-list li[data-index="1"] .hotkey')).toHaveText('⌥2'); // second row
    await expect(page.locator('#tabs')).not.toContainText('Alt'); // anchor above: the chips are there
  });

  // As in Ghostty: ⌘T asks for a name first. Enter creates the agent
  // with that name, even when another agent's name contains it, and lands in
  // its terminal. Nothing reaches the shell the shortcut came from.
  test('⌘T asks for a name, and Enter creates that agent', async ({ page, host }) => {
    host.tmux('new-window', '-d', '-t', '=main:', '-n', 'revisor-pr');
    const sent = [];
    page.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload !== 'string') sent.push(Buffer.from(f.payload).toString()); }));
    await pair(page, host);
    await typeInTerminal(page, 'x');
    await expect.poll(() => sent.includes('x')).toBe(true); // anchor: keys reach the socket
    const before = host.windows().length;
    sent.length = 0;
    await page.keyboard.press('Meta+T');
    await expect(page.locator('#find')).toBeFocused();
    await expect(page.locator('#find')).toHaveAttribute('placeholder', /name/i);
    expect(host.windows()).toHaveLength(before); // nothing made before the name
    await page.keyboard.type('revisor');
    await page.keyboard.press('Enter');
    await expect.poll(() => host.windows().map((w) => w.name)).toContain('revisor');
    expect(sent.filter((s) => /t/i.test(s))).toEqual([]); // no "t" typed into the old agent
    await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('revisor');
    await page.keyboard.type('echo no-novo-$((3*3))\n');
    const fresh = () => host.windows().find((w) => w.name === 'revisor');
    await expect.poll(() => host.capture(fresh().id)).toContain('no-novo-9');
  });

  test('⌘T then Enter with no name creates an unnamed agent', async ({ page, host }) => {
    await pair(page, host);
    const before = host.windows().length;
    await page.locator('#terminal .xterm-helper-textarea').focus();
    await page.keyboard.press('Meta+T');
    await expect(page.locator('#find')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => host.windows().length).toBe(before + 1);
  });

  // ⌘W closes the open agent, not the app; ⌘Z brings the same one back with
  // its shell still running, not a fresh one.
  test('⌘W closes only the open agent, and ⌘Z reopens it still running', async ({ page, host }) => {
    host.tmux('new-window', '-d', '-t', '=main:', '-n', 'fecha-e-volta');
    await pair(page, host);
    await page.locator('#tab-list li', { hasText: 'fecha-e-volta' }).click();
    await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('fecha-e-volta');
    await typeInTerminal(page, 'export MARCA=viva-$((5*5))\n');
    const id = host.windows().find((w) => w.name === 'fecha-e-volta').id;
    await expect.poll(() => host.capture(id)).toContain('MARCA=viva');

    await page.keyboard.press('Meta+W');
    await expect.poll(() => host.windows().map((w) => w.id)).not.toContain(id);
    await expect(page.locator('#tab-list li', { hasText: 'fecha-e-volta' })).toHaveCount(0);
    await expect(page.locator('#app')).toBeVisible(); // the app is still there
    expect(host.windows().length).toBeGreaterThan(0); // anchor: another agent is open now

    await page.keyboard.press('Meta+Z');
    await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('fecha-e-volta');
    expect(host.windows().find((w) => w.name === 'fecha-e-volta').id).toBe(id); // the same window
    await typeInTerminal(page, 'echo "ainda=$MARCA"\n');
    await expect.poll(() => host.capture(id)).toContain('ainda=viva-25'); // its shell kept running
  });

  // ⌘E duplicates the open agent, like its ⋯ Duplicate, and nothing
  // reaches the shell the shortcut came from.
  test('⌘E duplicates the open agent and lands in the copy', async ({ page, host }) => {
    const [orig] = host.windows();
    const sent = [];
    page.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload !== 'string') sent.push(Buffer.from(f.payload).toString()); }));
    await pair(page, host);
    await typeInTerminal(page, "cd /tmp && echo dup-$((4*4)) && sleep 300\n");
    await expect.poll(() => host.capture(orig.id)).toContain('dup-16');
    sent.length = 0;
    await page.keyboard.press('Meta+E');
    await expect.poll(() => host.windows().length).toBe(2);
    const copy = host.windows().find((w) => w.id !== orig.id);
    await expect(page.locator('#tab-list li[aria-current="true"]')).toHaveAttribute('data-id', copy.id);
    await expect.poll(() => host.tmux('display', '-p', '-t', copy.id, '#{pane_current_path}').trim()).toMatch(/\/tmp$/);
    expect(sent.filter((s) => /e/i.test(s))).toEqual([]); // no "e" typed into the original
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
    await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('agente-1'); // second row
    expect(sent.filter((s) => s.includes('™') || s === '\x1b2')).toEqual([]);
    await page.keyboard.type('echo no-dois-$((1+1))\n');
    const two = host.windows().find((w) => w.name === 'agente-1');
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
