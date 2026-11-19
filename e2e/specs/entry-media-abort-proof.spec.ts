import { expect, test } from '@playwright/test';
import { installOperationsFixtures } from '../fixtures/admin-operations.mjs';
import { readFileSync } from 'node:fs';

const assets = JSON.parse(readFileSync(new URL('../fixtures/media/gateway-portrait-cdn.json', import.meta.url), 'utf8'));

type ProbeWindow = Window & { entryMediaRejections: string[] };

test('系统主题变化中止未就绪视频后，新视频保留结尾', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const rejections: string[] = [];
    (window as ProbeWindow).entryMediaRejections = rejections;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const started = play.call(this);
      void started.catch((reason: DOMException) => rejections.push(reason.name));
      return started;
    };
  });
  await installOperationsFixtures(page, { quickstart: true });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(assets.light.motion.url, async route => {
    await gate;
    await route.abort().catch(() => {});
  });
  try {
    await page.goto('http://127.0.0.1:8200/llmgw/login', { waitUntil: 'domcontentloaded' });
    await page.locator('#llmgw-username').fill('demo');
    await page.locator('#llmgw-password').fill('demo');
    await page.getByRole('button', { name: '开始身份确认', exact: true }).click();
    await expect(page).toHaveURL(/\/quickstart$/);
    const movie = page.locator('video.portrait-motion');
    await expect(movie).toHaveAttribute('src', assets.light.motion.url);
    await expect(movie).toHaveJSProperty('paused', false);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(movie).toHaveAttribute('src', assets.dark.motion.url);
    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).entryMediaRejections)).toContain('AbortError');
    await expect(page.locator('html')).not.toHaveAttribute('data-entry-arriving', '');
    await expect(movie).toHaveJSProperty('paused', true);
    await expect(movie).toHaveJSProperty('currentSrc', assets.dark.motion.url);
    expect(await movie.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(5.1);
  } finally {
    release();
  }
});
