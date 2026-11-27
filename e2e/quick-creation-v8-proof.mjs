import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { launch, loadConfig, createMobileContext, stepClick, stepShot, writeManifest, detectThemeSupport } from
  '../.claude/skills/create-visual-test-to-kb/scripts/harness.mjs';

const origin = new URL(process.env.E2E_BASE_URL);
const commit = process.env.E2E_EXPECTED_COMMIT;
assert.equal(origin.origin, 'https://dsn-1400e277-v6-codex-prd-agent.miduo.org');
assert.match(commit, /^[a-f0-9]{40}$/);
const config = loadConfig(new URL('../.claude/skills/create-visual-test-to-kb/acceptance.config.json', import.meta.url));
const out = join(process.env.RUNNER_TEMP, 'dsn-1400e277-evidence');
const environment = { kind: 'cds', branch: 'codex/dsn-1400e277-v6', commit, baseUrl: origin.origin };

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

const { browser, page } = await launch(config, { environment });
let themeSupport;
let verdict = 'fail';
try {
  const version = await page.request.get(new URL('/api/version', origin).href);
  assert.equal((await version.json()).actualCommit, commit);
  await enter(page, false);
  themeSupport = await detectThemeSupport(page, config);
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
    await stepClick(phone, out, 7, tools.locator('[data-qc=composer-plus]'), 'mobile-plus-click', '添加资料：点左下的加号');
    const plus = phone.locator('[data-qc=plus-menu]');
    await plus.waitFor();
    assert.deepEqual(await plus.getByRole('button').allTextContents(), ['上传稿件或图片', '从知识库选择']);
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
  verdict = 'conditional';
} finally {
  writeManifest(out, { target: 'MAP 快速创作 V8 入口及手机输入框', verdict, commit, themeSupport });
  await browser.close();
}
