import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { installOperationsFixtures } from './fixtures/admin-operations.mjs';

assert.equal(process.env.CI, 'true');
const target = 'ccf3c05eba9e41abf112481bd8d590718462171f';
const artifacts = new URL('../work/entry-recut-headless/', import.meta.url);
const output = name => new URL(name, artifacts).pathname;
await mkdir(artifacts, { recursive: true });
const manifest = JSON.parse(await readFile(new URL('./fixtures/media/gateway-portrait-cdn.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--disable-dev-shm-usage'] });
const evidence = { target, provenance: 'deterministic-fixture', playback: [] };

async function verify(mobile) {
  const theme = 'light';
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1920, height: 1080 };
  const label = mobile ? 'mobile' : 'desktop';
  const ctx = await browser.newContext({ viewport, locale: 'zh-CN', colorScheme: theme,
    isMobile: mobile, hasTouch: mobile, reducedMotion: 'no-preference',
    ...(mobile ? {} : { recordVideo: { dir: output('raw/') } }) });
  try {
    const page = await ctx.newPage();
    await installOperationsFixtures(page, { quickstart: true });
    await page.addInitScript(() => {
      window.portraitEvidence = { seeking: 0, times: [] };
      document.addEventListener('seeking', event => {
        if (event.target.matches('.portrait-motion')) window.portraitEvidence.seeking++;
      }, true);
      const discover = new MutationObserver(() => {
        const movie = document.querySelector('.portrait-motion');
        if (!movie) return;
        discover.disconnect();
        const frame = (_now, metadata) => {
          window.portraitEvidence.times.push(metadata.mediaTime);
          if (!movie.ended && movie.isConnected) movie.requestVideoFrameCallback(frame);
        };
        movie.requestVideoFrameCallback(frame);
      });
      discover.observe(document, { childList: true, subtree: true });
    });
    await page.goto('http://127.0.0.1:8200/llmgw/login');
    await expect(page.locator('.consciousness-scene')).toHaveAttribute('data-portrait-theme', theme);
    await page.locator('#llmgw-username').fill('demo');
    await page.locator('#llmgw-password').fill('demo');
    await page.getByRole('button', { name: '开始身份确认', exact: true }).click();
    await page.waitForURL(/\/quickstart$/);
    const movie = page.locator('.portrait-motion');
    await expect(movie).toHaveAttribute('poster', manifest.light.opening.url);
    const moments = mobile ? [] : [.25, 2.86, 7.70];
    for (const time of moments) {
      await page.waitForFunction(t => document.querySelector('.portrait-motion')?.currentTime >= t, time, { timeout: 15000 });
      await page.screenshot({ path: output(`desktop-${time}.png`) });
    }
    await expect.poll(() => movie.evaluate(v => v.ended), { timeout: 15000 }).toBe(true);
    await expect(page.getByRole('textbox', { name: '我想做什么', exact: true })).toBeVisible();
    const result = await movie.evaluate(video => ({
      duration: video.duration, reached: video.currentTime, source: video.currentSrc, ...window.portraitEvidence,
      viewport: { width: innerWidth, height: innerHeight },
      touchPoints: navigator.maxTouchPoints,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    assert.equal(result.source, manifest.light.motion.url);
    assert.ok(Math.abs(result.duration - manifest.light.motion.durationSeconds) < .05);
    assert.equal(result.reached, result.duration);
    assert.equal(result.seeking, 0);
    assert.ok(result.times[0] <= .125);
    assert.ok(result.times.at(-1) >= 8.0);
    assert.equal(result.overflow, false);
    if (mobile) assert.ok(result.touchPoints > 0);
    await page.screenshot({ path: output(`${label}-settled.png`) });
    evidence.playback.push({ label, ...result });
    if (!mobile) {
      await page.waitForTimeout(450);
      const video = page.video();
      await ctx.close();
      await video.saveAs(output('daylight-preflight.webm'));
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}
try {
  await verify(false);
  await verify(true);
} finally {
  await browser.close();
  await writeFile(output('playback-evidence.json'), JSON.stringify(evidence, null, 2));
}
