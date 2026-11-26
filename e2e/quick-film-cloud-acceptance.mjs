import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const origin = 'https://opendesign-sketchnote-film-codex-prd-agent.miduo.org';
const deployedCommit = '31cdc15f00a2057ae5711ab5e49206c51660296d';
assert.equal(process.env.E2E_BASE_URL, origin, 'Target must be the isolated MAP preview');
assert.ok(process.env.E2E_USER && process.env.E2E_PASSWORD, 'Cloud acceptance credentials are missing');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
  const nav = page.locator('a[href="/web-pages"]:visible').first();
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
  await movies.selectOption(reference.runId);
  const filmPath = `/api/design-artifacts/runs/${reference.runId}/film.mp4`;
  const [film] = await Promise.all([
    page.waitForResponse(requestMatches(filmPath, 'GET'), { timeout: 95_000 }),
    dialog.getByRole('button', { name: '预览或取回成片', exact: true }).click(),
  ]);
  assert.ok(film.ok(), `Recover MP4 returned HTTP ${film.status()}`);
  const media = await film.body();
  assert.equal(media.length, 29_785_188);
  assert.equal(digest(media), '192c5094efe19eea21e6039c628bcfe4d978158e45d2b2d8967a2313751f88e0');
  await page.waitForFunction(() => {
    const video = document.querySelector('video[aria-label="生成视频预览"]');
    return video?.readyState >= 1 && Math.abs(video.duration - 90) < 0.15;
  }, null, { timeout: 25_000 });
  console.log('Original MP4 recovered in browser; bytes and duration match the original.');

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
  assert.equal(site.files.find((file) => file.path === 'film.mp4')?.size, media.length);
  await dialog.getByRole('button', { name: '打开分享设置', exact: true }).click();
  const share = page.getByRole('dialog', { name: /建一条分享链接/ });
  await share.waitFor();
  await share.getByText(/只有你本人打开有内容/).waitFor();
  console.log('Save verified twice against one private site; share settings opened with the owner-only default.');

  const input = reference.uploadedSources[0];
  const asset = await responseData(await page.request.get(endpoint(`/api/v1/attachments/${input.attachmentId}`).href, apiAuth), 'Read original attachment metadata');
  const fileUrl = new URL(asset.url, origin);
  assert.equal(fileUrl.protocol, 'https:');
  const document = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
  assert.ok(document.ok, `Read original attachment returned HTTP ${document.status}`);
  const source = Buffer.from(await document.arrayBuffer());
  assert.equal(source.length, 15_903);
  assert.equal(digest(source), input.contentHash);
  assert.equal(digest(reference.instruction), 'cfc8631202ec14fd5f88c61f65c4c0f0bb642d7802b6c622e5308db87e7fa7a1');
  const earlier = history.items.some((item) => item.title === 'architectural-decision-records'
    && item.uploadedSources?.[0]?.contentHash === input.contentHash
    && item.instruction === reference.instruction);
  if (earlier) {
    console.log('The same ADR already has a Quick Create submission. Existing task was retained.');
  } else {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '快速创作', exact: true }).click();
    await sourceInput.setInputFiles({ name: input.fileName, mimeType: 'text/markdown', buffer: source });
    await dialog.getByLabel('创作要求（可选）').fill(reference.instruction);
    await dialog.getByLabel('模型', { exact: true }).selectOption('gpt-6.1-sol');
    const [created] = await Promise.all([
      page.waitForResponse(requestMatches('/api/design-artifacts/runs', 'POST'), { timeout: 90_000 }),
      dialog.getByRole('button', { name: '生成视频', exact: true }).click(),
    ]);
    const run = await responseData(created, 'Submit original ADR through Quick Create');
    assert.equal(run.artifactType, 'code-film');
    assert.equal(run.uploadedSources[0].contentHash, input.contentHash);
    await page.reload();
    await page.getByRole('button', { name: '快速创作', exact: true }).click();
    await movies.locator('option').filter({ hasText: 'architectural-decision-records' }).first().waitFor({ state: 'attached', timeout: 45_000 });
    console.log('Original ADR and unchanged prompt submitted once through the browser; the task is visible again after reload.');
  }
} finally {
  await browser.close();
}
