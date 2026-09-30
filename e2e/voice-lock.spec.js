import { test, expect, pair } from './fixtures.js';
import { statSync } from 'node:fs';

// Local: a phone that locks mid-note used to lose it. A Web Audio tone stands
// in for the mic (Chromium's fake device hangs on macOS), and a counting stub
// for the Wake Lock, which headless Chromium would refuse anyway.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__lock = { requested: 0, released: 0 };
    const sentinel = { release: async () => { window.__lock.released++; } };
    Object.defineProperty(navigator, 'wakeLock', { value: { request: async () => (window.__lock.requested++, sentinel) } });
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const tone = ctx.createOscillator();
      const out = ctx.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      await ctx.resume();
      window.__mic = out.stream;
      return out.stream;
    };
  });
});

const NOTE = /(\S+\/uploads\/\S*voice-\S+\.(?:webm|ogg|m4a))/;
const lock = (page) => page.evaluate(() => window.__lock);

test('recording keeps the screen awake until the note is sent', async ({ page, host }) => {
  await pair(page, host);
  const mic = page.getByRole('button', { name: 'Record a voice note' });
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => lock(page)).toEqual({ requested: 1, released: 0 });
  await page.waitForTimeout(800);
  await mic.click();

  const window = host.windows()[0].id;
  await expect.poll(() => host.capture(window)).toMatch(NOTE);
  await expect.poll(() => lock(page)).toEqual({ requested: 1, released: 1 });
});

test('the phone locking mid-note sends what was recorded', async ({ page, host }) => {
  await pair(page, host);
  const mic = page.getByRole('button', { name: 'Record a voice note' });
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  const window = host.windows()[0].id;
  await expect.poll(() => host.capture(window)).toMatch(NOTE);
  expect(statSync(host.capture(window).match(NOTE)[1]).size).toBeGreaterThan(0);
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  expect((await lock(page)).released).toBe(1);
});

// Local: a Home Screen app on iOS can get a mic that dies at once. Six notes in
// a row came out empty (2026-09-30) and each empty path was typed at the prompt.
test('a microphone the phone kills at once types nothing and says why', async ({ page, host }) => {
  await pair(page, host);
  const mic = page.getByRole('button', { name: 'Record a voice note' });
  const window = host.windows()[0].id;
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true'); // anchor: it did start
  await page.evaluate(() => window.__mic.getAudioTracks().forEach((t) => t.dispatchEvent(new Event('ended'))));
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#status')).toContainText('Nothing recorded (iOS cut the microphone)');
  await page.waitForTimeout(800);
  expect(host.capture(window)).not.toMatch(NOTE);
  expect((await lock(page)).released).toBe(1);

  // The next note, with a working mic, still goes through.
  await mic.click();
  await page.waitForTimeout(1600);
  await mic.click();
  await expect.poll(() => host.capture(window)).toMatch(NOTE);
});
