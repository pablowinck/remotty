import { test, expect, pair } from './fixtures.js';
import { mkdirSync, readFileSync, readdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A tiny valid PNG, so the test exercises a real image and not just text.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('attaching a photo saves it on the host and types its path into the terminal', async ({ page, host }) => {
  await pair(page, host);
  await page.locator('#attach-input').setInputFiles({ name: 'print do erro.png', mimeType: 'image/png', buffer: PNG });

  // The path lands at the prompt, ready for "look at <path>".
  const window = host.windows()[0].id;
  await expect.poll(() => host.capture(window)).toMatch(/\/uploads\/\S+print_do_erro\.png/);
  const path = host.capture(window).match(/(\S+\/uploads\/\S+print_do_erro\.png)/)[1];
  expect(readFileSync(path)).toEqual(PNG); // byte for byte
  expect(path.startsWith(join(host.dir, 'state', 'uploads'))).toBe(true);
});

// A program that asked for bracketed paste, as Claude Code does, gets the path
// pasted: that is how it tells a dropped image from a path typed by hand.
test('the path is pasted to a program that takes bracketed paste', async ({ page, host }) => {
  await pair(page, host);
  const window = host.windows()[0].id;
  host.tmux('send-keys', '-t', window, `printf '\\033[?2004h'; echo ready-$((2*3)); IFS= read -rsd ' ' x; printf 'got:%s\\n' "$x" | cat -v`, 'Enter');
  await expect(page.locator('#terminal .xterm-rows')).toContainText('ready-6'); // xterm has seen the mode by now
  await page.locator('#attach-input').setInputFiles({ name: 'colado.png', mimeType: 'image/png', buffer: PNG });

  const pasted = /got:\^\[\[200~\S+\/uploads\/\S+colado\.png\^\[\[201~/;
  await expect.poll(() => host.capture(window)).toMatch(pasted);
  await expect(page.locator('#terminal .xterm-rows')).toContainText(pasted);
});

// A file over 50 MB is not copied. The host finds it by name and size and
// pastes its own path, escaped as a desktop terminal does.
test('a file too big to upload is pasted where it already is on the host', async ({ page, host }) => {
  await pair(page, host);
  const MB50 = 50 * 1024 * 1024;
  mkdirSync(join(host.dir, 'Downloads', 'pasta x'), { recursive: true });
  const big = join(host.dir, 'Downloads', 'pasta x', 'grande (1).mov');
  writeFileSync(big, '');
  truncateSync(big, MB50 + 1);
  const window = host.windows()[0].id;
  host.tmux('send-keys', '-t', window, '-l', "printf 'got:%s\\n' ");
  const drop = await page.evaluateHandle((size) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(size)], 'grande (1).mov'));
    return dt;
  }, MB50 + 1);
  await page.locator('#terminal').dispatchEvent('drop', { dataTransfer: drop });

  await expect.poll(() => host.capture(window)).toContain('pasta\\ x/grande\\ \\(1\\).mov');
  host.tmux('send-keys', '-t', window, 'Enter');
  await expect.poll(() => host.capture(window)).toContain(`got:${big}`); // the shell reads it as one path
  await expect(page.locator('#terminal .xterm-rows')).toContainText(`got:${big}`);
  let files = [];
  try { files = readdirSync(join(host.dir, 'state', 'uploads')); } catch {}
  expect(files).toEqual([]); // found, not copied
});

test('an unpaired browser cannot upload', async ({ page, host }) => {
  await page.goto(host.origin);
  const status = await page.evaluate(async () => (await fetch('/api/uploads?name=x.png', { method: 'POST', body: 'x' })).status);
  expect(status).toBe(401);
  let files = [];
  try { files = readdirSync(join(host.dir, 'state', 'uploads')); } catch {}
  expect(files).toEqual([]);
  // Anchor: after pairing, the same request is accepted.
  await pair(page, host);
  const paired = await page.evaluate(async () => (await fetch('/api/uploads?name=x.png', { method: 'POST', body: 'x' })).status);
  expect(paired).toBe(201);
});

// The picker takes several files at once; every path is typed, in order.
test('attaching several files types every path', async ({ page, host }) => {
  await pair(page, host);
  await page.locator('#attach-input').setInputFiles([
    { name: 'um.png', mimeType: 'image/png', buffer: PNG },
    { name: 'dois.txt', mimeType: 'text/plain', buffer: Buffer.from('segundo') },
  ]);
  const window = host.windows()[0].id;
  await expect.poll(() => host.capture(window)).toMatch(/\/uploads\/\S+um\.png \S+\/uploads\/\S+dois\.txt/);
});

// Dropping files from the desktop onto the page attaches them like the picker.
test('dropping files on the page attaches them', async ({ page, host }) => {
  await pair(page, host);
  const drop = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['conteudo-solto'], 'solto.txt', { type: 'text/plain' }));
    dt.items.add(new File(['outro'], 'outro.log', { type: 'text/plain' }));
    return dt;
  });
  const target = page.locator('#terminal');
  await target.dispatchEvent('dragenter', { dataTransfer: drop });
  await target.dispatchEvent('dragover', { dataTransfer: drop });
  await expect(page.locator('body')).toHaveClass(/dropping/); // the page shows where to drop
  await target.dispatchEvent('drop', { dataTransfer: drop });
  await expect(page.locator('body')).not.toHaveClass(/dropping/);

  const window = host.windows()[0].id;
  await expect.poll(() => host.capture(window)).toMatch(/\/uploads\/\S+solto\.txt \S+\/uploads\/\S+outro\.log/);
  const path = host.capture(window).match(/(\S+\/uploads\/\S+solto\.txt)/)[1];
  expect(readFileSync(path, 'utf8')).toBe('conteudo-solto');
});

// Dragging text (not files) inside the page is not an upload.
test('dropping plain text does not upload anything', async ({ page, host }) => {
  await pair(page, host);
  const drop = await page.evaluateHandle(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'so texto'); return dt; });
  await page.locator('#terminal').dispatchEvent('dragover', { dataTransfer: drop });
  await expect(page.locator('body')).not.toHaveClass(/dropping/);
  await page.locator('#terminal').dispatchEvent('drop', { dataTransfer: drop });
  await page.waitForTimeout(300);
  let files = [];
  try { files = readdirSync(join(host.dir, 'state', 'uploads')); } catch {}
  expect(files).toEqual([]);
});
