import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const origin = 'https://opendesign-sketchnote-film-codex-prd-agent.miduo.org';
const deployedCommit = '31cdc15f00a2057ae5711ab5e49206c51660296d';
assert.equal(process.env.E2E_BASE_URL, origin, 'Target must be the isolated MAP preview');
assert.ok(process.env.E2E_USER && process.env.E2E_PASSWORD, 'Cloud acceptance credentials are missing');
const endpoint = (path) => new URL(path, origin);
const responseData = async (response, operation) => {
  assert.ok(response.ok(), `${operation} returned HTTP ${response.status()}`);
  const payload = await response.json();
  assert.notEqual(payload.success, false, `${operation} returned a failed response`);
  return payload.data ?? payload;
};
const requestMatches = (path, method) => (response) => {
  const url = new URL(response.url());
  return url.origin === origin && url.pathname === path && response.request().method() === method;
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(70_000);
  const version = await responseData(await page.request.get(endpoint('/api/version').href), 'Read deployed version');
  assert.equal(version.actualCommit, deployedCommit, 'Cloud preview is still serving a different product commit');
  await page.goto(origin);
  await page.getByRole('button', { name: '登录 / 注册', exact: true }).click();
  await page.locator('input[autocomplete="username"]').first().fill(process.env.E2E_USER);
  await page.locator('input[autocomplete="current-password"]').first().fill(process.env.E2E_PASSWORD);
  const [login] = await Promise.all([
    page.waitForResponse(requestMatches('/api/v1/auth/login', 'POST')),
    page.getByRole('button', { name: '开始身份确认', exact: true }).click(),
  ]);
  const token = (await responseData(login, 'Sign in with the cloud acceptance account')).accessToken;
  assert.ok(token);
  await page.getByLabel('打开用户菜单', { exact: true }).waitFor({ timeout: 60_000 });
  const nav = page.locator('nav button[title^="网页托管"]:visible')
    .or(page.getByRole('button', { name: '网页', exact: true }).filter({ visible: true })).first();
  await nav.click();
  await page.waitForURL((url) => url.pathname === '/web-pages');
  const [historyResponse] = await Promise.all([
    page.waitForResponse(requestMatches('/api/design-artifacts/code-films', 'GET')),
    page.getByRole('button', { name: '快速创作', exact: true }).click(),
  ]);
  const dialog = page.getByRole('dialog', { name: '快速创作 · 代码视频' });
  await dialog.getByText('视觉笔记', { exact: true }).waitFor();
  const sourceInput = dialog.locator('input[type=file]');
  assert.match(await sourceInput.getAttribute('accept'), /\.md/);
  assert.equal(await dialog.getByRole('button', { name: '生成视频', exact: true }).isEnabled(), false);
  const history = await responseData(historyResponse, 'Read film task history');
  assert.ok(history.items.every((item) => item.artifactType === 'code-film'));
  console.log('UI verified: normal login, Web Hosting navigation, Quick Create, Markdown input, owned task list.');

  const reference = history.items.find((item) => item.title === 'ADR 视觉笔记 · 原版技能云端验证'
    && item.uploadedSources?.[0]?.fileName === 'architectural-decision-records.md'
    && item.runtimeModelCallCount === 78);
  assert.ok(reference, 'The cloud acceptance account does not own the original ADR film. No new film was submitted.');
  const movies = dialog.getByLabel('最近任务');
  const fresh = history.items.find((item) => item.title === 'ADR 视觉笔记 · 快速创作云端复验 2026-11-26');
  assert.ok(fresh, 'The original owner cannot find the new cloud task.');
  await movies.selectOption(fresh.runId);
  await dialog.getByRole('status').first().waitFor();
  if (['running', 'queued'].includes(fresh.status.toLowerCase())) {
    const newFilmPath = `/api/design-artifacts/runs/${fresh.runId}/film.mp4`;
    const [pendingMovie] = await Promise.all([
      page.waitForResponse(requestMatches(newFilmPath, 'GET'), { timeout: 45_000 }),
      dialog.getByRole('button', { name: '预览或取回成片', exact: true }).click(),
    ]);
    if (pendingMovie.status() === 404) {
      await dialog.getByText('这条任务目前没有可取回的成片，请稍后查看。', { exact: true }).waitFor();
      console.log('Unfinished task shows an actionable wait message; it does not start another model job.');
    } else {
      assert.ok(pendingMovie.ok(), `Pending run movie HTTP ${pendingMovie.status()}`);
    }
  }
  await page.reload();
  const [reloadedHistory] = await Promise.all([
    page.waitForResponse(requestMatches('/api/design-artifacts/code-films', 'GET')),
    page.getByRole('button', { name: '快速创作', exact: true }).click(),
  ]);
  const afterReload = (await responseData(reloadedHistory, 'Read history after reload')).items.find((item) => item.runId === fresh.runId);
  assert.ok(afterReload, 'The same task is missing after a browser reload.');
  await movies.selectOption(fresh.runId);
  await dialog.getByRole('status').first().waitFor();
  console.log('Refresh verified: the same submitted run remained visible in the browser.');
  assert.equal(afterReload.status.toLowerCase(), 'done');
  assert.ok(afterReload.workspaceResultSha256, 'The new film must have a committed result.');
  const filmPath = `/api/design-artifacts/runs/${fresh.runId}/film.mp4`;
  const [film] = await Promise.all([
    page.waitForResponse(requestMatches(filmPath, 'GET'), { timeout: 95_000 }),
    dialog.getByRole('button', { name: '预览或取回成片', exact: true }).click(),
  ]);
  assert.ok(film.ok(), `Recover MP4 returned HTTP ${film.status()}`);
  const video = dialog.locator('video[aria-label="生成视频预览"]');
  await video.waitFor();
  let playback;
  try {
    await page.waitForFunction(() => {
      const movie = document.querySelector('video[aria-label="生成视频预览"]');
      return movie?.readyState >= 1 && Math.abs(movie.duration - 90) < 0.15;
    }, null, { timeout: 25_000 });
  } finally {
    playback = await video.evaluate((movie) => ({ ready: movie.readyState, error: movie.error?.code ?? null }));
    console.log('Movie element readiness:', JSON.stringify(playback));
  }
  const blob = await video.evaluate(async (movie) => {
    const buffer = await (await fetch(movie.currentSrc)).arrayBuffer();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    return { length: buffer.byteLength, digest: Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('') };
  });
  assert.equal(blob.length, 25_783_803);
  assert.equal(blob.digest, 'ed553b2e0f64a9d52bd81d251a17ecf73aad51f04a130f4f53496aa8095bea41');
  await video.evaluate(async (movie) => {
    movie.muted = true;
    await movie.play();
  });
  await page.waitForFunction(() => document.querySelector('video[aria-label="生成视频预览"]')?.currentTime > 0.1);
  await video.evaluate((movie) => {
    movie.pause();
    movie.currentTime = 42;
  });
  await page.waitForFunction(() => {
    const movie = document.querySelector('video[aria-label="生成视频预览"]');
    return movie && !movie.seeking && Math.abs(movie.currentTime - 42) < 0.1;
  });
  console.log('Newly generated MP4 opened in the browser; hash, duration, playback and seek verified.');

  const saveButton = dialog.getByRole('button', { name: '保存到网页托管', exact: true });
  const save = async () => {
    const [result] = await Promise.all([
      page.waitForResponse(requestMatches(`/api/design-artifacts/runs/${fresh.runId}/save-film`, 'POST'), { timeout: 110_000 }),
      saveButton.click(),
    ]);
    return responseData(result, 'Save movie to Web Hosting');
  };
  const saved = await save();
  assert.equal((await save()).siteId, saved.siteId);
  const apiAuth = { headers: { Authorization: `Bearer ${token}` } };
  const site = await responseData(await page.request.get(endpoint(`/api/web-pages/${saved.siteId}`).href, apiAuth), 'Read saved site');
  assert.equal(site.wrappedAssetType, 'video');
  assert.equal(site.files.find((file) => file.path === 'film.mp4')?.size, blob.length);
  await dialog.getByRole('button', { name: '打开分享设置', exact: true }).click();
  const share = page.getByRole('dialog', { name: /建一条分享链接/ });
  await share.waitFor();
  await share.getByText(/只有你本人打开有内容/).waitFor();
  console.log('Save verified twice against one private site; share settings opened with the owner-only default.');

  const savedLinks = await responseData(await page.request.get(endpoint(`/api/web-pages/shares?siteId=${saved.siteId}`).href, apiAuth), 'List saved share links');
  const link = savedLinks.items.find((item) => item.visibility === 'owner-only' && !item.isExpired && !item.isRevoked && !item.password);
  assert.ok(link, 'The previously created owner-only share link was not found.');
  const sharePath = '/api/web-pages/shares/view/' + encodeURIComponent(link.token);
  const anonymousContext = await browser.newContext();
  try {
    const anonymous = await anonymousContext.request.get(endpoint(sharePath).href);
    assert.ok([401, 403].includes(anonymous.status()), 'An unauthenticated viewer was not rejected.');
  } finally {
    await anonymousContext.close();
  }
  const ownerView = await responseData(await page.request.get(endpoint(sharePath).href, apiAuth), 'Read the share as owner');
  assert.ok(ownerView.sites.some((item) => item.id === saved.siteId));
  const shareUrl = endpoint('/s/wp/' + encodeURIComponent(link.token));
  await page.goto(shareUrl.href).catch(() => { throw new Error('Owner share page did not open.'); });
  const until = Date.now() + 40_000;
  let hostedPlayer = false;
  while (!hostedPlayer && Date.now() < until) {
    for (const frame of page.frames()) {
      const loaded = await frame.locator('video').first().evaluate((movie) =>
        movie.readyState >= 1 && Math.abs(movie.duration - 90) < 0.15, null, { timeout: 250 }).catch(() => false);
      if (loaded) { hostedPlayer = true; break; }
    }
    if (!hostedPlayer) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(hostedPlayer, 'The owner share page did not load the original movie.');
  console.log('Owner share plays the same hosted movie; anonymous access was denied.');

  if (process.env.VERIFY_FILM_AUDIO === '1') {
    const response = await page.request.get(endpoint(filmPath).href, apiAuth);
    assert.ok(response.ok(), 'The committed result could not be read for audio verification.');
    const content = await response.body();
    assert.equal(createHash('sha256').update(content).digest('hex'), blob.digest);
    await writeFile(join(process.env.RUNNER_TEMP, 'map-accepted-film.mp4'), content, { mode: 0o600, flag: 'wx' });
  }

} finally {
  await browser.close();
}
