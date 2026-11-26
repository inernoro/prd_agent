import assert from 'node:assert/strict';
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
  await movies.selectOption(reference.runId);
  const filmPath = `/api/design-artifacts/runs/${reference.runId}/film.mp4`;
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
  assert.equal(blob.length, 29_785_188);
  assert.equal(blob.digest, '192c5094efe19eea21e6039c628bcfe4d978158e45d2b2d8967a2313751f88e0');
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
  console.log('Original MP4 recovered in browser; hash, duration, playback and seek verified.');

  const saveButton = dialog.getByRole('button', { name: '保存到网页托管', exact: true });
  const save = async () => {
    const [result] = await Promise.all([
      page.waitForResponse(requestMatches(`/api/design-artifacts/runs/${reference.runId}/save-film`, 'POST'), { timeout: 110_000 }),
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

} finally {
  await browser.close();
}
