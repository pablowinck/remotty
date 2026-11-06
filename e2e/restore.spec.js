import { test, expect, pair } from './fixtures.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// After a crash, Restore lists the Claude Code conversations that stopped and
// reopens the ones picked, each in its own window and directory. The host's
// HOME is the test dir, so a fake ~/.claude there is all Claude Code state it sees.
const ids = { deploy: '0e12d597-54fb-4759-85d3-66f8ea6d224f', fifa: '1f23e6a8-65ac-4860-96e4-77f9fb7e335a', old: '2a34f7b9-76bd-4971-a7f5-88a0ac8f446b' };

function fakeConversations(host) {
  const work = join(host.dir, 'projeto');
  mkdirSync(work);
  mkdirSync(join(host.dir, '.claude', 'projects', '-projeto'), { recursive: true });
  const write = (id, at, ...lines) =>
    writeFileSync(join(host.dir, '.claude', 'projects', '-projeto', `${id}.jsonl`), [`{"type":"user","cwd":"${work}","timestamp":"${at.toISOString()}"}`, ...lines].join('\n') + '\n');
  const now = new Date();
  write(ids.deploy, now, '{"type":"custom-title","customTitle":"deploy-da-semana"}');
  // Never /renamed: named by the title Claude Code gave it, not by its id.
  write(ids.fifa, now, '{"type":"ai-title","aiTitle":"Crashes no FIFA"}', '{"type":"last-prompt","lastPrompt":"ve o log do jogo"}');
  // Stopped 5 hours ago: offered, but not ticked, so it only comes back if asked for.
  write(ids.old, new Date(now - 5 * 3600e3), '{"type":"custom-title","customTitle":"coisa-velha"}');
  return work;
}

test('Restore reopens only the conversations picked', async ({ page, host }) => {
  const work = fakeConversations(host);
  await pair(page, host);

  await page.getByRole('button', { name: 'Restore' }).click();
  const dialog = page.getByRole('dialog', { name: 'Restore' });
  await expect(dialog.getByText('ve o log do jogo')).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Crashes no FIFA' })).toBeChecked(); // anchor for the next line
  await expect(dialog.getByRole('checkbox', { name: 'coisa-velha' })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'deploy-da-semana' }).uncheck();
  await dialog.getByRole('button', { name: 'Reopen 1' }).click();

  await expect(page.locator('#status')).toContainText('Reopened 1: Crashes no FIFA');
  await expect(page.locator('#tab-list .name', { hasText: 'Crashes no FIFA' })).toBeVisible();
  const w = host.windows().find((x) => x.name === 'Crashes no FIFA');
  expect(host.tmux('display-message', '-p', '-t', w.id, '#{pane_current_path}').trim()).toBe(work);
  expect(host.windows().filter((x) => x.name === 'deploy-da-semana' || x.name === 'coisa-velha')).toHaveLength(0); // the ones left out

  // Next time only the one left behind is offered: the other was just reopened.
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'deploy-da-semana' })).toBeVisible();
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(host.windows().filter((x) => x.name === 'deploy-da-semana')).toHaveLength(0); // Cancel reopens nothing
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('an icon in the strip, a sheet that fits, Reopen under the thumb', async ({ page, host }) => {
    fakeConversations(host);
    await pair(page, host);

    const button = page.getByRole('button', { name: 'Restore' });
    expect((await button.boundingBox()).width).toBeGreaterThanOrEqual(40); // thumb-sized, like "+"
    await button.tap();
    const dialog = page.getByRole('dialog', { name: 'Restore' });
    await dialog.getByRole('checkbox', { name: 'deploy-da-semana' }).tap();
    const go = dialog.getByRole('button', { name: 'Reopen 1' });
    const at = await go.boundingBox();
    expect(at.y + at.height).toBeLessThanOrEqual(780);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await go.tap();
    await expect(page.locator('#status')).toContainText('Reopened 1: Crashes no FIFA');
    expect(host.windows().map((x) => x.name)).toContain('Crashes no FIFA');
  });
});
