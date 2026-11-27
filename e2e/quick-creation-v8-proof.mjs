import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { launch, loadConfig, createMobileContext, stepClick, stepShot, writeManifest } from
  '../.claude/skills/create-visual-test-to-kb/scripts/harness.mjs';

const origin = new URL(process.env.E2E_BASE_URL);
const commit = process.env.E2E_EXPECTED_COMMIT;
assert.equal(origin.origin, 'https://dsn-1400e277-v6-codex-prd-agent.miduo.org');
assert.match(commit, /^[a-f0-9]{40}$/);
const config = loadConfig(new URL('../.claude/skills/create-visual-test-to-kb/acceptance.config.json', import.meta.url));
const out = join(process.env.RUNNER_TEMP, 'dsn-1400e277-evidence');
const environment = { kind: 'cds', branch: 'codex/dsn-1400e277-v6', commit, baseUrl: origin.origin };
const verifyUserRequests = process.env.E2E_QC_BRIEF_HANDOFF === 'true';
const reviewWebRunId = process.env.E2E_QC_REVIEW_WEB_ID;
if (verifyUserRequests) assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
let desktopToken;

async function switchToLight(page, mobile) {
  if (mobile) await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  const settings = page.locator('nav a[href="/settings"]:visible, nav button[title="设置"]:visible')
    .or(page.getByRole('button', { name: '设置', exact: true }).filter({ visible: true })).first();
  await settings.click();
  await page.getByText('皮肤设置', { exact: true }).first().click();
  await page.getByRole('button', { name: /^白天/ }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
}

async function enter(page, mobile) {
  await page.goto(origin.href);
  await page.getByRole('button', { name: '登录 / 注册', exact: true }).click();
  await page.locator('input[autocomplete=username]').first().fill(process.env.E2E_USER);
  await page.locator('input[autocomplete=current-password]').first().fill(process.env.E2E_PASSWORD);
  const [login] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/login'),
    page.getByRole('button', { name: '开始身份确认', exact: true }).click(),
  ]);
  assert.ok(login.ok(), '登录失败');
  if (!mobile) desktopToken = (await login.json()).data.accessToken;
  if (!mobile && process.env.E2E_QC_POLL_ID) {
    const runId = process.env.E2E_QC_POLL_ID;
    assert.match(runId, /^[a-f0-9]{32}$/);
    const response = await page.request.get(new URL(`/api/quick-creation/runs/${runId}`, origin).href,
      { headers: { Authorization: `Bearer ${desktopToken}` } });
    assert.ok(response.ok(), '读取原视频任务失败');
    const { id, status, kind, elapsedSec, stages, durationSec, captions, publish, failure } = (await response.json()).data;
    assert.equal(id, runId);
    const summary = { id, status, kind, elapsedSec, stages, durationSec, captionCount: captions?.length ?? 0, publish, failure };
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'retained-video-status.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  }
  await switchToLight(page, mobile);
  if (mobile) await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  const hosting = page.locator('nav a[href="/web-pages"]:visible, nav button[title^="网页"]:visible')
    .or(page.getByRole('button', { name: /^网页(?:托管)?$/ }).filter({ visible: true })).first();
  const prefix = mobile ? 'mobile' : 'desktop';
  const order = mobile ? 5 : 1;
  await stepClick(page, out, order, hosting, `${prefix}-hosting-nav`, '网页托管入口：从登录后的导航进入');
  if (!mobile) {
    const tools = page.locator('.web-hosting-toolbar-actions');
    await tools.waitFor();
    assert.equal(await tools.getByRole('button', { name: '合集', exact: true }).count(), 0);
    await tools.getByRole('button', { name: '上传网页', exact: true }).waitFor();
  }
  await stepClick(page, out, order + 1, page.getByRole('button', { name: '生成', exact: true }),
    `${prefix}-generate`, '生成入口：点击「生成」打开快速创作');
  const composer = page.locator('[data-qc-ready=compose][data-output=web]');
  await composer.waitFor();
  assert.equal(new URL(page.url()).searchParams.get('from'), 'web-pages');
  await page.getByRole('button', { name: '返回网页托管', exact: true }).waitFor();
  return composer;
}

async function verifyExistingWebRequests(page, id) {
  assert.match(id, /^[a-f0-9]{32}$/);
  await page.getByRole('button', { name: /^我的作品，共/ }).click();
  await page.locator(`[data-qc=works] button[data-run-id="${id}"]`).click();
  assert.equal(new URL(page.url()).searchParams.get('run'), id);
  await page.locator('[data-qc=done-card]').waitFor();
  const messages = [
    '请把这份稿件做成一页网页，保留先读目标、再画边界、最后对验收三个习惯。',
    '把页面主标题写成「评审入门手记」，省略首段介绍，从三个习惯开始。',
  ];
  const panel = page.locator('[data-qc=brief-run-requests]');
  await panel.locator('summary').click();
  const expected = messages.join('\n\n');
  assert.equal(await panel.locator('p').textContent(), expected);
  assert.equal(await page.getByText('没有补充要求，按模板默认节奏生成', { exact: true }).count(), 0);
  await page.reload();
  await panel.locator('summary').click();
  assert.equal(await panel.locator('p').textContent(), expected);
  const frame = page.frameLocator('[data-qc=web-preview] iframe');
  const headings = await frame.locator('h1').allTextContents();
  assert.ok(headings.some(heading => heading.replace(/\s/g, '').includes('评审入门手记')));
  await page.screenshot({ path: join(out, 'existing-web-request-proof.png'), scale: 'css' });

  const briefId = '56e925f0061046f9a851ef7153f5c6de';
  const headers = { Authorization: `Bearer ${desktopToken}`, 'X-Client': 'admin' };
  const briefResponse = await page.request.get(new URL(`/api/quick-creation/brief/${briefId}`, origin).href,
    { headers, timeout: 20_000 });
  assert.ok(briefResponse.ok());
  const brief = (await briefResponse.json()).data;
  assert.equal(brief.kind, 'web');
  assert.deepEqual(brief.messages.filter(message => message.role === 'user').map(message => message.text), messages);
  const recheck = revision => page.request.post(new URL('/api/quick-creation/runs', origin).href, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: { kind: 'web', templateId: brief.styleId, ask: '', briefId, briefRevision: revision,
      briefMode: 'skip', attachmentIds: brief.attachments.map(attachment => attachment.id) },
    timeout: 20_000,
  });
  const sameRevision = await recheck(brief.revision);
  assert.ok(sameRevision.ok(), `重复提交未返回原任务 HTTP ${sameRevision.status()}`);
  assert.equal((await sameRevision.json()).data.id, id);
  const mismatchedRevision = await recheck(brief.revision + 1);
  assert.equal(mismatchedRevision.status(), 409);
  assert.equal((await mismatchedRevision.json()).error.code, 'BRIEF_CHANGED');
  await writeFile(join(out, 'existing-web-request-proof.json'), JSON.stringify({
    runId: id, commit, headings, restoredRequests: messages, staleFallback: false,
    sameRevisionReused: true, mismatchedRevisionRejected: true,
  }, null, 2));
}

async function verifyExistingFilm(page, id) {
  assert.match(id, /^[a-f0-9]{32}$/);
  await page.getByRole('button', { name: /^我的作品，共/ }).click();
  const row = page.locator(`[data-qc=works] button[data-run-id="${id}"]`);
  await row.click();
  assert.equal(new URL(page.url()).searchParams.get('run'), id);
  const video = page.locator('[data-qc=film]');
  await video.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-qc=film]')?.readyState >= 2);
  const duration = await video.evaluate(element => element.duration);
  assert.ok(duration > 10);
  const frameTimes = [6, 17, 29, 42, Math.floor(duration) - 1].filter(time => time < duration);
  for (const time of frameTimes) {
    await video.evaluate((element, seek) => {
      element.pause();
      return new Promise(resolve => {
        element.addEventListener('seeked', () => resolve(), { once: true });
        element.currentTime = seek;
      });
    }, time);
    await video.screenshot({ path: join(out, `retained-film-${time}s.png`), scale: 'css' });
  }
  const result = await page.request.get(new URL(`/api/design-artifacts/runs/${id}/film.mp4`, origin).href,
    { headers: { Authorization: `Bearer ${desktopToken}`, 'X-Client': 'admin' }, timeout: 75_000 });
  assert.ok(result.ok());
  const filmFile = join(process.env.RUNNER_TEMP, 'retained-v8-proof.mp4');
  let probe;
  try {
    await writeFile(filmFile, await result.body());
    probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_name,codec_type,width,height:format=duration', '-of', 'json', filmFile], { encoding: 'utf8' }));
  } finally {
    await rm(filmFile, { force: true });
  }
  const proof = { id, commit, duration, frameTimes, streams: probe.streams };
  const proofPath = join(out, 'retained-film-review.json');
  await writeFile(proofPath, JSON.stringify(proof, null, 2));
  await page.locator('[data-qc=open-hosting]').click();
  let siteId;
  await page.waitForURL(url => {
    siteId = url.searchParams.get('focusSite');
    return url.pathname === '/web-pages' && Boolean(siteId);
  });
  assert.match(siteId, /^[a-f0-9]{32}$/);
  await page.locator(`[data-hosted-site-id="${siteId}"]`).first().waitFor();
  await page.waitForFunction(id => {
    const card = document.querySelector(`[data-hosted-site-id="${id}"]`);
    return card?.style.outline.includes('var(--accent-primary)');
  }, siteId);
  await writeFile(proofPath, JSON.stringify({ ...proof, siteId, highlighted: true }, null, 2));
  await page.screenshot({ path: join(out, 'retained-film-hosting.png'), scale: 'css' });
}

async function verifyWebHandoff(page) {
  const prefix = '/api/quick-creation';
  const api = async path => {
    const response = await page.request.get(new URL(path, origin).href,
      { headers: { Authorization: `Bearer ${desktopToken}`, 'X-Client': 'admin' }, timeout: 20_000 });
    assert.ok(response.ok(), `阅读任务或简报失败 HTTP ${response.status()}`);
    return (await response.json()).data;
  };
  const [attachmentReply] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === prefix + '/attachments/knowledge'),
    page.locator('[data-qc=sample-doc]').click(),
  ]);
  const source = (await attachmentReply.json()).data;
  assert.equal(createHash('sha256').update(source.excerpt).digest('hex'), 'ae2105b8889429e1444ebb3922e82b67cd707b63a10747d45824c1145cb5fcf1');
  const messages = [
    '请把这份稿件做成一页网页，保留先读目标、再画边界、最后对验收三个习惯。',
    '把页面主标题写成「评审入门手记」，省略首段介绍，从三个习惯开始。',
  ];
  let brief;
  for (const message of messages) {
    await page.getByRole('textbox', { name: '发给快速创作', exact: true }).fill(message);
    const [reply] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/messages') && r.request().method() === 'POST'),
      page.locator('[data-qc=brief-send]').click(),
    ]);
    assert.ok(reply.ok());
    assert.match(reply.headers()['content-type'], /text\/event-stream/);
    const id = new URL(page.url()).searchParams.get('brief');
    assert.match(id, /^[a-f0-9]{32}$/);
    const deadline = Date.now() + 110_000;
    let saved;
    do {
      saved = await api(`${prefix}/brief/${id}`);
      if (!saved.busy && saved.revision > (brief?.revision ?? 0)) break;
      await delay(1000);
    } while (Date.now() < deadline);
    assert.ok(!saved.busy && saved.revision > (brief?.revision ?? 0), '多轮对话未持久化');
    assert.equal(saved.kind, 'web');
    assert.ok(saved.messages.some(row => row.role === 'user' && row.text === message));
    brief = saved;
  }
  assert.deepEqual(brief.attachments.map(attachment => attachment.id), [source.id]);
  await page.screenshot({ path: join(out, 'brief-handoff-input.png'), scale: 'css' });
  const [queued] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === prefix + '/runs' && r.request().method() === 'POST'),
    page.locator('[data-qc=brief-start]').click(),
  ]);
  assert.ok(queued.ok());
  const payload = queued.request().postDataJSON();
  assert.equal(payload.ask, '', '测试必须从已保存对话传递要求');
  assert.equal(payload.briefId, brief.id);
  const { id } = (await queued.json()).data;
  assert.match(id, /^[a-f0-9]{32}$/);
  const result = { id, commit, briefId: brief.id, status: 'accepted', messages };
  const resultFile = join(out, 'brief-handoff.json');
  await writeFile(resultFile, JSON.stringify(result, null, 2));
  const deadline = Date.now() + 20 * 60_000;
  let current;
  do {
    current = await api(`${prefix}/runs/${id}`);
    result.status = current.status;
    result.stages = current.stages;
    await writeFile(resultFile, JSON.stringify(result, null, 2));
    if (['done', 'failed'].includes(current.status)) break;
    await delay(20_000);
  } while (Date.now() < deadline);
  assert.equal(current.status, 'done', current.failure?.message ?? '网页未在验收时限内完成');
  assert.equal(createHash('sha256').update(current.attachments[0].excerpt).digest('hex'),
    'ae2105b8889429e1444ebb3922e82b67cd707b63a10747d45824c1145cb5fcf1');
  await page.locator('[data-qc=done-card]').waitFor();
  const frame = page.frameLocator('[data-qc=web-preview] iframe');
  result.headings = await frame.locator('h1, h2, h3').allTextContents();
  const visible = await frame.locator('body').innerText();
  result.result = { exactHeading: result.headings.some(heading => heading.replace(/\s/g, '').includes('评审入门手记')),
    originalTopics: ['先读目标', '再画边界', '最后对验收'].filter(topic => visible.includes(topic)),
    introOmitted: !visible.replace(/\s/g, '').includes('刚加入团队的同学，第一次参加需求评审时常常不知道该看什么') };
  await page.screenshot({ path: join(out, 'brief-handoff-result.png'), scale: 'css' });
  await writeFile(resultFile, JSON.stringify(result, null, 2));
  assert.ok(result.result.exactHeading, '第二轮要求的主标题未进入成品');
  assert.equal(result.result.originalTopics.length, 3);
  assert.ok(result.result.introOmitted, '成品保留了要求省略的开头');
}

const { browser, page } = await launch(config, { environment });
let themeSupport;
let verdict = 'fail';
try {
  const version = await page.request.get(new URL('/api/version', origin).href);
  assert.equal((await version.json()).actualCommit, commit);
  await enter(page, false);
  themeSupport = { supportsLight: true, verifiedBy: 'skin settings then real landing' };
  if (verifyUserRequests) {
    await verifyWebHandoff(page);
  } else if (reviewWebRunId) {
    await verifyExistingWebRequests(page, reviewWebRunId);
  } else if (process.env.E2E_QC_POLL_ID) {
    await verifyExistingFilm(page, process.env.E2E_QC_POLL_ID);
  } else {
    await page.screenshot({ path: join(out, 'desktop-light-compose-css.png'), scale: 'css' });
    await stepShot(page, out, 3, 'desktop-web-compose', '快速创作：桌面入口默认选中网页，空稿时快捷生成禁用',
      page.locator('[data-qc=composer-tools]'));
    assert.equal(await page.locator('[data-qc=submit]').isEnabled(), false);
    await stepClick(page, out, 4, page.locator('[data-qc=style-chip]'), 'desktop-style-click', '风格入口：从同一个输入框打开风格库');
    await page.locator('[data-qc=style-popover]').waitFor();

    const { ctx, page: phone } = await createMobileContext(browser, config, { viewport: { width: 390, height: 844 }, environment });
    try {
      await enter(phone, true);
      const tools = phone.locator('[data-qc=composer-tools]');
      assert.equal(await tools.locator('[data-qc=brief-send]').isEnabled(), false);
      assert.equal(await phone.locator('[data-qc=block-reason]').count(), 0);
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 390);
      await phone.screenshot({ path: join(out, 'mobile-light-compose-css.png'), scale: 'css' });
      await stepClick(phone, out, 7, tools.locator('[data-qc=composer-plus]'), 'mobile-plus-click', '添加资料：点左下的加号');
      const plus = phone.locator('[data-qc=plus-menu]');
      await plus.waitFor();
      assert.deepEqual(await plus.getByRole('button').allTextContents(), ['上传稿件或图片', '从知识库选择']);
      await phone.screenshot({ path: join(out, 'mobile-light-plus-css.png'), scale: 'css' });
      await stepShot(phone, out, 8, 'mobile-plus-menu', '添加资料：上传和知识库两项在同一菜单', plus);
      await phone.keyboard.press('Escape');
      await plus.waitFor({ state: 'hidden' });
      await stepClick(phone, out, 9, tools.locator('[data-qc=style-chip]'), 'mobile-style-click', '产出与风格：用组合按钮打开面板');
      const panel = phone.locator('[data-qc=style-popover]');
      await panel.waitFor();
      assert.equal(await panel.getByRole('radio', { name: '网页', exact: true }).getAttribute('aria-checked'), 'true');
      await stepShot(phone, out, 10, 'mobile-output-menu', '风格面板：视频与网页切换位于顶部，当前选中网页', panel);
      await phone.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden' });
      const [response] = await Promise.all([
        phone.waitForResponse(reply => new URL(reply.url()).pathname === '/api/quick-creation/attachments/knowledge'),
        phone.locator('[data-qc=sample-doc]').click(),
      ]);
      const sample = (await response.json()).data;
      assert.equal(createHash('sha256').update(sample.excerpt).digest('hex'), 'ae2105b8889429e1444ebb3922e82b67cd707b63a10747d45824c1145cb5fcf1');
      const generate = tools.getByRole('button', { name: '生成', exact: true });
      await generate.waitFor();
      assert.ok(await generate.isEnabled());
      await stepShot(phone, out, 11, 'mobile-input-ready', '快捷生成：固定稿件就绪后右侧显示「生成」', tools);
      await phone.getByRole('textbox', { name: '发给快速创作', exact: true }).fill('保留原文的三个评审习惯');
      assert.ok(await tools.locator('[data-qc=brief-send]').isEnabled());
      assert.equal(await generate.count(), 0);
      await stepShot(phone, out, 12, 'mobile-input-send', '快捷创作：输入文字后，同一位置切换为发送', tools);
    } finally {
      await ctx.close();
    }
  }
  verdict = 'conditional';
} finally {
  if (!verifyUserRequests && !reviewWebRunId && !process.env.E2E_QC_POLL_ID) writeManifest(out, { target: 'MAP 快速创作 V8 入口及手机输入框', verdict, commit, themeSupport });
  await browser.close();
}
