/** Cloud-only public-preview acceptance. No injected auth, mocked routes, or fabricated video frames. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForEntryPreviews } from './entry-preview-readiness.mjs';
import { recordEntryDesktop } from './entry-record-desktop.mjs';
const output = new URL('../work/entry-motion/', import.meta.url);
await mkdir(output, { recursive: true });
const motion = JSON.parse(await readFile(new URL('./fixtures/media/portrait-motion.source.json',import.meta.url),'utf8'));
const gatewayAssets = JSON.parse(await readFile(new URL('./fixtures/media/gateway-portrait-cdn.json', import.meta.url), 'utf8'));
const target = JSON.parse(await readFile(new URL('./fixtures/entry-preview.json', import.meta.url), 'utf8'));
const map = new URL(target.mapUrl);
const gateway = new URL(target.gatewayUrl);
assert.equal(map.protocol, 'https:'); assert.equal(gateway.protocol, 'https:');
assert.ok(process.env.E2E_USER && process.env.E2E_PASSWORD, 'Missing real preview login credentials');
// Bind both public app bundles and the actual film before filling any login form.
const readiness = await waitForEntryPreviews({ map, gateway, motion, gatewayAssets, expectedCommit: process.env.EXPECTED_COMMIT });
await writeFile(new URL('preview-readiness.json', output), JSON.stringify(readiness, null, 2));
const profile = await mkdtemp(join(tmpdir(),'entry-motion-'));
await mkdir(join(profile,'Default'),{recursive:true});
await writeFile(join(profile,'Default','Preferences'),JSON.stringify({credentials_enable_service:false,profile:{password_manager_enabled:false},translate:{enabled:false},translate_blocked_languages:['zh-CN'],intl:{accept_languages:'zh-CN,zh'}}));
const context = await chromium.launchPersistentContext(profile, {
  headless: false, viewport: null, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'no-preference',
  ignoreDefaultArgs: ['--enable-automation'], colorScheme: 'dark',
  args: ['--kiosk', '--start-fullscreen', '--window-size=1920,1080', '--window-position=0,0', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--disable-gpu-compositing', '--disable-save-password-bubble', '--lang=zh-CN', '--disable-translate'],
});
// Observe actual scene frames without changing the renderer, clock, auth or API responses.
await context.addInitScript(() => {
  window.__entryEvidence = { frames: [], videoFrames: [], errors: [] };
  const evidence = window.__entryEvidence;
  window.addEventListener('error', event => evidence.errors.push(event.message));
  let previous = -1;
  const observedVideos = new WeakSet();
  const observe = () => {
    const portrait = document.querySelector('.consciousness-portrait.is-building');
    const movie = portrait?.querySelector('video');
    if (movie && !observedVideos.has(movie) && movie.requestVideoFrameCallback) {
      observedVideos.add(movie);
      const presented = (_now, metadata) => {
        const quality = movie.getVideoPlaybackQuality();
        evidence.videoFrames.push({ epoch: Date.now(), mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames,
          decoded: quality.totalVideoFrames, dropped: quality.droppedVideoFrames });
        if (movie.isConnected) movie.requestVideoFrameCallback(presented);
      };
      movie.requestVideoFrameCallback(presented);
    }
    const t = Number(portrait?.dataset.time);
    if (portrait && Number.isFinite(t) && t !== previous) {
      previous = t;
      const gradient = portrait.querySelector('linearGradient[gradientUnits="userSpaceOnUse"]');
      evidence.frames.push({ epoch: Date.now(), t, eye: Number(portrait.dataset.eyeOpening), renderer: portrait.dataset.renderer,
        paperOpacity: Number(document.querySelector('.gateway-arrival-paper') ? getComputedStyle(document.querySelector('.gateway-arrival-paper')).opacity : 0),
        mask: [gradient?.getAttribute('y1'), gradient?.getAttribute('y2')], width: innerWidth, height: innerHeight });
    }
    requestAnimationFrame(observe);
  };
  requestAnimationFrame(observe);
});
const page = context.pages()[0] || await context.newPage();
async function setTheme(theme) {
  await page.getByLabel('打开用户菜单', {exact:true}).click();
  await page.getByRole('button', {name:theme === 'light' ? '切换浅色' : '切换深色', exact:true}).click();
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected && !document.querySelector('details.lg-user-menu[open]'),theme);
}

try {
  const nativeWindow = await context.newCDPSession(page);
  const { windowId } = await nativeWindow.send('Browser.getWindowForTarget');
  await nativeWindow.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
  await nativeWindow.detach();
  await page.goto(new URL('/login', map).href);
  await page.waitForFunction(() => innerWidth === 1920 && innerHeight === 1080, null, { timeout: 15000 });
  await page.locator('input[autocomplete="username"]').first().fill(process.env.E2E_USER);
  await page.locator('input[autocomplete="current-password"]').first().fill(process.env.E2E_PASSWORD);
  await page.getByRole('button', { name: '开始身份确认', exact: true }).click();
  await page.getByLabel('打开用户菜单', { exact: true }).waitFor({ timeout: 45000 });
  for (const [mode, theme] of [['cold', 'dark'], ['warm', 'light']]) {
    if (mode === 'warm') {
      await setTheme('light');
      await page.getByLabel('打开用户菜单', { exact: true }).click();
      await page.getByRole('button', { name: '返回 MAP', exact: true }).click();
      await page.getByLabel('打开用户菜单', { exact: true }).waitFor();
    }
    const collapse = page.getByRole('button', { name: '收缩通知', exact: true });
    if (await collapse.isVisible()) await collapse.click();
    await page.getByLabel('打开用户菜单', { exact: true }).click();
    await recordEntryDesktop(output, mode, async () => {
      await page.getByRole('menuitem', { name: '模型网关', exact: true }).click();
      await page.waitForURL(url => url.origin === gateway.origin && url.pathname === '/quickstart', { timeout: 45000 });
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-entry-arriving'), null, { timeout: 15000 });
      const expectedMotion = gatewayAssets[theme].motion;
      if (expectedMotion.durationSeconds) {
        await page.waitForFunction(() => document.querySelector('.portrait-motion')?.ended, null, { timeout: 15000 });
      }
      await page.getByRole('textbox', { name: '我想做什么', exact: true }).waitFor();
      await page.waitForTimeout(1300); // Include the actual settled brand and last-frame handoff.
      const evidence = await page.evaluate(() => ({ ...window.__entryEvidence, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },

        fineLines: document.querySelectorAll('.portrait-fine-lines path').length,
        settledMovie: (() => { const video=document.querySelector('.portrait-motion'); return video ? {time:video.currentTime,duration:video.duration,paused:video.paused,src:video.currentSrc} : null; })(),
        theme: document.querySelector('.consciousness-scene')?.dataset.portraitTheme,
        brand: document.querySelector('.consciousness-ghost > span')?.textContent,
        personalGreetingCount: document.querySelectorAll('.gateway-identity-card').length,
        navigation: [...document.querySelectorAll('.lg-console-sidebar nav a')].map(link => ({label:link.getAttribute('aria-label'),path:new URL(link.href).pathname})),
        body: document.body.innerText.slice(-500) }));
      await page.screenshot({ path: new URL(`${mode}-settled.png`, output).pathname });
      await writeFile(new URL(`${mode}.json`, output), JSON.stringify(evidence, null, 2));
      assert.ok(evidence.settledMovie?.paused && evidence.settledMovie.time >= 5.1, 'The settled portrait must retain its actual video end pose');
      assert.equal(evidence.theme, theme);
      assert.equal(evidence.settledMovie.src, expectedMotion.url);
      assert.deepEqual(evidence.navigation[0], {label:'对话',path:'/quickstart'});
      assert.equal(evidence.navigation.filter(link => link.path === '/quickstart').length, 1);
      assert.equal(evidence.brand, 'LLM Gateway');
      assert.equal(evidence.personalGreetingCount, 0);
      assert.deepEqual(evidence.viewport, { width: 1920, height: 1080, dpr: 1 });
      assert.ok(evidence.frames.filter(frame => frame.t >= .25 && frame.t < .5).every(frame => frame.paperOpacity === 0), 'Paper must have cleared by the first quarter second');
      assert.ok(evidence.frames.some(frame => frame.renderer === 'native-video'), 'Native motion video must actually play');
      assert.ok(evidence.videoFrames.length > 120, 'Too few actually presented portrait video frames');
      if (expectedMotion.durationSeconds) {
        assert.ok(Math.abs(evidence.settledMovie.duration - expectedMotion.durationSeconds) < .05, 'The reference edit duration differs');
        assert.ok(evidence.videoFrames[0]?.mediaTime < .125, 'The recording missed the authored opening');
        assert.ok(evidence.videoFrames.some(frame => frame.mediaTime >= expectedMotion.durationSeconds - .15), 'The recording missed the final eye pose');
      } else {
        assert.ok(evidence.frames.some(frame => frame.eye > .15 && frame.eye < .85), 'Missing intermediate eye timing samples');
      }
      assert.ok(evidence.frames.filter(frame => frame.t < .5).length > 2, 'Missing first structural frames');
      assert.ok(evidence.body.includes(process.env.EXPECTED_COMMIT.slice(0,7)), 'Public preview is not the expected revision');
    });
  }
  // Real menu operations, navigation and reload verify the preference across cinematic and ordinary pages.
  const themeEvidence = [];
  for (const theme of ['dark', 'light']) {
    await setTheme(theme);
    const paint = await page.locator('.gateway-quickstart-stage').evaluate(el => ({scheme:getComputedStyle(el).colorScheme, ink:getComputedStyle(el).color}));
    assert.equal(paint.scheme,theme);
    await page.screenshot({path:new URL(`${theme}-conversation.png`,output).pathname});
    await page.getByLabel('打开用户菜单', {exact:true}).click();
    await page.locator('.lg-user-popover').getByLabel('切换组织', {exact:true}).click();
    assert.equal(await page.locator('details.lg-user-menu').getAttribute('open'),'');
    await page.locator('.lg-console-brand > span:last-child').click();
    assert.equal(await page.locator('details.lg-user-menu[open], details.gateway-account-organizations[open]').count(),0);
    await page.getByLabel('打开用户菜单', {exact:true}).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('details.lg-user-menu[open]').count(),0);
    await page.locator('.gateway-entry-help > summary').click();
    await page.locator('.lg-console-brand > span:last-child').click();
    assert.equal(await page.locator('.gateway-entry-help[open]').count(),0);
    const starter = page.locator('.gateway-intent-starters button').first();
    const idle = await starter.evaluate(el => getComputedStyle(el).backgroundColor);
    await starter.hover(); await page.waitForTimeout(200);
    const hover = await starter.evaluate(el => getComputedStyle(el).backgroundColor);
    assert.notEqual(hover,idle); await page.mouse.move(0,0);
    await page.locator('.lg-console-sidebar nav').getByRole('link',{name:'概览',exact:true}).click();
    await page.waitForURL(url => url.origin === gateway.origin && url.pathname === '/');
    assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
    await page.screenshot({path:new URL(`${theme}-overview.png`,output).pathname});
    await page.locator('.lg-console-sidebar nav').getByRole('link',{name:'对话',exact:true}).click();
    await page.reload();
    await page.getByRole('textbox',{name:'我想做什么',exact:true}).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
    const stored = await page.evaluate(() => localStorage.getItem('llmgw.theme'));
    assert.equal(stored,theme);
    themeEvidence.push({theme,paint,stored,hoverChanged:hover !== idle,outsideDismissed:true,escapeDismissed:true});
  }
  await recordEntryDesktop(output, 'theme-switch', async () => {
    for (const theme of ['dark', 'light']) {
      await setTheme(theme);
      await page.waitForFunction(url => {
        const img = document.querySelector('.consciousness-art');
        return img?.currentSrc === url && img.complete && img.naturalWidth > 0;
      }, gatewayAssets[theme].open.url);
      assert.equal(await page.locator('.consciousness-mist').count(), 0);
      await page.waitForTimeout(900);
    }
  });
  assert.notEqual(themeEvidence[0].paint.ink,themeEvidence[1].paint.ink);
  await writeFile(new URL('theme-menu-journey.json',output),JSON.stringify(themeEvidence,null,2));
} catch (error) {
  await writeFile(new URL('failure.txt', output), String(error));
  // Do not record credentials, auth storage, SSO URL fragments, or request headers.
  if (new URL(page.url()).pathname !== '/login') await page.screenshot({ path: new URL('failure.png', output).pathname });
  throw error;
} finally { await context.close(); }
