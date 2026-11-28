import { test, expect, pair, typeInTerminal } from './fixtures.js';

// Settings → Shortcuts rebinds the app's keys, per device. Click an action's
// keys, press the new ones: the app answers to those from then on.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

async function openShortcuts(page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Shortcuts' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Shortcuts' })).toBeVisible();
}
const keysOf = (page, label) => page.getByRole('button', { name: new RegExp(`^${label}:`) });
const done = (page) => page.getByRole('button', { name: 'Done' }).click();

test('a rebound Find answers to its new keys only, the hint says so, and it survives a reload', async ({ page, host }) => {
  const sent = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload !== 'string') sent.push(Buffer.from(f.payload).toString()); }));
  await pair(page, host);
  await typeInTerminal(page, 'x');
  await expect.poll(() => sent.includes('x')).toBe(true); // anchor: keys reach the socket
  await page.keyboard.press('Control+Shift+K');
  await expect(page.locator('#find')).toBeFocused(); // anchor: the default works first

  await openShortcuts(page);
  await keysOf(page, 'Find or create an agent').click();
  await expect(keysOf(page, 'Find or create an agent')).toHaveText('Press keys…');
  await page.keyboard.press('Alt+Shift+F');
  await expect(keysOf(page, 'Find or create an agent')).toHaveText('Alt⇧F');
  await done(page);
  await expect(page.locator('#find-key')).toHaveText('Alt ⇧ F');

  await page.locator('#terminal .xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+K');
  await expect(page.locator('#find')).not.toBeFocused();
  sent.length = 0;
  await page.keyboard.press('Alt+Shift+F');
  await expect(page.locator('#find')).toBeFocused();
  expect(sent).toEqual([]); // the shortcut never reached the shell (xterm would send ESC F)

  await page.reload();
  await expect(page.locator('#find-key')).toHaveText('Alt ⇧ F');
  await page.locator('#terminal .xterm-helper-textarea').focus();
  await page.keyboard.press('Alt+Shift+F');
  await expect(page.locator('#find')).toBeFocused();
});

test('keys another action had move over and say so; terminal keys are refused', async ({ page, host }) => {
  await pair(page, host);
  await openShortcuts(page);
  await keysOf(page, 'Find or create an agent').click();
  await page.keyboard.press('Control+C');
  await expect(page.getByRole('tabpanel', { name: 'Shortcuts' })).toContainText("is the terminal's interrupt");
  await page.keyboard.press('KeyF');
  await expect(page.getByRole('tabpanel', { name: 'Shortcuts' })).toContainText('typed into the terminal');
  await expect(keysOf(page, 'Find or create an agent')).toHaveText('Press keys…'); // still waiting, nothing bound

  await page.keyboard.press('Alt+ArrowDown');
  await expect(keysOf(page, 'Find or create an agent')).toHaveText('Alt↓');
  await expect(keysOf(page, 'Next agent')).toHaveText('None');
  await expect(page.getByRole('tabpanel', { name: 'Shortcuts' })).toContainText('Alt+↓ moved here from Next agent, which now has none');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(keysOf(page, 'Next agent')).toHaveText('Alt↓');
  await expect(keysOf(page, 'Find or create an agent')).toHaveText('Ctrl⇧K');
});

test('Open agent 1–9 takes the modifiers: the row chips follow, and the keys open that agent', async ({ page, host }) => {
  host.tmux('new-window', '-d', '-t', '=main:', '-n', 'segundo');
  await pair(page, host);
  await expect(page.locator('#tab-list li[data-index="1"] .hotkey')).toHaveText('Alt 2'); // anchor: the default chip
  await openShortcuts(page);
  await keysOf(page, 'Open agent 1–9').click();
  await page.keyboard.press('Control+Alt+3'); // any digit: the modifiers are what is kept
  await expect(keysOf(page, 'Open agent 1–9')).toHaveText('CtrlAlt1–9');
  await done(page);
  await expect(page.locator('#tab-list li[data-index="1"] .hotkey')).toHaveText('Ctrl Alt 2');

  await page.locator('#terminal .xterm-helper-textarea').focus();
  await page.keyboard.press('Alt+2');
  await expect(page.locator('#tab-list li[data-index="0"]')).toHaveAttribute('aria-current', 'true'); // the old keys do nothing
  await page.keyboard.press('Control+Alt+2');
  await expect(page.locator('#tab-list li[data-index="1"]')).toHaveAttribute('aria-current', 'true');
  await typeInTerminal(page, 'echo no-segundo-$((4*4))\n');
  const segundo = host.windows().find((w) => w.name === 'segundo');
  await expect.poll(() => host.capture(segundo.id)).toContain('no-segundo-16');
});

test('Esc cancels a recording without closing Settings; Backspace clears; the defaults come back', async ({ page, host }) => {
  await pair(page, host);
  await openShortcuts(page);
  await keysOf(page, 'Next agent').click();
  await expect(page.locator('.sc-row[data-id="next"]')).toContainText('Esc cancels · Backspace clears'); // the how-to, by the row
  await page.keyboard.press('Control+R');
  await expect(page.getByRole('alert')).toContainText('Ctrl+R sends a control key');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(keysOf(page, 'Next agent')).toHaveText('Alt↓');
  await expect(page.getByRole('alert')).toHaveCount(0); // the refusal goes with the wait
  await expect(page.getByText('Esc cancels · Backspace clears')).toHaveCount(0); // and so does the how-to

  await keysOf(page, 'Next agent').click();
  await page.keyboard.press('Backspace');
  await expect(keysOf(page, 'Next agent')).toHaveText('None');
  await page.getByRole('button', { name: 'Reset Next agent to default' }).click();
  await expect(keysOf(page, 'Next agent')).toHaveText('Alt↓');

  await keysOf(page, 'Previous agent').click();
  await page.keyboard.press('Backspace');
  await expect(keysOf(page, 'Previous agent')).toHaveText('None');
  await expect(page.locator('#shortcuts-changed')).toHaveText('1 changed from the default');
  const reset = page.locator('#shortcuts-reset');
  await reset.click();
  await expect(keysOf(page, 'Previous agent')).toHaveText('Alt↑');
  await expect(reset).toBeHidden(); // nothing left to reset
  await expect(page.locator('#shortcuts-changed')).toBeHidden(); // the note alone says it
  await page.locator('.pane-foot').getByRole('button', { name: 'Undo' }).click();
  await expect(keysOf(page, 'Previous agent')).toHaveText('None');
  await reset.click();
  await expect(keysOf(page, 'Previous agent')).toHaveText('Alt↑');
  await page.keyboard.press('Escape'); // not recording: Esc closes Settings
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('arrow keys move between the sections, and Settings reopens on the last one', async ({ page, host }) => {
  await pair(page, host);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('tab', { name: 'Appearance' })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Appearance' })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tab', { name: 'Shortcuts' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Shortcuts' })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Appearance' })).toBeHidden();
  await page.keyboard.press('Escape');
  await page.reload(); // the section is remembered past a reload of this tab
  await expect(page.locator('#stage')).toBeInViewport();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('tab', { name: 'Shortcuts' })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Shortcuts' })).toBeVisible();
});

// Off Apple, ⌘ is the Win or Super key the system keeps: the agent actions
// default to Alt+Shift there (Ctrl+Alt is AltGr on many layouts).
test('off Apple the agent actions default to Alt+Shift, and they reach the app, not the shell', async ({ page, host }) => {
  await pair(page, host);
  await typeInTerminal(page, 'echo pronto\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('pronto');
  const before = host.windows().length;
  await page.keyboard.press('Alt+Shift+D'); // duplicate the open agent
  await expect.poll(() => host.windows().length).toBe(before + 1);
  await expect(page.locator('#tab-list li[data-id]')).toHaveCount(before + 1);
  await expect(page.locator('#tab-list li[aria-current="true"]')).not.toHaveAttribute('data-index', '0'); // the copy is open
  await expect(page.locator('#terminal .xterm-helper-textarea')).toBeFocused();
  await page.keyboard.press('Alt+Shift+N');
  await expect(page.locator('#find')).toBeFocused();
  await expect(page.locator('#find')).toHaveAttribute('placeholder', /name/i);
  await page.keyboard.press('Escape');
  await openShortcuts(page);
  await expect(keysOf(page, 'New agent')).toHaveText('Alt⇧N');
  await expect(page.getByRole('tabpanel', { name: 'Shortcuts' })).not.toContainText('Win');
});

// Safari does not focus a clicked button: the keys must be caught page-wide.
test('a recording catches keys even when its button lost focus, and a click elsewhere ends it', async ({ page, host }) => {
  await pair(page, host);
  await openShortcuts(page);
  await keysOf(page, 'Next agent').click();
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Alt+Shift+J');
  await expect(keysOf(page, 'Next agent')).toHaveText('Alt⇧J');

  await keysOf(page, 'Previous agent').click();
  await expect(keysOf(page, 'Previous agent')).toHaveText('Press keys…');
  await page.getByRole('heading', { name: 'Shortcuts' }).click();
  await expect(keysOf(page, 'Previous agent')).toHaveText('Alt↑');
  await page.keyboard.press('Escape'); // no longer recording: Esc is the dialog's again
  await expect(page.getByRole('dialog')).toBeHidden();
});

// A held key repeats: a held close must close one agent, not every one in turn.
test('holding the close shortcut closes one agent, not one per repeat', async ({ page, host }) => {
  for (let i = 1; i <= 4; i++) host.tmux('new-window', '-d', '-t', '=main:', '-n', `agente-${i}`);
  await pair(page, host);
  await expect(page.locator('#tab-list li[data-id]')).toHaveCount(5);
  await page.locator('#terminal .xterm-helper-textarea').focus();
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.down('W');
  await expect.poll(() => host.windows().length).toBe(4); // anchor: one did close
  await expect(page.locator('#tab-list li[aria-current="true"]')).toHaveCount(1); // and its neighbour is open
  for (let i = 0; i < 3; i++) await page.keyboard.down('W'); // still held: these are repeats
  await page.keyboard.up('W');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
  await page.waitForTimeout(500);
  expect(host.windows()).toHaveLength(4);
});

// Option+N on a Mac types a dead key ("˜"), not N: the physical key is what counts.
test('an Option letter that types a dead key is recorded as its letter', async ({ page, host }) => {
  await pair(page, host);
  await openShortcuts(page);
  await page.getByText('Duplicate the open agent').click(); // the whole row starts recording
  await expect(keysOf(page, 'Duplicate the open agent')).toHaveText('Press keys…');
  await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Dead', code: 'KeyU', altKey: true, shiftKey: true, bubbles: true, cancelable: true })));
  await expect(keysOf(page, 'Duplicate the open agent')).toHaveText('Alt⇧U');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('Settings fills the screen with no sideways scroll in any section', async ({ page, host }) => {
    await pair(page, host);
    await page.locator('#menu').click();
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    expect((await dialog.boundingBox()).width).toBe(360);
    for (const name of ['Appearance', 'Key bar', 'Shortcuts']) {
      await page.getByRole('tab', { name }).tap();
      await expect(page.getByRole('tabpanel', { name })).toBeVisible();
      const over = await page.locator('.settings-body').evaluate((b) => b.scrollWidth - b.clientWidth);
      expect(over, name).toBeLessThanOrEqual(0);
    }
    await expect(page.getByText('this needs a hardware keyboard')).toBeVisible();
  });
});
