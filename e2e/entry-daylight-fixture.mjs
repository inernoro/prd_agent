/** Cloud-only visual recording of the built Gateway with isolated login and business responses. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { installOperationsFixtures } from './fixtures/admin-operations.mjs';
import { recordEntryDesktop } from './entry-record-desktop.mjs';

assert.equal(process.env.CI, 'true', 'Run the recording in cloud CI');
const output = new URL('../work/entry-daylight/', import.meta.url);
await mkdir(output, { recursive: true });
const assets = JSON.parse(await readFile(new URL('./fixtures/media/gateway-portrait-cdn.json', import.meta.url), 'utf8'));
const loginUrl = 'http://127.0.0.1:8200/llmgw/login';
const outputPath = name => new URL(name, output).pathname;
const resolutions = { width: 1920, height: 1080 };

async function prepare(page, theme) {
  await installOperationsFixtures(page, { quickstart: true });
  await page.goto(loginUrl);
  await expect(page.locator('.consciousness-scene')).toHaveAttribute('data-portrait-theme', theme);
  await expect(page.locator('.consciousness-art')).toHaveAttribute('src', assets[theme].closed.url);
  await expect.poll(() => page.locator('.consciousness-art').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  if (theme === 'light') await expect(page.locator('.consciousness-mist')).toHaveCount(0);
  await page.locator('#llmgw-username').fill('demo');
  await page.locator('#llmgw-password').fill('demo');
}

async function arrive(page, theme, name) {
  await page.getByRole('button', { name: '开始身份确认', exact: true }).click();
  await page.waitForURL(/\/quickstart$/);
  await page.waitForFunction(expected => {
    const v = document.querySelector('.portrait-motion');
    return v && v.currentSrc === expected && v.currentTime > .06;
  }, assets[theme].motion.url, { timeout: 15_000 });
  const align = await page.locator('.portrait-motion').evaluate(movie => Date.now() / 1_000 - movie.currentTime);
  await expect.poll(() => page.locator('.portrait-motion').evaluate(movie => movie.currentTime), { timeout: 12_000 }).toBeGreaterThan(5.1);
  await expect(page.getByRole('textbox', { name: '我想做什么', exact: true })).toBeVisible();
  await expect(page.locator('.consciousness-scene')).toHaveAttribute('data-portrait-theme', theme);
  await page.screenshot({ path: outputPath(`${name}-settled.png`) });
  return align;
}

const evidence = { provenance: 'deterministic-fixture', commit: process.env.GITHUB_SHA, viewport: resolutions, entries: {} };
for (const theme of ['dark', 'light']) {
  const profile = await mkdtemp(join(tmpdir(), 'entry-daylight-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false, viewport: null, locale: 'zh-CN', colorScheme: theme, reducedMotion: 'no-preference',
    args: ['--kiosk', '--start-fullscreen', '--window-size=1920,1080', '--window-position=0,0', '--disable-dev-shm-usage', '--disable-features=Translate'],
  });
  try {
    const page = context.pages()[0];
    const session = await context.newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
    await session.detach();
    await prepare(page, theme);
    await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, resolutions);
    evidence.entries[theme] = await recordEntryDesktop(output, theme, () => arrive(page, theme, theme));
    if (theme === 'light') {
      await recordEntryDesktop(output, 'theme-switch', async () => {
        for (const next of ['dark', 'light']) {
          await page.getByLabel('打开用户菜单', { exact: true }).click();
          await page.getByRole('button', { name: next === 'dark' ? '切换深色' : '切换浅色', exact: true }).click();
          await expect(page.locator('.consciousness-scene')).toHaveAttribute('data-portrait-theme', next);
          await expect(page.locator('.consciousness-art')).toHaveAttribute('src', assets[next].open.url);
          await expect.poll(() => page.locator('.consciousness-art').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
          await expect(page.locator('.consciousness-mist')).toHaveCount(0);
          await expect(page.locator('.portrait-motion')).toHaveCount(0);
          await page.screenshot({ path: outputPath(`${next}-switched.png`) });
          await page.waitForTimeout(900);
        }
      });
    }
  } finally {
    await context.close();
  }
}
const mobile = await chromium.launch({ headless: true });
try {
  const context = await mobile.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const page = await context.newPage();
  await prepare(page, 'light');
  await arrive(page, 'light', 'mobile-light');
  evidence.mobile = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, touchPoints: navigator.maxTouchPoints, overflow: document.documentElement.scrollWidth > innerWidth }));
  assert.ok(evidence.mobile.touchPoints > 0 && !evidence.mobile.overflow);
} finally {
  await mobile.close();
}
await writeFile(outputPath('fixture-evidence.json'), JSON.stringify(evidence, null, 2));
