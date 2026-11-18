import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { installOperationsFixtures } from './fixtures/admin-operations.mjs';

assert.equal(process.env.CI, 'true');
const output = new URL('../work/entry-handoff/', import.meta.url);
await mkdir(output, { recursive: true });
const assets = JSON.parse(await readFile(new URL('./fixtures/media/gateway-portrait-cdn.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--disable-dev-shm-usage'] });
const evidence = [];
const viewport = { width: 1440, height: 810 };

async function capture({ name, port = 8200, baseline = false, sso = false, theme = 'light', delayed = false }) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN', colorScheme: theme, reducedMotion: 'no-preference',
    recordVideo: { dir: new URL('raw/', output).pathname, size: { width: 1280, height: 720 } } });
  const page = await context.newPage();
  const auth = Promise.withResolvers();
  const media = Promise.withResolvers();
  const origin = 'http://127.0.0.1:' + port + '/llmgw';
  const expected = assets[theme];
  const paper = expected.opening?.url;
  const screenshot = async stage => page.screenshot({ path: new URL(name + '-' + stage + '.png', output).pathname });
  try {
    await installOperationsFixtures(page, { quickstart: true });
    if (delayed) {
      await page.route(expected.motion.url, async route => {
        await media.promise;
        await route.continue().catch(() => {});
      });
    }
    if (sso) {
      await page.route('**/gw/auth/map-sso', async route => {
        await auth.promise;
        await route.fulfill({ json: { success: true, data: { token: 'fixture', username: 'demo',
          expiresAt: new Date(Date.now() + 3600000).toISOString(), mustChangePassword: false,
          tenant: { id: 't1', name: '验收租户', isInternal: true, role: 'owner', teamIds: [] } } } });
      });
    }
    await page.addInitScript(() => {
      window.entryFrames = [];
      window.firstVideoFrame = null;
      const observed = new WeakSet();
      function tick() {
        const login = document.querySelector('.cinema-login');
        const stage = document.querySelector('.gateway-quickstart-stage');
        const art = (login ?? stage)?.querySelector('.consciousness-art');
        const video = stage?.querySelector('.portrait-motion');
        if (video && !observed.has(video)) {
          observed.add(video);
          video.requestVideoFrameCallback((_time, metadata) => {
            if (window.firstVideoFrame === null) window.firstVideoFrame = metadata.mediaTime;
          });
        }
        if (art) window.entryFrames.push({ scene: login?.dataset.phase ?? 'arrival',
          src: art.getAttribute('src'), opacity: getComputedStyle(art).opacity, at: video?.currentTime ?? null });
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    if (sso) {
      await page.goto(origin + '/auth/map?returnTo=%2Fquickstart#code=' + 'a'.repeat(43), { waitUntil: 'domcontentloaded' });
    } else {
      await page.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
    }
    await expect(page.locator('.consciousness-scene')).toHaveAttribute('data-portrait-theme', theme);
    const loginImage = page.locator('.cinema-login .consciousness-art');
    await expect(loginImage).toHaveAttribute('src', baseline || !paper ? expected.closed.url : paper);
    await expect.poll(() => loginImage.evaluate(img => img.naturalWidth), { timeout: 12000 }).toBeGreaterThan(0);
    if (sso) {
      await screenshot('handoff');
      await page.waitForTimeout(250);
      auth.resolve();
    } else {
      await page.locator('#llmgw-username').fill('demo');
      await page.locator('#llmgw-password').fill('demo');
      await page.getByRole('button', { name: '开始身份确认', exact: true }).click();
      await expect(page.locator('.cinema-login')).toHaveAttribute('data-phase', 'entering');
      await page.waitForTimeout(250);
      await screenshot('handoff');
    }
    await page.waitForURL(/\/quickstart$/);
    const video = page.locator('.portrait-motion');
    const art = page.locator('.gateway-quickstart-stage .consciousness-art');
    if (delayed) {
      await expect(art).toHaveAttribute('src', paper);
      await expect(art).toHaveCSS('opacity', '1');
      await expect.poll(() => video.evaluate(v => v.currentTime)).toBe(0);
      await page.waitForTimeout(300);
      await screenshot('waiting');
      media.resolve();
    }
    if (theme === 'light') {
      await expect(video).toHaveAttribute('poster', paper);
      await page.waitForFunction(() => document.querySelector('.portrait-motion')?.currentTime >= 0.25);
      await screenshot('first-stroke');
      await expect.poll(() => video.evaluate(v => v.ended), { timeout: 13000 }).toBe(true);
      await expect(art).toHaveAttribute('src', expected.open.url);
      await expect(page.getByRole('textbox', { name: '我想做什么', exact: true })).toBeEditable();
      const playback = await video.evaluate(v => ({ elapsed: v.currentTime, duration: v.duration, first: window.firstVideoFrame }));
      assert.ok(Math.abs(playback.duration - 8.166667) < 0.04);
      assert.equal(playback.elapsed, playback.duration);
      assert.ok(playback.first !== null && playback.first < 0.125);
      await screenshot('settled');
      const trace = await page.evaluate(() => window.entryFrames);
      const handoff = trace.filter(frame => frame.scene !== 'arrival' || frame.at === null || frame.at < 3.20);
      assert.ok(handoff.length > 30);
      if (!baseline) assert.ok(handoff.every(frame => frame.src === paper), JSON.stringify(handoff.find(frame => frame.src !== paper)));
      evidence.push({ name, playback, earlyPaints: handoff.length, earlyArtwork: [...new Set(handoff.map(frame => frame.src))] });
    } else {
      await expect.poll(() => video.evaluate(v => v.currentTime), { timeout: 12000 }).toBeGreaterThan(5.1);
      await expect(art).toHaveAttribute('src', expected.open.url);
      evidence.push({ name, source: await video.getAttribute('src'), durationReached: await video.evaluate(v => v.currentTime) });
    }
    await page.waitForTimeout(350);
  } finally {
    auth.resolve();
    media.resolve();
    const video = page.video();
    await context.close();
    await video.saveAs(new URL(name + '.webm', output).pathname);
  }
}
try {
  await capture({ name: 'before-password', port: 8210, baseline: true });
  await capture({ name: 'fixed-password', delayed: true });
  await capture({ name: 'fixed-map-sso', sso: true });
  await capture({ name: 'dark-password', theme: 'dark' });
} finally {
  await browser.close();
  await writeFile(new URL('evidence.json', output), JSON.stringify(evidence, null, 2));
}
