/** Cloud-only public-preview acceptance. No injected auth, mocked routes, or fabricated video frames. */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const output = new URL('../work/entry-motion/', import.meta.url);
await mkdir(output, { recursive: true });
const motion = JSON.parse(await readFile(new URL('./fixtures/media/portrait-motion.source.json',import.meta.url),'utf8'));
const target = JSON.parse(await readFile(new URL('./fixtures/entry-preview.json', import.meta.url), 'utf8'));
const map = new URL(process.env.MAP_URL || target.mapUrl);
const gateway = new URL(process.env.GATEWAY_URL || target.gatewayUrl);
assert.equal(map.protocol, 'https:'); assert.equal(gateway.protocol, 'https:');
assert.ok(process.env.E2E_USER && process.env.E2E_PASSWORD, 'Missing real preview login credentials');
// Wait for the real new public bundles; never record an older deployed scene as the result.
// MAP splits the portrait into lazy chunks; Gateway owns the scene being recorded in its entry bundle.
for (const destination of [gateway]) {
  const deadline = Date.now() + 12 * 60_000;
  while (true) {
    try {
      const response = await fetch(destination, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
      const document = await response.text();
      const source = document.match(/<script[^>]*type="module"[^>]*src="([^"]+)/)?.[1];
      // The widget deliberately starts without a version and refreshes it from runtime facts.
      const branchId = document.match(/var BRANCH_ID=['"]([^'"]+)['"]/i)?.[1];
      const state = await fetch(new URL('/_cds/api/branches',destination), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
      const branches = await state.json();
      const deployed = branches.branches?.find(branch => branch.id === branchId)?.runningCommitSha;
      if (response.ok && source && deployed === process.env.EXPECTED_COMMIT) {
        const bundle = await fetch(new URL(source,destination), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
        const javascript = await bundle.text();
        if (bundle.ok && javascript.includes(motion.fileName) && javascript.includes('direct-night')) {
          const media = await fetch(new URL(`/media/entry/${motion.fileName}`,destination), { headers: { 'User-Agent':'Mozilla/5.0' }, signal:AbortSignal.timeout(15000) });
          if (media.ok && createHash('sha256').update(new Uint8Array(await media.arrayBuffer())).digest('hex') === motion.sha256) break;
        }
      }
    } catch { /* Public deployment may still be switching; bounded below. */ }
    assert.ok(Date.now() < deadline, 'The new public portrait bundle did not become available');
    console.log('Waiting for the expected public portrait bundle:', destination.hostname);
    await new Promise(resolve => setTimeout(resolve,15000));
  }
}
const profile = await mkdtemp(join(tmpdir(),'entry-motion-'));
await mkdir(join(profile,'Default'),{recursive:true});
await writeFile(join(profile,'Default','Preferences'),JSON.stringify({credentials_enable_service:false,profile:{password_manager_enabled:false}}));
const context = await chromium.launchPersistentContext(profile, {
  headless: false, viewport: null, timezoneId: 'Asia/Shanghai', reducedMotion: 'no-preference',
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--kiosk', '--start-fullscreen', '--window-size=1920,1080', '--window-position=0,0', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--disable-gpu-compositing', '--disable-save-password-bubble'],
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
  for (const mode of ['cold', 'warm']) {
    if (mode === 'warm') {
      await page.getByLabel('打开用户菜单', { exact: true }).click();
      await page.getByRole('button', { name: '返回 MAP', exact: true }).click();
      await page.getByLabel('打开用户菜单', { exact: true }).waitFor();
    }
    const collapse = page.getByRole('button', { name: '收缩通知', exact: true });
    if (await collapse.isVisible()) await collapse.click();
    await page.getByLabel('打开用户菜单', { exact: true }).click();
    const raw = new URL(`${mode}.mp4`, output).pathname;
    const recorder = spawn('ffmpeg', ['-hide_banner', '-y', '-f', 'x11grab', '-video_size', '1920x1080', '-framerate', '60', '-i', process.env.DISPLAY,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', raw], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = ''; recorder.stderr.on('data', data => { stderr += data; });
    const done = new Promise(resolve => recorder.on('close', resolve));
    try {
      // Wait for the actual first encoded frame before triggering entry.
      const started = Date.now();
      while (!/frame=\s*[1-9]/.test(stderr)) {
        assert.ok(Date.now() - started < 15000, 'Cloud screen recorder did not start');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await page.getByRole('menuitem', { name: '模型网关', exact: true }).click();
      await page.waitForURL(url => url.origin === gateway.origin && url.pathname === '/quickstart', { timeout: 45000 });
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-entry-arriving'), null, { timeout: 15000 });
      await page.getByRole('textbox', { name: '我想做什么', exact: true }).waitFor();
      await page.waitForTimeout(1300); // Include the actual settled brand and last-frame handoff.
      const evidence = await page.evaluate(() => ({ ...window.__entryEvidence, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },

        fineLines: document.querySelectorAll('.portrait-fine-lines path').length,
        settledMovie: (() => { const video=document.querySelector('.portrait-motion'); return video ? {time:video.currentTime,paused:video.paused} : null; })(),
        brand: document.querySelector('.consciousness-ghost > span')?.textContent,
        personalGreetingCount: document.querySelectorAll('.gateway-identity-card').length,
        body: document.body.innerText.slice(-500) }));
      await page.screenshot({ path: new URL(`${mode}-settled.png`, output).pathname });
      await writeFile(new URL(`${mode}.json`, output), JSON.stringify(evidence, null, 2));
      assert.ok(evidence.settledMovie?.paused && evidence.settledMovie.time >= 5.1, 'The settled portrait must retain its actual video end pose');
      assert.equal(evidence.brand, 'LLM Gateway');
      assert.equal(evidence.personalGreetingCount, 0);
      assert.deepEqual(evidence.viewport, { width: 1920, height: 1080, dpr: 1 });
      assert.ok(evidence.frames.filter(frame => frame.t >= .25 && frame.t < .5).every(frame => frame.paperOpacity === 0), 'Paper must have cleared by the first quarter second');
      assert.ok(evidence.frames.some(frame => frame.renderer === 'native-video'), 'Native motion video must actually play');
      assert.ok(evidence.videoFrames.length > 120, 'Too few actually presented portrait video frames');
      assert.ok(evidence.frames.some(frame => frame.eye > .15 && frame.eye < .85), 'Missing actual intermediate eyelid frames');
      assert.ok(evidence.frames.filter(frame => frame.t < .5).length > 2, 'Missing first structural frames');
      assert.ok(evidence.body.includes(process.env.EXPECTED_COMMIT.slice(0,7)), 'Public preview is not the expected revision');
    } finally {
      recorder.stdin.write('q'); await done;
      await writeFile(new URL(`${mode}-ffmpeg.log`, output), stderr);
    }
  }
} catch (error) {
  await writeFile(new URL('failure.txt', output), String(error));
  // Do not record credentials, auth storage, SSO URL fragments, or request headers.
  if (new URL(page.url()).pathname !== '/login') await page.screenshot({ path: new URL('failure.png', output).pathname });
  throw error;
} finally { await context.close(); }
