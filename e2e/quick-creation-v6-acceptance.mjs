import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const origin = new URL(process.env.E2E_BASE_URL);
const commit = process.env.E2E_EXPECTED_COMMIT;
const generation = process.env.E2E_QC_GENERATE === 'true';
assert.equal(origin.origin, 'https://dsn-1400e277-v6-codex-prd-agent.miduo.org');
assert.match(commit, /^[a-f0-9]{40}$/);
assert.ok(process.env.E2E_USER && process.env.E2E_PASSWORD && process.env.RUNNER_TEMP);
if (generation) assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
const directory = join(process.env.RUNNER_TEMP, 'dsn-1400e277-evidence');
await mkdir(directory, { recursive: true });
const receipt = { version: 6, commit, checks: {}, inputs: {}, submissions: [] };
const apiBase = '/api/quick-creation';
const qc = (page, value) => page.locator(`[data-qc="${value}"]`);
const pathIs = (path, method = 'GET') => response =>
  new URL(response.url()).origin === origin.origin && new URL(response.url()).pathname === path && response.request().method() === method;
const wait = async (page, path, method, action) => (await Promise.all([page.waitForResponse(pathIs(path, method)), action()]))[0];
const shot = (page, name) => page.screenshot({ path: join(directory, name + '.png') });
const record = (id, data) => { receipt.checks[id] = data; };

async function payload(response) {
  assert.ok(response.ok(), `HTTP ${response.status()}`);
  const body = await response.json();
  assert.notEqual(body.success, false, 'Application rejected request');
  return body.data ?? body;
}

async function openWorkbench(browser, width, height, theme, mobile = false) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  await context.addInitScript(mode => localStorage.setItem('map-mobile-theme-v2', JSON.stringify({ state: { mode }, version: 0 })), theme);
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  const errors = [];
  page.on('pageerror', () => errors.push('pageerror'));
  page.on('console', message => { if (message.type() === 'error') errors.push('console.error'); });
  await page.goto(origin.href);
  await page.getByRole('button', { name: '登录 / 注册', exact: true }).click();
  await page.locator('input[autocomplete="username"]').first().fill(process.env.E2E_USER);
  await page.locator('input[autocomplete="current-password"]').first().fill(process.env.E2E_PASSWORD);
  const auth = await payload(await wait(page, '/api/v1/auth/login', 'POST', () =>
    page.getByRole('button', { name: '开始身份确认', exact: true }).click()));
  assert.ok(auth.accessToken);
  if (mobile) await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  await page.locator('nav button[title^="百宝箱"]:visible')
    .or(page.getByRole('button', { name: /^(?:AI\s*)?百宝箱$/ }).filter({ visible: true })).first().click();
  const card = page.getByText('快速创作', { exact: true }).filter({ visible: true }).first();
  await card.waitFor();
  const developmentBadge = await card.evaluate(el => {
    let node = el;
    for (let level = 0; node && level < 5; level++, node = node.parentElement) {
      if (/开发中/.test(node.innerText ?? '')) return true;
    }
    return false;
  });
  const catalog = await payload(await wait(page, apiBase + '/templates', 'GET', () => card.click()));
  await page.locator('[data-qc-ready="compose"]').waitFor();
  assert.equal(new URL(page.url()).pathname, '/quick-creation-agent');
  const get = path => page.request.get(new URL(path, origin).href, { headers: { Authorization: `Bearer ${auth.accessToken}`, 'X-Client': 'admin' } });
  return { context, page, catalog, developmentBadge, errors, get };
}

async function examineTheme(page) {
  return page.evaluate(() => {
    const variables = ['--bg-base', '--text-primary', '--text-secondary'];
    const root = document.documentElement;
    const sample = document.createElement('span');
    document.body.appendChild(sample);
    const colors = variables.map(variable => {
      sample.style.color = `var(${variable})`;
      return getComputedStyle(sample).color;
    });
    sample.remove();
    const luminance = color => {
      const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(value => Number(value) / 255) ?? [];
      if (channels.length !== 3 || !color.startsWith('rgb')) return null;
      const [r, g, b] = channels.map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    };
    const [bg, ...text] = colors.map(luminance);
    const ratios = text.map(value => value == null || bg == null ? null : Math.round((Math.max(bg, value) + 0.05) / (Math.min(bg, value) + 0.05) * 100) / 100);
    return { theme: root.dataset.theme ?? null, colors, ratios, width: innerWidth, scrollWidth: root.scrollWidth };
  });
}

const browser = await chromium.launch();
try {
  const desktop = await openWorkbench(browser, 1440, 900, 'dark');
  const { page, catalog } = desktop;
  const version = await payload(await page.request.get(new URL('/api/version', origin).href));
  assert.equal(version.actualCommit, commit);
  receipt.actualCommit = version.actualCommit;
  await shot(page, 'desktop-dark-compose-1440');
  record('A-01', { navigatedFromToolbox: true, mainCount: await page.locator('main:visible').count() });
  record('S-05', { entryFound: true, developmentBadge: desktop.developmentBadge });
  record('S-02', { categories: catalog.categories.length, styles: catalog.items.length,
    completeMetadata: catalog.items.every(style => !!style.posterUrl && !!style.promptRef && !style.guide), attribution: catalog.source.name });
  record('S-01', { composeVisible: await qc(page, 'template-preview').isVisible() && await qc(page, 'style-chip').isVisible(), jsErrorsBeforeSubmit: desktop.errors.length });
  record('A-12', { disabled: !(await qc(page, 'submit').isEnabled()), reasonVisible: await qc(page, 'block-reason').isVisible() });
  const projectTitle = qc(page, 'project-title');
  const titleBefore = await projectTitle.innerText();
  const sample = await payload(await wait(page, apiBase + '/attachments/knowledge', 'POST', () =>
    page.getByRole('button', { name: /用示例稿件试一下/ }).click()));
  await qc(page, 'attachment-tray').waitFor();
  record('A-13', { before: titleBefore, after: await projectTitle.innerText(), sampleName: sample.name, chars: sample.chars });
  receipt.inputs.sampleConfirmed = sample.name === '需求评审的三个习惯.md' && sample.excerpt.includes('习惯三：最后对验收');
  const choice = page.getByRole('radiogroup', { name: '选择产出' });
  await choice.getByRole('radio', { name: '网页', exact: true }).click();
  const kept = await qc(page, 'style-chip').getAttribute('data-template');
  const webDirection = await page.getByText(/生成网页时，按这个风格的配色、字体与版式/).first().isVisible();
  await qc(page, 'style-chip').click();
  const picker = qc(page, 'style-popover');
  await picker.getByRole('textbox').fill('水墨');
  const ink = picker.getByRole('radio', { name: /中国水墨/ });
  await ink.waitFor();
  const matches = await picker.getByRole('radio', { name: /中国水墨/ }).count();
  await shot(page, 'desktop-dark-style-search');
  await ink.click();
  const selected = await qc(page, 'style-chip').getAttribute('data-template');
  const selectedCard = page.getByRole('radiogroup', { name: '选择模板' }).getByRole('radio', { name: /中国水墨/ });
  record('A-39', { keptAfterWeb: kept, webDirection, output: await page.locator('[data-qc-ready="compose"]').getAttribute('data-output') });
  record('A-44', { matchingInk: matches, selected, pickerClosed: !(await picker.isVisible()), rightRadioSelected: await selectedCard.getAttribute('aria-checked') });
  record('A-45', { kept, selected, webStillSelected: await choice.getByRole('radio', { name: '网页', exact: true }).getAttribute('aria-checked') });
  await shot(page, 'desktop-dark-web-style');

  if (generation && receipt.inputs.sampleConfirmed) {
    for (const [kind, label] of [['web', '网页'], ['video', '视频']]) {
      await choice.getByRole('radio', { name: label, exact: true }).click();
      if (kind === 'video') {
        await qc(page, 'style-chip').click();
        await picker.getByRole('textbox').fill('视觉笔记');
        await picker.getByRole('radio', { name: /视觉笔记/ }).first().click();
      }
      const res = await wait(page, apiBase + '/runs', 'POST', () => qc(page, 'submit').click());
      const reply = await res.json().catch(() => null);
      receipt.submissions.push({ kind, http: res.status(), accepted: reply?.success === true, taskId: reply?.data?.id ?? null });
      if (reply?.data?.id) break;
      await page.getByText('没有提交成功', { exact: true }).first().waitFor({ timeout: 5_000 }).catch(() => {});
      await shot(page, `desktop-dark-submit-${kind}`);
    }
  }

  const works = await payload(await desktop.get(apiBase + '/works'));
  const team = await payload(await desktop.get(apiBase + '/assets?scope=team'));
  record('S-03', { array: Array.isArray(works.items), count: works.items?.length });
  record('S-06', { array: Array.isArray(team.items), count: team.items?.length });
  await page.getByRole('button', { name: /^我的作品，共/ }).click();
  const worksView = qc(page, 'works');
  const filter = worksView.getByText(/^进行中\s*\d+$/).first();
  await filter.click();
  record('S-04', { opened: await worksView.isVisible(), activeFilterVisible: await filter.isVisible(), dataCount: works.items?.length });
  await shot(page, 'desktop-dark-works');
  await worksView.getByRole('button', { name: '新建', exact: true }).click();

  const modes = [[1280, 800, 'dark', false], [1280, 800, 'light', false], [375, 812, 'dark', true], [375, 812, 'light', true], [390, 844, 'dark', true]];
  receipt.themes = [];
  for (const [width, height, theme, mobile] of modes) {
    const spot = await openWorkbench(browser, width, height, theme, mobile);
    const view = spot.page;
    if (width === 390) {
      await payload(await wait(view, apiBase + '/attachments/knowledge', 'POST', () =>
        view.getByRole('button', { name: /用示例稿件试一下/ }).click()));
      await qc(view, 'attachment-tray').waitFor();
      record('A-35', { tray: await qc(view, 'attachment-tray').isVisible(),
        styleChip: await qc(view, 'style-chip').isVisible(), submit: await qc(view, 'submit').isVisible() });
    }
    const info = await examineTheme(view);
    if (mobile) {
      info.tinyTargets = await view.locator('[data-qc-ready="compose"] button:visible').evaluateAll(buttons => buttons
        .filter(button => !button.closest('[data-qc-touch-exempt]') && button.getBoundingClientRect().height < 44)
        .map(button => ({ label: button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent.trim(), height: Math.round(button.getBoundingClientRect().height) })));
      info.tabs = await view.getByRole('tablist', { name: '对话与预览' }).isVisible();
    }
    receipt.themes.push(info);
    await shot(view, `${mobile ? 'phone' : 'desktop'}-${theme}-${width}`);
    if (mobile) {
      const tabs = view.getByRole('tablist', { name: '对话与预览' });
      await tabs.getByRole('tab', { name: '预览', exact: true }).click();
      info.previewToggled = await qc(view, 'template-preview').isVisible();
    }
    await spot.context.close();
  }

  // Real synthetic uploads exercise the accepted types and error handling independently of the fixed sample.
  const files = [
    { name: '评审要点.md', mimeType: 'text/markdown', buffer: Buffer.from('# 评审要点\n\n先明确本次评审的目标。') },
    ...Array.from({ length: 4 }, (_, i) => ({ name: `验收稿件-${i + 1}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`第 ${i + 1} 份验收测试文本。`) })),
    { name: '验收图片.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF6sAAAAASUVORK5CYII=', 'base64') },
  ];
  let releaseUpload;
  const holdUpload = new Promise(resolve => { releaseUpload = resolve; });
  await page.route(new URL(apiBase + '/attachments', origin).href, async route => { await holdUpload; await route.continue(); }, { times: 1 });
  await qc(page, 'file-input').setInputFiles(files);
  try {
    await qc(page, 'block-reason').filter({ hasText: /还有附件在读取/ }).waitFor();
    record('A-17', { disabledWhileReading: !(await qc(page, 'submit').isEnabled()), readingLabel: await qc(page, 'block-reason').innerText() });
  } finally { releaseUpload(); }
  const tray = qc(page, 'attachment-tray').and(page.locator('[data-count="6"]'));
  await tray.waitFor();
  const tile = (await tray.locator('button[aria-label^="移除"]').count());
  const trayHeight = (await tray.boundingBox())?.height ?? null;
  record('A-14', { sixAttachments: true, trayHeight, tiles: tile, hasHiddenFour: await tray.getByRole('button', { name: '查看另外 4 份资料' }).isVisible() });
  await shot(page, 'desktop-dark-six-attachments');
  const empty = { name: '空白验收稿件.md', mimeType: 'text/markdown', buffer: Buffer.from('') };
  await qc(page, 'file-input').setInputFiles(empty);
  await qc(page, 'attachment-tray').and(page.locator('[data-failed-count="1"]')).waitFor();
  await qc(page, 'tray-toggle').click();
  const list = qc(page, 'attachment-list');
  const failed = list.locator('section[aria-label="读取失败"]');
  await failed.waitFor();
  record('A-15', { firstGroup: await list.locator('section').first().getAttribute('aria-label'),
    excluded: (await failed.innerText()).includes('不会用于生成'), retry: await qc(page, 'att-retry').isVisible(), remove: await failed.getByRole('button', { name: /移除/ }).isVisible() });
  record('A-16', { groups: await list.locator('section').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label'))),
    overflowY: await list.evaluate(node => getComputedStyle(node).overflowY), budget: await qc(page, 'budget').innerText() });
  record('A-42', { text: await list.getByText('评审要点.md', { exact: true }).isVisible(),
    image: await list.getByText('验收图片.png', { exact: true }).isVisible(), emptyMarked: (await failed.innerText()).includes('空白验收稿件.md'), readyAfterReading: await qc(page, 'submit').isEnabled() });
  await shot(page, 'desktop-dark-attachment-errors');
  const failedId = await failed.locator('[data-att-id]').first().getAttribute('data-att-id');
  const retry = await wait(page, `${apiBase}/attachments/${encodeURIComponent(failedId)}/read`, 'POST', () => qc(page, 'att-retry').click());
  await failed.getByRole('button', { name: /移除/ }).click();
  await failed.waitFor({ state: 'hidden' });
  record('A-15', { ...receipt.checks['A-15'], retryHttp: retry.status(), removed: true });
  const unsupported = await wait(page, apiBase + '/attachments', 'POST', () => qc(page, 'file-input')
    .setInputFiles({ name: '不支持的验收稿件.pdf', mimeType: 'application/pdf', buffer: Buffer.from('QA attachment') }));
  const rejection = await unsupported.json().catch(() => null);
  record('A-42', { ...receipt.checks['A-42'], unsupportedHttp: unsupported.status(), supportedTypesExplained: /Markdown.*TXT.*PNG/.test(rejection?.error?.message ?? '') });
  await desktop.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: origin.origin });
  const longText = '这是一段用于验收粘贴正文功能的合成稿件。'.repeat(20);
  await page.evaluate(text => navigator.clipboard.writeText(text), longText);
  const ask = page.locator('#qc-ask');
  const pasted = await payload(await wait(page, apiBase + '/attachments/text', 'POST', () => ask.press('Control+V')));
  await qc(page, 'attachment-tray').and(page.locator('[data-count="7"]')).waitFor();
  record('A-41', { chars: pasted.chars, name: pasted.name, ask: await ask.inputValue(), enabled: await qc(page, 'submit').isEnabled() });
  await desktop.context.close();


} catch (error) {
  receipt.executionError = String(error.message).split('\n')[0];
  throw error;
} finally {
  await writeFile(join(directory, 'result.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
}

assert.ok(receipt.submissions.every(item => item.accepted), 'One or more real creation submissions failed; see evidence');
