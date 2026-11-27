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
const briefAdmission = process.env.E2E_QC_BRIEF_ADMISSION || 'none';
const survey = briefAdmission === 'survey';
const retryFilmId = process.env.E2E_QC_RETRY_FILM || '';
const existingWebId = process.env.E2E_QC_EXISTING_WEB || '';
assert.equal(origin.origin, 'https://dsn-1400e277-v6-codex-prd-agent.miduo.org');
assert.match(commit, /^[a-f0-9]{40}$/);
assert.ok(process.env.E2E_USER && process.env.E2E_PASSWORD && process.env.RUNNER_TEMP);
assert.ok(['none', 'confirm', 'skip', 'survey'].includes(briefAdmission));
if (briefAdmission !== 'none') assert.ok(verifyBrief && !generate, 'Run one brief acceptance mode separately from fixed manuscript generation');
if (generate || briefAdmission !== 'none') assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Review original tasks before repeating paid jobs');
if (retryFilmId) assert.match(retryFilmId, /^[a-f0-9]{32}$/);
if (existingWebId) assert.match(existingWebId, /^[a-f0-9]{32}$/);
const out = join(process.env.RUNNER_TEMP, 'dsn-1400e277-evidence');
await mkdir(out, { recursive: true });
const receipt = { design: 'DSN-1400E277', version: 8, commit, origin: origin.origin, cases: [], runs: [], failures: [] };
const base = '/api/quick-creation';
const sha256 = text => createHash('sha256').update(text).digest('hex');

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
  if (!mobile) {
    assert.equal((await generate.innerText()).trim(), '生成');
    assert.equal(await page.locator('.web-hosting-toolbar-actions').getByRole('button', { name: '合集', exact: true }).count(), 0);
  }
  await generate.click();
  await page.locator('[data-qc-ready=compose][data-output=web]').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('from'), 'web-pages');
  await page.getByRole('button', { name: '返回网页托管', exact: true }).waitFor();
  await page.screenshot({ path: join(out, `10-${mobile ? 'phone' : 'desktop'}-hosting-entry.png`) });
  if (mobile) {
    const tools = page.locator('[data-qc=composer-tools]');
    const plusButton = tools.locator('[data-qc=composer-plus]');
    const plusMenu = page.locator('[data-qc=plus-menu]');
    await plusButton.click();
    await plusMenu.waitFor();
    assert.deepEqual(await plusMenu.getByRole('button').allTextContents(), ['上传稿件或图片', '从知识库选择']);
    await page.screenshot({ path: join(out, '10-phone-plus.png') });
    await page.keyboard.press('Escape');
    await plusMenu.waitFor({ state: 'hidden' });
    await tools.locator('[data-qc=style-chip]').click();
    const style = page.locator('[data-qc=style-popover]');
    const output = style.getByRole('radiogroup', { name: '选择产出' });
    assert.equal(await output.getByRole('radio', { name: '网页', exact: true }).getAttribute('aria-checked'), 'true');
    await page.screenshot({ path: join(out, '10-phone-style.png') });
    await page.keyboard.press('Escape');
    await style.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[data-qc=block-reason]').count(), 0);
    assert.equal(await tools.locator('[data-qc=brief-send]').isEnabled(), false);
  }
  receipt.cases.push(`${mobile ? 'mobile' : 'desktop'} hosting generate button opens quick creation with webpage selected`);
}

async function verifyBriefJourney(page, api) {
  const createdRuns = [];
  const observe = request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === base + '/runs') createdRuns.push(request);
  };
  page.on('request', observe);
  const sendButton = page.getByRole('button', { name: '发给快速创作', exact: true });
  const input = page.getByRole('textbox', { name: '发给快速创作', exact: true });
  const persistedBrief = async (id, afterRevision = 0) => {
    const deadline = Date.now() + 110_000;
    do {
      const brief = await data(await api(`${base}/brief/${id}`), 'read durable brief');
      if (brief.revision > afterRevision && !brief.busy) return brief;
      await delay(1000);
    } while (Date.now() < deadline);
    assert.fail('The conversation revision did not persist before the deadline');
  };
  async function send(text) {
    await input.fill(text);
    const [response] = await Promise.all([
      page.waitForResponse(item => new URL(item.url()).pathname.endsWith('/messages') && item.request().method() === 'POST'),
      sendButton.click(),
    ]);
    assert.equal(response.status(), 200);
    assert.match(response.headers()['content-type'], /text\/event-stream/);
  }
  try {
    await page.getByRole('button', { name: '我想做一个宣传片', exact: true }).click();
    await page.locator('[data-qc=brief][data-ready=false]').waitFor();
    const briefId = new URL(page.url()).searchParams.get('brief');
    assert.match(briefId, /^[a-f0-9]{32}$/);
    const incomplete = await persistedBrief(briefId);
    const clarification = incomplete.messages.at(-1);
    assert.equal(clarification?.role, 'agent');
    assert.ok(clarification.model && clarification.platform);
    assert.ok(clarification.quickReplies?.length >= 2 && clarification.quickReplies.length <= 4);
    // A clarification can be phrased declaratively. Keep the actual text for human review.
    receipt.clarification = { briefId, text: clarification.text, choices: clarification.quickReplies,
      model: clarification.model, platform: clarification.platform };
    await page.locator('[data-qc=quick-reply]').first().waitFor();
    await page.screenshot({ path: join(out, '11-brief-clarification.png') });
    await send('可以开始了');
    const missing = await persistedBrief(briefId, incomplete.revision);
    assert.equal(missing.brief.ready, false);
    assert.ok(missing.brief.missing.includes('讲什么'));
    assert.ok(missing.messages.some(message => message.role === 'agent' && message.model && message.platform));
    assert.equal(createdRuns.length, 0, 'An incomplete brief must never start a generation job');
    assert.equal(await page.locator('[data-qc=submit]').isEnabled(), false);
    await page.screenshot({ path: join(out, '11-brief-missing.png') });

    await send('我要做一个 1 分钟的手绘培训视频，给刚加入产品团队的新同事。主题是需求评审的三个习惯：先读目标确认解决谁的什么问题，再明确哪些事这次不做，最后核对能操作的验收条件。请推荐三种适合这份内容的风格。');
    const beforePick = await persistedBrief(briefId, missing.revision);
    const recommended = beforePick.messages.at(-1)?.recommendations;
    assert.equal(recommended?.length, 3);
    assert.equal(new Set(recommended.map(style => style.templateId)).size, 3);
    const secondStyle = recommended[1].templateId;
    assert.equal(beforePick.brief.ready, true);
    assert.equal(beforePick.kind, 'video');
    assert.equal(beforePick.attachments.length, 0);
    assert.ok(beforePick.messages.some(message => message.role === 'agent' && message.model && message.platform));
    await page.screenshot({ path: join(out, '12-brief-recommendations.png') });

    const catalog = await data(await api(base + '/templates'), 'read catalog for the selected style');
    const selectedName = catalog.items.find(item => item.id === secondStyle)?.name;
    assert.ok(selectedName);
    await send('第二个');
    await page.waitForFunction(name => document.querySelector('[data-qc=style-chip]')?.getAttribute('aria-label')?.includes(name),
      selectedName, { timeout: 105_000 });
    const picked = await persistedBrief(briefId, beforePick.revision);
    assert.equal(picked.styleId, secondStyle);
    await send('可以开始了吗？请先告诉我现在有没有准备好');
    const question = await persistedBrief(briefId, picked.revision);
    assert.equal(question.script.length, 0);
    assert.equal(createdRuns.length, 0, 'Asking about readiness must not start generation');
    if (briefAdmission === 'skip') {
      await verifyBriefOutput(page, api, page.locator('[data-qc=brief-skip-script]'), briefId, question);
      return;
    }
    if (briefAdmission === 'confirm') await send('可以开始了');
    else await page.locator('[data-qc=brief-start]:enabled').click();
    await page.locator('[data-qc=script-draft] [data-qc=script-confirm]').waitFor({ timeout: 105_000 });
    const planned = await persistedBrief(briefId, question.revision);
    assert.ok(planned.script.length > 0 && planned.script.every(scene => scene.visual && scene.narration));
    assert.equal(createdRuns.length, 0, 'A storyboard draft must not enter the generation queue');
    await page.reload();
    await page.locator('[data-qc=script-draft] [data-qc=script-confirm]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('brief'), briefId);
    await page.screenshot({ path: join(out, '13-brief-script-restored.png') });
    receipt.brief = { id: briefId, model: planned.messages.at(-1)?.model, selectedStyle: planned.styleId,
      revision: planned.revision, scenes: planned.script.length, admittedBeforeConfirm: createdRuns.length };
    receipt.brief.clarificationOptions = clarification.quickReplies.length;
    receipt.cases.push('real model, 3 style recommendations, current recommendation selection, storyboard no-queue and restored brief');
    if (briefAdmission === 'confirm') {
      await send('请调整第一幕。在第一幕画面上使用「先找真实问题」作为标题，保持其他分镜。');
      await page.reload();
      const revised = await persistedBrief(briefId, planned.revision);
      assert.match(revised.script[0]?.visual ?? '', /先找真实问题/);
      assert.equal(createdRuns.length, 0, 'A revised script stays a draft until confirmation');
      await page.locator('[data-qc=script-confirm]:enabled').waitFor({ timeout: 110_000 });
      await page.screenshot({ path: join(out, '14-brief-revision-restored.png') });
      receipt.brief.revised = revised.revision;
      await verifyBriefOutput(page, api, page.locator('[data-qc=script-confirm]'), briefId, revised);
    }
  } finally {
    page.off('request', observe);
  }
}

async function verifyBriefSurvey(page, api) {
  const cases = [
    ['promo', '我想做一个宣传片', 'clarify'],
    ['onboarding', '给新同事做个培训短片', 'clarify'],
    ['style-unknown', '不知道选什么风格', 'clarify'],
    ['start-incomplete', '可以开始了', 'hold'],
    ['start-variant', '开工吧！', 'hold'],
    ['negated', '先别开始，等我把产品资料补齐再说。', 'hold'],
    ['question', '我只是想问，可以开始了吗？', 'hold'],
    ['quotation', '片头台词用「可以开始了」，先聊脚本，不要生成。', 'hold'],
    ['recommended-video', '做视频给新产品经理讲需求评审。只讲三个习惯：找目标、定边界、写可操作的验收条件。请推荐三个易懂的教学风格和各自的理由。', 'recommend'],
    ['recommended-web', '我要做一个给客服组看的网页，说明交接顺序：先写待跟进客户，再列问题状态，最后标明负责人。请推荐三个适合清晰阅读的风格并说理由。', 'recommend'],
  ];
  receipt.dialogueSurvey = [];
  let generationRequests = 0;
  let scriptRequests = 0;
  const mutationPaths = /\/api\/quick-creation\/(?:runs|brief\/[^/]+\/messages)$/;
  const allowDialogueOnly = async route => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    const path = new URL(request.url()).pathname;
    if (path === base + '/runs') {
      generationRequests++;
      return route.abort();
    }
    if (request.postDataJSON()?.mode === 'script') {
      scriptRequests++;
      return route.abort();
    }
    return route.continue();
  };
  await page.route(mutationPaths, allowDialogueOnly);
  try {
    for (const [id, opening, expected] of cases) {
      const row = { id, opening, expected };
      const before = { generationRequests, scriptRequests };
      const start = Date.now();
      receipt.dialogueSurvey.push(row);
      try {
        await page.goto(new URL('/web-pages', origin).href);
        await page.locator('[data-tour-id=webpages-generate-primary]').click();
        await page.locator('[data-qc-ready=compose][data-output=web]').waitFor();
        await page.getByRole('textbox', { name: '发给快速创作', exact: true }).fill(opening);
        const [response] = await Promise.all([
          page.waitForResponse(item => new URL(item.url()).pathname.endsWith('/messages') && item.request().method() === 'POST'),
          page.getByRole('button', { name: '发给快速创作', exact: true }).click(),
        ]);
        assert.equal(response.status(), 200);
        const briefId = new URL(page.url()).searchParams.get('brief');
        assert.match(briefId, /^[a-f0-9]{32}$/);
        row.briefId = briefId;
        const deadline = Date.now() + 110_000;
        let session;
        do {
          session = await data(await api(`${base}/brief/${briefId}`), `read dialogue ${id}`);
          if (session.revision > 0 && !session.busy) break;
          await delay(1000);
        } while (Date.now() < deadline);
        const reply = session.messages.at(-1);
        assert.equal(reply?.role, 'agent');
        row.model = reply.model;
        row.platform = reply.platform;
        row.reply = reply.text;
        row.quickReplies = reply.quickReplies ?? [];
        row.recommendations = reply.recommendations ?? [];
        row.clarifyingQuestions = (reply.text.match(/[？?]/g) ?? []).length;
        row.ready = session.brief.ready;
        row.wrongStart = !!reply.startsProduction || scriptRequests > before.scriptRequests || generationRequests > before.generationRequests;
        assert.ok(row.model && row.platform);
        assert.equal(row.wrongStart, false);
        if (expected === 'clarify') {
          assert.ok(row.quickReplies.length >= 2 && row.quickReplies.length <= 4);
        }
        if (expected === 'hold') assert.equal(row.ready, false);
        if (expected === 'recommend') {
          assert.equal(row.recommendations.length, 3);
          assert.equal(new Set(row.recommendations.map(style => style.templateId)).size, 3);
        }
        row.outcome = 'pass';
      } catch (error) {
        row.outcome = 'failed';
        const details = String(error.message).slice(0, 280);
        receipt.failures.push({ kind: 'dialogue-survey', code: id, details });
        await page.screenshot({ path: join(out, `20-survey-${id}-failure.png`) }).catch(() => {});
      } finally {
        row.elapsedMs = Date.now() - start;
        await writeFile(join(out, 'result.json'), JSON.stringify(receipt, null, 2));
      }
      if (generationRequests > 0 || scriptRequests > 0) break;
    }
    assert.equal(receipt.dialogueSurvey.length, cases.length);
    assert.equal(generationRequests, 0);
    assert.equal(scriptRequests, 0);
    receipt.cases.push('ten openings recorded for human review of follow-up and recommendation quality, with no production request');
  } finally {
    await page.unroute(mutationPaths, allowDialogueOnly);
  }
}

async function verifyBriefOutput(page, api, action, briefId, brief) {
  const [response] = await Promise.all([
    page.waitForResponse(match(base + '/runs', 'POST')),
    action.click(),
  ]);
  const view = await data(response, 'queue video made from the conversation');
  assert.match(view.id, /^[a-f0-9]{32}$/);
  const row = { kind: 'video', id: view.id, briefId, revision: brief.revision, mode: briefAdmission, admitted: view.status };
  receipt.runs.push(row);
  // Persist the ID immediately so investigating a timeout never requires starting a second render.
  console.log(`Fileless code video ${view.id}: ${view.status} (${briefAdmission})`);
  await writeFile(join(out, 'result.json'), JSON.stringify(receipt, null, 2));
  const request = response.request();
  const payload = request.postDataJSON();
  assert.equal(payload.briefMode, briefAdmission);
  assert.equal(payload.briefId, briefId);
  assert.equal(payload.briefRevision, brief.revision);
  assert.deepEqual(payload.attachmentIds, []);
  assert.equal(view.contentSource, 'chat');
  assert.equal(view.templateId, brief.styleId);
  assert.equal(view.attachments.length, 1);
  const source = view.attachments[0];
  assert.equal(source.name, '对话创作稿件.md');
  assert.ok(source.excerpt?.trim());
  assert.equal(source.excerpt.length, source.chars);
  row.manuscriptSha256 = sha256(source.excerpt);
  if (briefAdmission === 'confirm') assert.match(view.ask, /先找真实问题/);
  else assert.doesNotMatch(view.ask, /用户确认的分镜/);
  const intent = (await request.allHeaders())['idempotency-key'];
  assert.ok(intent);
  const retried = await data(await api(base + '/runs', {
    method: 'POST', headers: { 'Idempotency-Key': intent }, data: payload,
  }), 'replay the same creation intent');
  assert.equal(retried.id, view.id);
  await page.getByText(/没有稿件.*内容来自和快速创作的对话/).waitFor();
  await page.screenshot({ path: join(out, '15-conversation-video-queued.png') });

  const statusUrl = `${base}/runs/${view.id}`;
  const deadline = Date.now() + 135 * 60_000;
  let finished;
  do {
    finished = await data(await api(statusUrl), 'read persisted video task');
    row.currentStatus = finished.status;
    if (finished.status === 'done') break;
    assert.notEqual(finished.status, 'failed', 'Fileless code video failed');
    await delay(20_000);
  } while (Date.now() < deadline);
  assert.equal(finished.status, 'done', 'Fileless video did not finish within the acceptance window');
  assert.equal(finished.contentSource, 'chat');
  assert.equal(sha256(finished.attachments[0].excerpt), row.manuscriptSha256);
  assert.ok(finished.durationSec > 0);
  row.durationSec = finished.durationSec;
  const evidence = await data(await api(`/api/design-artifacts/runs/${view.id}/evidence`), 'read cloud provenance');
  assert.equal(evidence.runId, view.id);
  row.runtimeEvidence = {
    workspaceManifestSha256: evidence.manifestSha256,
    providerAuditId: evidence.llmgwAuditId,
    successfulProviderCalls: evidence.llmgwAudits?.filter(audit => audit.statusCode >= 200 && audit.statusCode < 300).length ?? 0,
  };
  await verifyPreview(page, finished, row);
  const publish = statusUrl + '/publish';
  const [published] = await Promise.all([
    page.waitForResponse(match(publish, 'POST')),
    page.locator('[data-qc=publish]').click(),
  ]);
  const saved = await data(published, 'publish fileless video');
  assert.match(saved.publish.siteId, /^[a-f0-9]{32}$/);
  row.siteId = saved.publish.siteId;
  const republished = await data(await api(publish, { method: 'POST', data: {} }), 'repeat publishing');
  assert.equal(republished.publish.siteId, row.siteId);
  await page.locator('[data-qc=open-hosting]').click();
  await page.locator(`[data-hosted-site-id="${row.siteId}"]`).waitFor();
  await page.screenshot({ path: join(out, '16-conversation-video-hosting.png') });
  receipt.cases.push(`fileless video ${briefAdmission}, manuscript matched after generation, publication replay and hosting record`);
  assert.match(row.runtimeEvidence.workspaceManifestSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.ok(row.runtimeEvidence.providerAuditId && row.runtimeEvidence.successfulProviderCalls > 0,
    'The cloud provider audit did not correlate with this task');
  assert.ok(row.captionSeek, 'Timed captions could not be verified against the returned video');
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
      await page.waitForFunction(expected => document.querySelector('[data-qc=caption]')?.textContent === expected, caption.text);
      row.captionSeek = 'pass';
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
  receipt.fixedSourceSha256 = sha256(original.excerpt);
  assert.equal(receipt.fixedSourceSha256, 'ae2105b8889429e1444ebb3922e82b67cd707b63a10747d45824c1145cb5fcf1');
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
  if (generate) {
    const filmInput = { kind: 'video', templateId: 'sketchnote', ask: '', attachmentIds: [original.id], title: '需求评审的三个习惯' };
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
        if (view.status !== 'done') continue;
        try {
          if (view.kind === 'video') {
            const response = await api(view.media.url, { headers: { Range: 'bytes=0-31' } });
            assert.equal(response.status(), 206);
            assert.equal((await response.body()).toString('ascii', 4, 8), 'ftyp');
            assert.ok(view.durationSec > 0);
            row.durationSec = view.durationSec;
            row.captionCount = view.captions?.length ?? 0;
          } else {
            assert.ok(view.previewSiteId);
          }
          await verifyPreview(page, view, row);
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
          if (view.kind === 'video' && !row.captionSeek) {
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
      if (survey) await verifyBriefSurvey(page, api);
      else await verifyBriefJourney(page, api);
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
