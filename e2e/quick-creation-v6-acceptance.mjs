import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const origin = new URL(process.env.E2E_BASE_URL);
const commit = process.env.E2E_EXPECTED_COMMIT;
const generate = process.env.E2E_QC_GENERATE === 'true';
const verifyBrief = process.env.E2E_QC_BRIEF === 'true';
const retryFilmId = process.env.E2E_QC_RETRY_FILM || '';
const existingWebId = process.env.E2E_QC_EXISTING_WEB || '';
assert.equal(origin.origin, 'https://dsn-1400e277-v6-codex-prd-agent.miduo.org');
assert.match(commit, /^[a-f0-9]{40}$/);
assert.ok(process.env.E2E_USER && process.env.E2E_PASSWORD && process.env.RUNNER_TEMP);
if (generate) assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Review original tasks before repeating paid jobs');
if (retryFilmId) assert.match(retryFilmId, /^[a-f0-9]{32}$/);
if (existingWebId) assert.match(existingWebId, /^[a-f0-9]{32}$/);
const out = join(process.env.RUNNER_TEMP, 'dsn-1400e277-evidence');
await mkdir(out, { recursive: true });
const receipt = { design: 'DSN-1400E277', version: 8, commit, origin: origin.origin, cases: [], runs: [], failures: [] };
const base = '/api/quick-creation';

const match = (path, method = 'GET') => response => new URL(response.url()).origin === origin.origin
  && new URL(response.url()).pathname === path && response.request().method() === method;

async function data(response, name) {
  assert.ok(response.ok(), `${name} HTTP ${response.status()}`);
  const envelope = await response.json();
  assert.notEqual(envelope.success, false, `${name} ${envelope.error?.code ?? ''}`);
  return envelope.data ?? envelope;
}

async function openWorkbench(page, { mobile = false } = {}) {
  await page.goto(origin.href);
  await page.getByRole('button', { name: '登录 / 注册', exact: true }).click();
  await page.locator('input[autocomplete="username"]').first().fill(process.env.E2E_USER);
  await page.locator('input[autocomplete="current-password"]').first().fill(process.env.E2E_PASSWORD);
  const [login] = await Promise.all([
    page.waitForResponse(match('/api/v1/auth/login', 'POST')),
    page.getByRole('button', { name: '开始身份确认', exact: true }).click(),
  ]);
  const { accessToken } = await data(login, 'MAP login');
  assert.ok(accessToken);
  if (mobile) {
    await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  }
  const toolbox = page.locator('nav button[title^="百宝箱"]:visible')
    .or(page.getByRole('button', { name: /^(?:AI\s*)?百宝箱$/ }).filter({ visible: true })).first();
  await toolbox.click();
  if (mobile) await page.getByPlaceholder('搜索智能体、工具').fill('快速创作');
  const card = mobile ? page.getByRole('button', { name: /^快速创作/ })
    : page.locator('.toolbox-tool-card').filter({ has: page.getByText('快速创作', { exact: true }) });
  await card.getByText('开发中', { exact: true }).waitFor();
  receipt.cases.push(`${mobile ? 'mobile' : 'desktop'} toolbox quick creation card has the in-development badge`);
  const [templates] = await Promise.all([
    page.waitForResponse(match(base + '/templates')),
    card.getByText('快速创作', { exact: true }).click(),
  ]);
  assert.equal(new URL(page.url()).pathname, '/quick-creation-agent');
  const catalog = await data(templates, 'style catalog');
  if (catalog.browserFilm) receipt.version = 9;
  assert.equal(catalog.categories.length, 15);
  assert.equal(catalog.items.length, 99);
  assert.equal(new Set(catalog.items.map(style => style.id)).size, 99);
  assert.equal(catalog.source.name, 'Lemo-Opuscar by Lemomo (LemoLab)');
  assert.ok(catalog.items.every(style => style.posterUrl && style.promptRef && !style.guide));
  await page.locator('[data-qc-ready="compose"]').waitFor();
  return accessToken;
}

async function verifyHostingEntry(page, mobile = false) {
  if (mobile) await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  const hosting = page.locator('nav a[href="/web-pages"]:visible, nav button[title^="网页"]:visible')
    .or(page.getByRole('button', { name: /^网页(?:托管)?$/ }).filter({ visible: true })).first();
  await hosting.click();
  const generate = mobile
    ? page.getByRole('button', { name: '生成', exact: true }).filter({ visible: true })
    : page.locator('[data-tour-id=webpages-generate-primary]');
  await generate.click();
  await page.locator('[data-qc-ready=compose][data-output=web]').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('from'), 'web-pages');
  await page.getByRole('button', { name: '返回网页托管', exact: true }).waitFor();
  await page.screenshot({ path: join(out, `10-${mobile ? 'phone' : 'desktop'}-hosting-entry.png`) });
  receipt.cases.push(`${mobile ? 'mobile' : 'desktop'} hosting generate button opens quick creation with webpage selected`);
}

const digest = value => createHash('sha256').update(value).digest('hex');

async function stopAtSubmission(page, click) {
  const target = new URL(`${base}/runs`, origin).href;
  let payload;
  const handler = async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    payload = route.request().postDataJSON();
    await route.fulfill({ status: 409, json: { success: false, error: { code: 'ACCEPTANCE_CAPTURED', message: '验收已记录提交数据' } } });
  };
  await page.route(target, handler);
  try {
    const [response] = await Promise.all([page.waitForResponse(match(base + '/runs', 'POST')), click()]);
    assert.equal(response.status(), 409);
    assert.equal((await response.json()).error.code, 'ACCEPTANCE_CAPTURED');
    assert.ok(payload);
    return payload;
  } finally { await page.unroute(target, handler); }
}

async function verifyMaterialsBeforeGeneration(page, api, original) {
  const longSource = '# 核对正文\n\n' + '这是用来检查完整读取的段落。'.repeat(1600) + '\n\n尾注：保留结尾校验字样。';
  assert.ok(longSource.length > 20000);
  const imageBytes = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 720; canvas.height = 570;
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 250147;
    for (let i = 0; i < pixels.data.length; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      pixels.data[i] = i % 4 === 3 ? 255 : seed & 255;
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  assert.ok(imageBytes.length > 1024 * 1024);
  let releaseUpload;
  const holdUpload = new Promise(resolve => { releaseUpload = resolve; });
  await page.route(new URL(`${base}/attachments`, origin).href, async route => {
    await holdUpload;
    await route.continue();
  }, { times: 1 });
  const uploads = [];
  const capture = response => { if (match(base + '/attachments', 'POST')(response)) uploads.push(response); };
  page.on('response', capture);
  const tray = page.locator('[data-qc=attachment-tray]');
  const submit = page.locator('[data-qc=submit]');
  try {
    await page.locator('[data-qc=file-input]').setInputFiles([
      { name: '完整正文.md', mimeType: 'text/markdown', buffer: Buffer.from(longSource) },
      { name: '参考图.png', mimeType: 'image/png', buffer: imageBytes },
      { name: '备注.txt', mimeType: 'text/plain', buffer: Buffer.from('只作为本次核对的补注。') },
      { name: '空白.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
      { name: '损坏参考.png', mimeType: 'image/png', buffer: imageBytes.subarray(0, 40) },
    ]);
    await page.locator('[data-qc=attachment-tray][data-reading-count="5"]').waitFor();
    assert.equal(await submit.isDisabled(), true);
    await page.screenshot({ path: join(out, '15-pre-submit-reading.png') });
    releaseUpload();
    await page.locator('[data-qc=attachment-tray][data-count="6"][data-reading-count="0"][data-failed-count="2"]').waitFor();
    assert.equal(uploads.length, 5);
    const received = await Promise.all(uploads.filter(response => response.ok()).map(response => data(response, 'attachment scan')));
    const long = received.find(item => item.name === '完整正文.md');
    const reference = received.find(item => item.name === '参考图.png');
    const memo = received.find(item => item.name === '备注.txt');
    assert.equal(long.excerpt, longSource);
    assert.equal(reference.kind, 'image');
    assert.equal(received.find(item => item.name === '空白.txt').status, 'failed');
    assert.equal(uploads.find(response => !response.ok()).status(), 400);
    assert.equal(await tray.locator('[data-att-tile]').count(), 2);
    await tray.getByRole('button', { name: '查看另外 4 份资料' }).waitFor();
    assert.ok((await tray.boundingBox()).height <= 88);
    await tray.locator('[data-qc=tray-toggle]').click();
    const materials = page.locator('[data-qc=materials-panel]');
    const list = materials.locator('[data-qc=attachment-list]');
    assert.equal(await list.locator('section').first().getAttribute('aria-label'), '读取失败');
    assert.equal(await list.evaluate(element => getComputedStyle(element).overflowY), 'auto');
    await materials.getByRole('button', { name: '完整正文.md', exact: true }).click();
    assert.equal(await materials.locator('[data-qc=attachment-content]').textContent(), longSource);
    await page.screenshot({ path: join(out, '16-pre-submit-read-source.png') });
    await materials.getByRole('button', { name: '参考图.png', exact: true }).click();
    await materials.locator('[data-qc=reference-image] img').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-qc=reference-image] img')?.naturalWidth === 720);
    const referenceDownload = await api(`${base}/attachments/${reference.id}/image`);
    assert.equal(referenceDownload.status(), 200);
    assert.equal(digest(await referenceDownload.body()), digest(imageBytes));
    await page.screenshot({ path: join(out, '17-pre-submit-image.png') });
    await page.getByRole('button', { name: '完成', exact: true }).click();

    const extraFiles = [2, 3, 4].flatMap(index => [
      { name: `参考图-${index}.png`, mimeType: 'image/png', buffer: imageBytes },
      { name: `附录-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`补充说明 ${index}`) },
    ]);
    await page.locator('[data-qc=file-input]').setInputFiles(extraFiles);
    await page.locator('[data-qc=attachment-tray][data-count="12"][data-reading-count="0"][data-failed-count="2"]').waitFor();
    const extras = await Promise.all(uploads.slice(5).map(response => data(response, 'additional attachment scan')));
    assert.equal(extras.length, 6);
    const requirement = '以完整正文为准，保留尾注，并用参考图作为画面参考。' + '完整保留本段校验要求。'.repeat(400);
    assert.ok(requirement.length > 4000);
    await page.locator('#qc-ask').fill(requirement);
    const expectedIds = [original.id, long.id, reference.id, memo.id, ...extras.map(item => item.id)];
    const payload = await stopAtSubmission(page, () => submit.click());
    assert.equal(payload.kind, 'web');
    assert.equal(payload.templateId, 'ink-wash');
    assert.equal(payload.ask, requirement);
    assert.deepEqual(payload.attachmentIds, expectedIds);
    assert.equal(payload.title, '需求评审的三个习惯');
    assert.equal(await page.locator('#qc-ask').inputValue(), requirement);
    await page.getByRole('radiogroup', { name: '选择产出' }).getByRole('radio', { name: '视频', exact: true }).click();
    const film = await stopAtSubmission(page, () => submit.click());
    assert.deepEqual(film, { ...payload, kind: 'video', ...(receipt.version === 9 ? { duration: 'auto' } : {}) });
    receipt.preSubmission = { generatedJobs: 0, sourceSha256: digest(longSource), referenceSha256: digest(imageBytes),
      readable: expectedIds.length, rejected: 2, sourceCharacters: longSource.length, referenceBytes: imageBytes.length,
      referenceCount: [reference, ...extras.filter(item => item.kind === 'image')].length, requestCharacters: requirement.length,
      outputs: [payload.kind, film.kind], template: film.templateId, preservedRequirement: true };
    receipt.cases.push('real source scan and image preview; verified exact web and video payloads intercepted before admission');
  } finally {
    releaseUpload();
    page.off('response', capture);
  }
}

async function verifyBriefJourney(page, api) {
  const createdRuns = [];
  const observe = request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === base + '/runs') createdRuns.push(request);
  };
  page.on('request', observe);
  const sendButton = page.getByRole('button', { name: '发给快速创作', exact: true });
  async function send(text) {
    await page.getByRole('textbox', { name: '发给快速创作', exact: true }).fill(text);
    const [response] = await Promise.all([
      page.waitForResponse(candidate => {
        const url = new URL(candidate.url());
        return url.origin === origin.origin && url.pathname.startsWith(`${base}/brief/`)
          && url.pathname.endsWith('/messages') && candidate.request().method() === 'POST'
          && candidate.request().postDataJSON().text === text;
      }, { timeout: 105_000 }),
      sendButton.click(),
    ]);
    assert.ok(response.ok(), `Brief message HTTP ${response.status()}`);
    assert.equal(await response.finished(), null, 'The current brief reply must finish streaming');
    const events = (await response.text()).split(/\r?\n/).filter(line => line.startsWith('event:'));
    assert.ok(events.includes('event: session'), `Brief turn did not save a session. Stream events: ${events.filter((event, i) => i === 0 || events[i - 1] !== event).join(', ')}`);
    const briefId = new URL(page.url()).searchParams.get('brief');
    assert.match(briefId, /^[a-f0-9]{32}$/);
    const saved = await data(await api(`${base}/brief/${briefId}`), 'read completed brief turn');
    assert.equal(saved.busy, false, 'The current brief turn must be saved');
    assert.equal(saved.messages.findLast(message => message.role === 'user')?.text, text);
    return saved;
  }
  try {
    await send('可以开始了');
    await page.locator('[data-qc=brief][data-ready=false]').waitFor();
    assert.equal(createdRuns.length, 0, 'An incomplete brief must never start a generation job');
    assert.equal(await page.locator('[data-qc=submit]').isEnabled(), false);
    await page.screenshot({ path: join(out, '11-brief-missing.png') });
    await page.getByRole('radiogroup', { name: '选择产出' }).getByRole('radio', { name: '视频', exact: true }).click();

    const beforePick = await send('我要做一个 1 分钟的手绘培训视频，给刚加入产品团队的新同事。主题是需求评审的三个习惯：先读目标确认解决谁的什么问题，再明确哪些事这次不做，最后核对能操作的验收条件。请推荐三种适合这份内容的风格。');
    assert.equal(beforePick.brief.ready, true, 'The model must complete the brief for the supplied topic');
    assert.equal(beforePick.kind, 'video');
    const reply = beforePick.messages.at(-1);
    assert.ok(reply?.model && reply.platform);
    assert.equal(reply.recommendations?.length, 3);
    const briefId = beforePick.id;
    const secondStyle = reply.recommendations[1].templateId;
    const activeRecommendation = page.locator(`[data-qc=rec-style][data-style="${secondStyle}"] [data-qc=rec-use]`);
    await activeRecommendation.waitFor();
    await page.screenshot({ path: join(out, '12-brief-recommendations.png') });

    const catalog = await data(await api(base + '/templates'), 'read catalog for the selected style');
    const selectedName = catalog.items.find(item => item.id === secondStyle)?.name;
    assert.ok(selectedName);
    const picked = await send('第二个');
    assert.ok(picked.revision > beforePick.revision);
    assert.equal(picked.styleId, secondStyle);
    await page.waitForFunction(name => document.querySelector('[data-qc=style-chip]')?.getAttribute('aria-label')?.includes(name),
      selectedName, { timeout: 105_000 });
    await page.locator('[data-qc=brief-start]:enabled').click();
    await page.locator('[data-qc=script-draft] [data-qc=script-confirm]').waitFor({ timeout: 105_000 });
    let planned = await data(await api(`${base}/brief/${briefId}`), 'read rendered script');
    assert.ok(planned.script.length > 0 && planned.script.every(scene => scene.visual && scene.narration));
    assert.equal(createdRuns.length, 0, 'A storyboard draft must not enter the generation queue');
    if (receipt.version === 9) {
      const initialSeconds = planned.script.reduce((sum, scene) => sum + scene.durationSec, 0);
      assert.ok(initialSeconds >= 51 && initialSeconds <= 69);
      planned = await send('长一点');
      assert.equal(planned.durationChoice, 180);
      const adjustedSeconds = planned.script.reduce((sum, scene) => sum + scene.durationSec, 0);
      assert.ok(adjustedSeconds >= 153 && adjustedSeconds <= 207);
      receipt.storyboard = { initialSeconds, adjustedSeconds };
    }
    await page.reload();
    await page.locator('[data-qc=script-draft] [data-qc=script-confirm]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('brief'), briefId);
    await page.screenshot({ path: join(out, '13-brief-script-restored.png') });
    receipt.brief = { id: briefId, model: planned.messages.at(-1)?.model, selectedStyle: planned.styleId,
      revision: planned.revision, scenes: planned.script.length, admittedBeforeConfirm: createdRuns.length };
    if (!generate) {
      const confirm = await stopAtSubmission(page, () => page.locator('[data-qc=script-confirm]').click());
      const skip = await stopAtSubmission(page, () => page.locator('[data-qc=brief-skip-script]').click());
      assert.equal(confirm.briefId, briefId);
      assert.equal(confirm.briefRevision, planned.revision);
      assert.equal(confirm.templateId, planned.styleId);
      assert.equal(confirm.kind, 'video');
      assert.equal(confirm.briefMode, 'confirm');
      assert.deepEqual(skip, { ...confirm, briefMode: 'skip' });
      receipt.brief.submittedModesBeforeAdmission = ['confirm', 'skip'];
      receipt.brief.generatedJobs = 0;
    }
    receipt.cases.push('real model, 3 style recommendations, current recommendation selection, storyboard no-queue and restored brief');
  } finally {
    page.off('request', observe);
  }
}

async function verifyV9Duration(page) {
  const output = page.getByRole('radiogroup', { name: '选择产出' });
  await output.getByRole('radio', { name: '视频', exact: true }).click();
  const chip = page.locator('[data-qc=style-chip]');
  await chip.getByText(/约 3 分钟/).waitFor();
  await chip.click();
  await page.locator('[data-qc=duration-basis]').filter({ hasText: /约 13 幕/ }).waitFor();
  assert.equal(await page.locator('[data-qc=trial-toggle]').getAttribute('aria-checked'), 'true');
  await page.locator('[data-qc=duration-option][data-value="60"]').click();
  await page.locator('[data-qc=trial-toggle][aria-checked="false"]').waitFor();
  await page.locator('[data-qc=duration-option][data-value="600"]').click();
  await page.screenshot({ path: join(out, '16-v9-duration.png') });
  await page.keyboard.press('Escape');
  const payload = await stopAtSubmission(page, () => page.locator('[data-qc=submit]').click());
  assert.equal(payload.duration, 600);
  await chip.click();
  await page.locator('[data-qc=duration-option][data-value="auto"]').click();
  await page.keyboard.press('Escape');
  await output.getByRole('radio', { name: '网页', exact: true }).click();
  receipt.cases.push('V9 duration uses server estimates, persistence payload and trial defaults');
}

async function openV9Run(page, view) {
  await page.getByRole('button', { name: /^我的作品，共/ }).click();
  await page.locator(`[data-qc=works] button[data-run-id="${view.id}"]`).click();
  await page.locator(`[data-run-id="${view.id}"]`).waitFor();
}

async function verifyV9Player(page, view, row) {
  await page.locator('[data-qc=browser-player] iframe').waitFor();
  const frame = page.frameLocator('[data-qc=browser-player] iframe');
  const timeline = frame.locator('audio');
  await timeline.waitFor();
  const cue = view.captions?.find(item => item.toSec - item.fromSec > 0.2);
  assert.ok(cue, 'The delivered bundle has an aligned caption track');
  await timeline.evaluate(element => new Promise((resolve, reject) => {
    if (element.readyState >= 1) { resolve(); return; }
    element.addEventListener('loadedmetadata', resolve, { once: true });
    element.addEventListener('error', reject, { once: true });
  }));
  await timeline.evaluate((element, time) => { element.currentTime = time; }, (cue.fromSec + cue.toSec) / 2);
  await frame.locator('figcaption span:visible').filter({ hasText: cue.text.replace(/\s+/g, ' ') }).waitFor();
  await frame.getByRole('button', { name: '字幕' }).click();
  await frame.locator('figcaption span').waitFor({ state: 'hidden' });
  await frame.getByRole('button', { name: '字幕' }).click();
  await frame.locator('figcaption span').waitFor({ state: 'visible' });
  assert.ok(await frame.locator('canvas').evaluate(canvas => canvas.width === 1920 && canvas.height === 1080));
  row.captionSeek = 'pass';
  row.preview = 'pass';
  await page.screenshot({ path: join(out, `07-v9-${view.status}.png`) });
}

async function verifyPreview(page, view, row) {
  await page.goto(new URL(`/quick-creation-agent?run=${encodeURIComponent(view.id)}`, origin).href);
  await page.locator(`[data-run-id="${view.id}"] [data-qc=done-card]`).waitFor();
  if (view.kind === 'video') {
    const video = page.locator('[data-qc=film]');
    await video.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-qc=film]')?.readyState >= 2);
    await page.locator('[data-qc=play-toggle]').click();
    await page.waitForFunction(() => document.querySelector('[data-qc=film]')?.currentTime > 0);
    await page.locator('[data-qc=play-toggle]').click();
    const caption = view.captions?.find(cue => cue.toSec - cue.fromSec >= 0.25 && cue.toSec <= view.durationSec + 0.1);
    if (caption) {
      await video.evaluate((element, second) => { element.currentTime = second; }, (caption.fromSec + caption.toSec) / 2);
      row.captionsBurnedIn = view.captionsBurnedIn === true;
      row.subtitleFreePreview = view.hasSubtitleFreePreview === true;
      const toggle = page.locator('[data-qc=captions-toggle]');
      if (row.captionsBurnedIn && !row.subtitleFreePreview) {
        assert.equal(await toggle.isDisabled(), true);
        row.captionSeek = 'burned-in-only';
      } else {
        const overlay = page.locator('[data-qc=caption]');
        await page.waitForFunction(expected => document.querySelector('[data-qc=caption]')?.textContent === expected, caption.text);
        await page.screenshot({ path: join(out, '07-video-captions-on.png') });
        await toggle.click();
        assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
        await overlay.waitFor({ state: 'hidden' });
        await page.screenshot({ path: join(out, '07-video-captions-off.png') });
        await toggle.click();
        await overlay.waitFor({ state: 'visible' });
        row.captionSeek = 'pass';
      }
    }
  } else {
    const frame = page.frameLocator('[data-qc=web-preview] iframe');
    await frame.locator('body').waitFor();
    row.visibleText = (await frame.locator('body').innerText()).trim().slice(0, 5000);
    assert.ok(row.visibleText.length > 100, 'Real webpage preview has visible content');
    row.headings = await frame.locator('h1, h2, h3').allTextContents();
  }
  await page.screenshot({ path: join(out, `07-${view.kind}-preview.png`) });
  row.preview = 'pass';
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(55_000);
  const version = await data(await page.request.get(new URL('/api/version', origin).href), 'MAP version');
  assert.equal(version.actualCommit, commit);
  const token = await openWorkbench(page);
  const api = (path, { headers, ...options } = {}) => page.request.fetch(new URL(path, origin).href, {
    headers: { Authorization: `Bearer ${token}`, 'X-Client': 'admin', ...headers },
    timeout: 20_000,
    ...options,
  });
  await verifyHostingEntry(page);
  await page.screenshot({ path: join(out, '01-desktop-compose.png') });
  assert.equal(await page.locator('[data-qc=submit]').isEnabled(), false);
  assert.ok(await page.locator('[data-qc=block-reason]').isVisible());
  const chip = page.locator('[data-qc=style-chip]');
  await chip.click();
  const popover = page.locator('[data-qc=style-popover]');
  await popover.getByRole('textbox').fill('水墨');
  await popover.getByRole('radio', { name: /中国水墨/ }).click();
  assert.match(await chip.getAttribute('aria-label'), /中国水墨/);
  await page.getByRole('radiogroup', { name: '选择产出' }).getByRole('radio', { name: '视频', exact: true }).click();
  await page.getByRole('radiogroup', { name: '选择产出' }).getByRole('radio', { name: '网页', exact: true }).click();
  assert.match(await chip.getAttribute('aria-label'), /中国水墨/);
  assert.equal(await page.locator('[data-qc-ready="compose"]').getAttribute('data-output'), 'web');
  await page.screenshot({ path: join(out, '02-desktop-web-style.png') });
  receipt.cases.push('real navigation, catalog, poster source, disabled empty submit, style independent from output');

  const [sample] = await Promise.all([
    page.waitForResponse(match(base + '/attachments/knowledge', 'POST')),
    page.getByRole('button', { name: /用示例稿件试一下/ }).click(),
  ]);
  const original = await data(sample, 'sample document');
  assert.equal(original.name, '需求评审的三个习惯.md');
  assert.equal(original.status, 'ready');
  assert.ok(original.excerpt.includes('习惯三：最后对验收'));
  if (receipt.version === 9) await verifyV9Duration(page);
  await page.locator('[data-qc=submit]:enabled').waitFor();
  await page.screenshot({ path: join(out, '03-desktop-source.png') });
  receipt.cases.push('fixed V6 sample loaded and eligible');

  const phone = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  phone.setDefaultTimeout(55_000);
  try {
    await openWorkbench(phone, { mobile: true });
    await verifyHostingEntry(phone, true);
    const phoneWidth = await phone.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.equal(phoneWidth.viewport, 375);
    assert.equal(phoneWidth.scroll, phoneWidth.viewport);
    await phone.screenshot({ path: join(out, '04-phone-compose.png') });
    receipt.cases.push('distinct touch context and no 375px page overflow');
  } catch (error) {
    await phone.screenshot({ path: join(out, '04-phone-failure.png') }).catch(() => {});
    receipt.failures.push({ kind: 'mobile', code: 'navigation', details: String(error.message).slice(0, 250) });
  } finally {
    await phone.close();
  }
  if (!generate && !verifyBrief) {
    try { await verifyMaterialsBeforeGeneration(page, api, original); }
    catch (error) {
      await page.screenshot({ path: join(out, '15-pre-submit-failure.png') }).catch(() => {});
      receipt.failures.push({ kind: 'pre-submit', code: 'materials', details: String(error.message).slice(0, 350) });
    }
  }
  if (generate) {
    const filmInput = { kind: 'video', templateId: 'sketchnote', ask: '', attachmentIds: [original.id], title: '需求评审的三个习惯',
      ...(receipt.version === 9 ? { duration: 180, trial: true } : {}) };
    const unverified = await api(base + '/runs', { method: 'POST', data: filmInput });
    assert.equal(unverified.status(), 400, 'A request without explicit intent must not create a task');
    assert.equal((await unverified.json()).error?.code, 'TASK_INTENT_REQUIRED');
    receipt.cases.push('generation is rejected unless the authenticated request supplies explicit intent');
    let web;
    try {
      if (existingWebId) {
        const existing = await data(await api(`${base}/runs/${existingWebId}`), 'read existing published webpage');
        assert.equal(existing.status, 'done');
        assert.equal(existing.kind, 'web');
        assert.equal(existing.templateId, 'ink-wash');
        assert.equal(existing.attachments[0]?.excerpt, original.excerpt);
        assert.ok(existing.publish.siteId);
        const row = { id: existing.id, kind: 'web', currentStatus: 'done', siteId: existing.publish.siteId, reused: true };
        receipt.runs.push(row);
        await verifyPreview(page, existing, row);
        await page.locator('[data-qc=published]').waitFor();
        receipt.cases.push('the previously published webpage and its preview survived the deployment');
      } else {
        const [created] = await Promise.all([
          page.waitForResponse(match(base + '/runs', 'POST')),
          page.locator('[data-qc=submit]').click(),
        ]);
        web = await data(created, 'queue real webpage');
        receipt.runs.push({ id: web.id, kind: 'web', admitted: web.status });
        console.log(`Quick creation web ${web.id}: ${web.status}`);
        assert.equal(web.kind, 'web');
        assert.equal(web.attachments[0].id, original.id);
        assert.equal(web.templateId, 'ink-wash');
      }
    } catch (error) {
      receipt.failures.push({ kind: 'web', code: 'admission', details: String(error.message).slice(0, 250) });
    }
    try {
      const prior = retryFilmId ? await data(await api(`${base}/runs/${retryFilmId}`), 'read the original failed video') : null;
      if (prior) {
        assert.equal(prior.status, 'failed');
        assert.equal(prior.kind, 'video');
        assert.equal(prior.templateId, 'sketchnote');
        assert.equal(prior.attachments[0]?.excerpt, original.excerpt);
      }
      const filmPath = prior ? `${base}/runs/${prior.id}/retry` : base + '/runs';
      const filmRequest = {
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        data: prior ? { action: 'requeue' } : filmInput,
      };
      const film = await data(await api(filmPath, filmRequest), 'queue real code video');
      receipt.runs.push({ id: film.id, kind: 'video', admitted: film.status, retryOf: prior?.id });
      console.log(`Quick creation video ${film.id}: ${film.status}`);
      assert.equal(film.kind, 'video');
      assert.equal(film.attachments[0].id, prior?.attachments[0]?.id ?? original.id);
      assert.equal(film.templateId, 'sketchnote');
      if (prior) {
        assert.notEqual(film.id, prior.id);
        const replay = await api(filmPath, filmRequest);
        assert.equal(replay.headers()['idempotency-replayed'], 'true');
        assert.equal((await data(replay, 'replay the same video retry')).id, film.id);
        receipt.cases.push('retry reused the original video inputs and replay returned the same task ID');
      }
    } catch (error) {
      receipt.failures.push({ kind: 'video', code: 'admission', details: String(error.message).slice(0, 250) });
    }
    if (web) {
      try {
        await page.locator('[data-qc=saved-notice]').waitFor();
        await page.reload();
        await page.locator(`[data-run-id="${web.id}"]`).waitFor();
        await page.screenshot({ path: join(out, '05-recovered-run.png') });
        const runUrl = new URL(`${base}/runs/${web.id}`, origin).href;
        await page.route(runUrl, route => route.abort('internetdisconnected'), { times: 1 });
        await page.locator('[data-qc=reconnecting]').waitFor();
        await page.screenshot({ path: join(out, '06-disconnected-run.png') });
        await page.locator('[data-qc=reconnecting]').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('[data-run-id]').getAttribute('data-run-id'), web.id);
        receipt.cases.push('transient browser disconnect, same persisted task resumed automatically');
      } catch (error) {
        receipt.failures.push({ id: web.id, kind: 'web', code: 'recovery', details: String(error.message).slice(0, 250) });
      }
    }
    const expected = new Map(receipt.runs.filter(row => !row.reused).map(row => [row.id, (row.kind === 'web' ? 22 : 135) * 60_000]));
    const started = Date.now();
    while (expected.size) {
      for (const [id, budget] of expected) {
        const view = await data(await api(`${base}/runs/${id}`), 'read durable run');
        const row = receipt.runs.find(item => item.id === id);
        if (row.currentStatus !== view.status) {
          console.log(`Quick creation ${view.kind} ${id}: ${view.status}`);
        }
        row.currentStatus = view.status;
        row.elapsedSec = view.elapsedSec;
        const stage = view.stages?.find(item => item.status === 'running') ?? view.stages?.at(-1);
        if (stage) {
          row.stages ??= [];
          if (row.stages.at(-1)?.key !== stage.key || row.stages.at(-1)?.status !== stage.status) {
            row.stages.push({ key: stage.key, label: stage.label, status: stage.status, elapsedSec: view.elapsedSec });
          }
        }
        if (view.status === 'failed' || Date.now() - started > budget) {
          const failure = { id, kind: view.kind,
            code: view.status === 'failed' ? 'task_failed' : 'acceptance_deadline',
            stage: view.failure?.stageKey ?? stage?.key, message: view.failure?.message };
          receipt.failures.push(failure);
          console.log(JSON.stringify(failure));
          expected.delete(id);
          continue;
        }
        if (view.status === 'trial-ready') {
          try {
            await openV9Run(page, view);
            await verifyV9Player(page, view, row);
            assert.equal(view.trial.scenes, 2);
            assert.ok(view.trial.seconds >= 12 && view.trial.seconds <= 45);
            const [approved] = await Promise.all([
              page.waitForResponse(match(`${base}/runs/${id}/trial/approve`, 'POST')),
              page.locator('[data-qc=trial-approve]').click(),
            ]);
            const next = await data(approved, 'approve trial and resume');
            assert.equal(next.trial.status, 'approved');
            assert.equal(next.targetDurationSec, view.targetDurationSec);
            receipt.runs.push({ id: next.id, kind: 'video', admitted: next.status, resumedTrial: id });
            expected.set(next.id, budget);
          } catch (error) { receipt.failures.push({ id, code: 'trial_resume', details: String(error.message).slice(0, 250) }); }
          expected.delete(id);
          continue;
        }
        if (view.status !== 'done') continue;
        try {
          if (view.bundleUrl) {
            const bundle = await data(await api(view.bundleUrl), 'committed browser film');
            assert.equal(bundle.version, 1);
            assert.ok(bundle.aac && bundle.opus);
            assert.ok(Math.abs(bundle.durationSec - view.targetDurationSec) <= view.targetDurationSec * .15);
            assert.equal(view.media, null);
            row.durationSec = bundle.durationSec;
            row.captionCount = bundle.captions.length;
          } else if (view.kind === 'video') {
            const response = await api(view.media.url, { headers: { Range: 'bytes=0-31' } });
            assert.equal(response.status(), 206);
            assert.equal((await response.body()).toString('ascii', 4, 8), 'ftyp');
            assert.ok(view.durationSec > 0);
            row.durationSec = view.durationSec;
            row.captionCount = view.captions?.length ?? 0;
          } else {
            assert.ok(view.previewSiteId);
          }
          if (view.bundleUrl) {
            await openV9Run(page, view);
            await verifyV9Player(page, view, row);
            const exportButton = page.locator('[data-qc=export-start]:enabled');
            const unsupported = page.locator('[data-qc=export-unsupported]');
            await exportButton.or(unsupported).waitFor();
            if (await exportButton.count()) {
              await exportButton.click();
              const status = page.locator('[data-qc=export-card][data-state=exporting]');
              await status.waitFor();
              await status.getByRole('button', { name: '取消导出' }).click();
              await exportButton.waitFor();
              await exportButton.click();
              const link = page.getByRole('link', { name: '下载文件' });
              await link.waitFor({ timeout: 25 * 60_000 });
              const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
              assert.match(download.suggestedFilename(), /\.(mp4|webm)$/);
              row.browserExport = 'pass';
            } else {
              await page.locator('[data-qc=export-unsupported]').waitFor();
              await page.getByRole('button', { name: '请服务器导出' }).click();
              const cloud = page.getByRole('button', { name: '下载云端导出的 MP4' });
              await cloud.waitFor({ timeout: 50 * 60_000 });
              row.cloudExport = 'pass';
            }
          } else await verifyPreview(page, view, row);
          const publish = `${base}/runs/${id}/publish`;
          const [published] = await Promise.all([
            page.waitForResponse(match(publish, 'POST')),
            page.locator('[data-qc=publish]').click(),
          ]);
          const a = await data(published, 'publish completed output through the UI');
          const b = await data(await api(publish, { method: 'POST', data: {} }), 'repeat same publication');
          assert.ok(a.publish.siteId && a.publish.siteId === b.publish.siteId);
          await page.locator('[data-qc=published]').waitFor();
          row.siteId = a.publish.siteId;
          await page.screenshot({ path: join(out, `08-${view.kind}-published.png`) });
          if (view.kind === 'video' && row.captionSeek !== 'pass') {
            receipt.failures.push({ id, kind: view.kind, code: 'no_timed_caption_verified' });
          }
        } catch (error) {
          receipt.failures.push({ id, kind: view.kind, code: 'preview_or_publication', details: String(error.message).slice(0, 250) });
          await page.screenshot({ path: join(out, `07-${view.kind}-failure.png`) }).catch(() => {});
        }
        expected.delete(id);
      }
      if (expected.size) await delay(20_000);
    }
  }
  if (verifyBrief) {
    try {
      await verifyHostingEntry(page);
      await verifyBriefJourney(page, api);
    } catch (error) {
      await page.screenshot({ path: join(out, '13-brief-failure.png') }).catch(() => {});
      receipt.failures.push({ kind: 'brief', code: 'journey', details: String(error.message).slice(0, 280) });
    }
  }
  assert.equal(receipt.failures.length, 0, JSON.stringify(receipt.failures));
} finally {
  await writeFile(join(out, 'result.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
}
