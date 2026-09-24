import { test, expect, pair, typeInTerminal } from './fixtures.js';

// Everything here is keyboard only: no click after pairing.

test('Ctrl+Shift+K, a name and Enter create an agent and land in its terminal', async ({ page, host }) => {
  await pair(page, host);
  await typeInTerminal(page, 'echo pronto\n');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('pronto');

  await page.keyboard.press('Control+Shift+K');
  await page.keyboard.type('revisor');
  await page.keyboard.press('Enter');
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('revisor');

  // No click: the next keys must reach the new agent's shell.
  await page.keyboard.type('echo no-revisor-$((1+1))\n');
  const revisor = () => host.windows().find((w) => w.name === 'revisor');
  await expect.poll(() => revisor() && host.capture(revisor().id)).toContain('no-revisor-2');
});

test('typing filters the agents and Enter opens the match', async ({ page, host }) => {
  for (let i = 1; i <= 12; i++) host.tmux('new-window', '-d', '-t', '=main:', '-n', `agente-${i}`);
  await pair(page, host);

  await page.keyboard.press('Control+Shift+K');
  await page.keyboard.type('agente-1');
  // agente-1, agente-10, agente-11, agente-12. "agente-1" already exists, so
  // no "create" row: Enter must never make a duplicate by accident.
  await expect(page.locator('#tab-list li:not(.create)')).toHaveCount(4);
  await expect(page.locator('#tab-list li.create')).toHaveCount(0);

  await page.keyboard.press('ArrowDown'); // from agente-1 to agente-10
  await page.keyboard.press('Enter');
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('agente-10');
  await expect(page.locator('#tab-list li')).toHaveCount(13); // filter cleared
  await page.keyboard.type('echo no-dez-$((5*2))\n');
  const target = host.windows().find((w) => w.name === 'agente-10');
  await expect.poll(() => host.capture(target.id)).toContain('no-dez-10');
});

test('a window number finds that window', async ({ page, host }) => {
  for (let i = 1; i <= 12; i++) host.tmux('new-window', '-d', '-t', '=main:', '-n', `agente-${i}`);
  await pair(page, host);
  await page.keyboard.press('Control+Shift+K');
  await page.keyboard.type('7');
  await expect(page.locator('#tab-list li:not(.create) .name')).toHaveText(['agente-7']);
});

test('Esc clears the filter and gives the keyboard back to the terminal', async ({ page, host }) => {
  await pair(page, host);
  await page.keyboard.press('Control+Shift+K');
  await page.keyboard.type('nada-com-isso');
  await expect(page.locator('#tab-list li:not(.create)')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#tab-list li')).toHaveCount(1);
  await page.keyboard.type('echo voltei-$((4+4))\n');
  await expect.poll(() => host.capture(host.windows()[0].id)).toContain('voltei-8');
});

// The shortcut is for the page, not the shell: the half-typed line must survive
// opening the finder and coming back. Were it sent as Ctrl+K (erase to end of
// line) with the cursor moved left first, "resto" would be cut.
test('the shortcut never reaches the terminal', async ({ page, host }) => {
  // Listen before pairing: the terminal socket opens during pair().
  const sent = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload !== 'string') sent.push(Buffer.from(f.payload)); }));
  await pair(page, host);
  await typeInTerminal(page, 'echo linha-$((3+3))-resto');
  await expect.poll(() => sent.length).toBeGreaterThan(0); // anchor: the socket carries keystrokes
  sent.length = 0;
  await page.keyboard.press('Control+Shift+K');
  await page.keyboard.press('Escape');
  // tmux 3.5+ queries the terminal on attach (DA1, DA2, OSC 10/11 colours), and
  // xterm's answers can go out after the anchor: replies, not keystrokes.
  const reply = /^\x1b(\[[?>][\d;]*c|\]1[01];rgb:[\da-f/]+\x1b\\)$/;
  expect(sent.filter((b) => !reply.test(b.toString()))).toEqual([]); // not one keystroke reached the shell
  await page.keyboard.press('Enter');
  await expect.poll(() => host.capture(host.windows()[0].id)).toContain('linha-6-resto');
});

test('a partial match still offers to create a new agent with that name', async ({ page, host }) => {
  host.tmux('new-window', '-d', '-t', '=main:', '-n', 'revisor-pr');
  await pair(page, host);
  await page.keyboard.press('Control+Shift+K');
  await page.keyboard.type('revisor');
  await expect(page.locator('#tab-list li.create')).toHaveText('+ New agent "revisor"');
  await page.keyboard.press('ArrowDown'); // past revisor-pr, onto "create"
  await page.keyboard.press('Enter');
  await expect(page.locator('#tab-list li[aria-current="true"] .name')).toHaveText('revisor');
  expect(host.windows().map((w) => w.name)).toEqual(expect.arrayContaining(['revisor', 'revisor-pr']));
});

// Opening the window that is already on screen does not reconnect, so nothing
// else gives the keyboard back: only the finder can.
test('Enter on the current agent hands the keyboard back to its terminal', async ({ page, host }) => {
  host.tmux('rename-window', '-t', host.windows()[0].id, 'unico');
  await pair(page, host);
  await page.keyboard.press('Control+Shift+K');
  await page.keyboard.type('unico');
  await page.keyboard.press('Enter');
  await page.keyboard.type('echo de-volta-$((7+1))\n');
  await expect.poll(() => host.capture(host.windows()[0].id)).toContain('de-volta-8');
});
