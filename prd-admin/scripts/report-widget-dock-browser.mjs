// 先启动本目录Vite；REPORT_WIDGET_SCRIPT须指向本次抓取的真实父实例旧widget IIFE。
// 本地固定业务响应仅用于组件行为回归，不作为远程验收证据。
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || '../../cds/node_modules/playwright');
assert(process.env.REPORT_WIDGET_SCRIPT, '请通过REPORT_WIDGET_SCRIPT指定真实父实例widget脚本');
const widgetScript = await fs.readFile(process.env.REPORT_WIDGET_SCRIPT, 'utf8');
const branch = /var BRANCH_ID='([^']+)'/.exec(widgetScript)?.[1];assert(branch);
const base = (process.env.REPORT_TEST_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const out = process.env.REPORT_SCREENSHOT_DIR || path.join(os.tmpdir(), 'admin-report-widget-dock');await fs.mkdir(out, { recursive: true });
const entry = base + '/scripts/fixtures/report-widget-hosts.html', results = [];
const marker = 'WIDGET-DOCK-READING-END';
const content = '# 日报周报月度总结固定长标题：所有内容均应完整阅读\n\n[完整诊断证据](https://example.com/reports/widget-reading)\n\n![报告图片](https://example.com/report-widget-evidence.svg)\n\n| 对象 | 环境 | 请求数 | 成功率 | 延迟 | 诊断 | 恢复 | 末列 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| CDS | 固定 | 120 | 99% | 900ms | 完整 | 重试 | LAST-CDS |\n| LLMGW | 固定 | 240 | 98% | 1200ms | 完整 | 返回 | LAST-LLMGW |\n\n' + Array.from({ length: 24 }, (_, i) => `## 正文${i + 1}\n\n报告关键内容和阅读终点均不能被浮动预览工具遮挡。`).join('\n\n') + '\n\n## 完整阅读终点\n\n' + marker;
const team = { id: 'widget-team', name: '预览停靠固定团队', leaderUserId: 'author', myRole: 'leader' };
const weekly = { id: 'widget-weekly', userId: 'author', userName: '固定作者', teamId: team.id, teamName: team.name, templateId: 'fixed', weekYear: 2026, weekNumber: 46, periodStart: '2026-11-09', periodEnd: '2026-11-15', status: 'submitted', sections: [{ templateSection: { title: '完整正文', inputType: 'rich-text', isRequired: true, sortOrder: 0 }, items: [{ content, source: 'manual' }] }] };
const monthly = { id: 'widget-monthly', userId: 'author', userName: '固定作者', teamId: team.id, teamName: team.name, year: 2026, month: 11, status: 'submitted', weeklyLinks: [], achievementsText: content, problemsText: '诊断与恢复说明保留。', partners: [], suggestionsText: '阅读后可以返回。' };
const daily = { id: 'widget-daily', date: new Date().toISOString().slice(0, 10), items: [{ content, category: 'testing', tags: [] }] };
const overlap = (a, b) => a && b && Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
async function mocks(context) {
  await context.route('https://example.com/report-widget-evidence.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="640" height="240" fill="#173f5f"/><text x="24" y="100" font-size="24" fill="white">Report image preview</text></svg>' }));
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url()), p = url.pathname;let data = { items: [], total: 0 };
    if (p.includes('/_cds/api/')) data = p.endsWith('/branches') ? { tabTitleEnabled: false, branches: [{ id: branch, status: 'running', runningCommitSha: 'a'.repeat(40), tags: [] }] } : { profiles: [] };
    else if (p.endsWith('/my/default-tab')) data = { tab: 'team' };
    else if (p.endsWith('/my/daily-log-tags')) data = { items: [], tagOrder: [], defaultTags: [] };
    else if (p.endsWith('/teams/widget-team/reports/view')) data = { team, weekYear: 2026, weekNumber: 46, periodStart: weekly.periodStart, periodEnd: weekly.periodEnd, stats: { totalMembers: 1, submittedCount: 1, pendingCount: 0 }, items: [{ reportId: weekly.id, userId: 'author', userName: '固定作者', status: 'submitted' }], members: [{ userId: 'author', userName: '固定作者', role: 'leader', reportId: weekly.id, reportStatus: 'submitted' }], canGenerateSummary: false, canManageMembers: false, canViewAllMembers: true };
    else if (p.endsWith('/reports/widget-weekly')) data = { report: weekly };
    else if (p.endsWith('/monthly-reports/widget-monthly')) data = { report: monthly, linkedWeeklies: [], canEdit: false, submitIssues: null, chapterTitles: ['本月工作成果', '问题与对策', '本月印象最深刻的三个伙伴', '对上级/团队/公司的建议'] };
    else if (p.endsWith('/monthly-reports')) data = { items: [monthly] };
    else if (p.endsWith('/daily-logs')) data = { items: [daily], total: 1 };
    else if (p.includes('/daily-logs/')) data = daily;
    else if (p.endsWith('/shares/view/widget-share')) data = { team, weekYear: 2026, weekNumber: 46, periodStart: weekly.periodStart, periodEnd: weekly.periodEnd, stats: { totalMembers: 1, submittedCount: 1, pendingCount: 0 }, items: [{ ...weekly, reportId: weekly.id }], summary: null, shareInfo: { createdBy: 'author', createdByName: '固定作者', createdAt: '2026-11-13', isTeamMember: true } };
    else if (p.endsWith('/views-summary')) data = { count: 0, totalViewCount: 0, users: [] };
    else if (p.endsWith('/likes')) data = { likedByMe: false, count: 0, users: [] };
    await route.fulfill({ json: p.includes('/_cds/api/') ? data : { success: true, data, error: null } });
  });
}
async function enter(page, host, width) {
  const names = { weekly: '团队周报', daily: '日常记录', monthly: '月报', standalone: '独立周报', share: '团队分享' };
  await page.getByRole('link', { name: `打开${names[host]}宿主`, exact: true }).click();
  if (['weekly', 'daily', 'monthly'].includes(host)) {
    await page.getByText('团队周报列表', { exact: true }).waitFor();
    if (host === 'weekly') { if (width === 390) await page.getByRole('button', { name: '周列表', exact: true }).click();await page.getByRole('button', { name: /固定作者.*负责人/ }).click(); }
    if (host === 'daily') { await page.locator('.surface-nav-button').filter({ hasText: /^日常记录$/ }).click();await page.locator('.surface-nav-button').filter({ hasText: /^我的记录$/ }).click(); }
    if (host === 'monthly') { await page.locator('.surface-nav-button').filter({ hasText: /^月报$/ }).click();await page.getByTestId('monthly-report-card').click(); }
  }
  await page.getByText(marker, { exact: true }).waitFor({ state: 'attached' });
}
async function leave(page, host) {
  if (host === 'share') await page.getByRole('button', { name: '返回上一页', exact: true }).click();
  else if (host === 'monthly') await page.getByRole('button', { name: '返回', exact: true }).click();
  else if (host === 'weekly' || host === 'standalone') await page.getByText('固定作者 的周报', { exact: true }).locator('xpath=../../button').click();
  if (!await page.getByRole('heading', { name: '报告宿主停靠回归固定入口', exact: true }).isVisible()) await page.getByRole('link', { name: '退出报告宿主', exact: true }).click();
  await page.getByRole('heading', { name: '报告宿主停靠回归固定入口', exact: true }).waitFor();
}
async function imageModal(page, width, label) {
  const image = page.getByTitle('点击查看完整图片', { exact: true }).filter({ has: page.getByRole('img', { name: '报告图片', exact: true }) });
  await image.getByRole('img').evaluate(el => el.decode());if (width === 390) await image.tap();else await image.click();
  const overlay = page.locator('body > div.fixed').filter({ has: page.locator('img[alt="周报图片"]') });await overlay.waitFor();
  const close = overlay.locator(':scope > button').first();
  const hit = await close.evaluate(el => { const r = el.getBoundingClientRect(), point = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);return { box: r.toJSON(), clear: !!point && (point === el || el.contains(point)), hit: point?.tagName }; });
  await page.screenshot({ path: path.join(out, label + '-image-modal.png') });assert(hit.clear, '图片弹窗关闭按钮不可被widget拦截：' + JSON.stringify(hit));
  if (width === 390) await close.tap();else await close.click();await overlay.waitFor({ state: 'detached' });
  return { closeHit: hit, touch: width === 390, closed: true };
}
async function linkContrast(page) {
  const links = await page.locator('.surface-inset a').evaluateAll(nodes => {
    const canvas = document.createElement('canvas');canvas.width = canvas.height = 1;const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = color => { ctx.clearRect(0, 0, 1, 1);ctx.fillStyle = color;ctx.fillRect(0, 0, 1, 1);return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const compose = (front, back) => front.slice(0, 3).map((n, i) => n * front[3] / 255 + back[i] * (1 - front[3] / 255));
    const luminance = values => values.slice(0, 3).map(n => { const v = n / 255;return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
    return nodes.map(node => {
      const parents = [];for (let p = node; p; p = p.parentElement) parents.push(p);
      let background = [255, 255, 255];for (const parent of parents.reverse()) background = compose(rgba(getComputedStyle(parent).backgroundColor), background);
      const color = getComputedStyle(node).color, foreground = compose(rgba(color), background), a = luminance(foreground), b = luminance(background);
      return { text: node.textContent, color, background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
  });
  assert(links.length > 0);assert(links.every(link => link.ratio >= 4.5), '报告链接对实际合成背景必须达到4.5：' + JSON.stringify(links));return links;
}
const widths = process.env.REPORT_WIDTH ? [Number(process.env.REPORT_WIDTH)] : [390, 1440];
const widgets = process.env.REPORT_WITH_WIDGET ? [process.env.REPORT_WITH_WIDGET === '1'] : [false, true];
const hosts = process.env.REPORT_HOST ? [process.env.REPORT_HOST] : ['weekly', 'daily', 'monthly', 'standalone', 'share'];
const themes = process.env.REPORT_THEME ? [process.env.REPORT_THEME] : ['light', 'dark'];
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
try { for (const width of widths) for (const withWidget of widgets) for (const host of hosts) for (const theme of themes) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });await mocks(context);
  if (withWidget) await context.addInitScript({ content: `if(window===window.top){window.EventSource=class extends EventTarget{close(){}};addEventListener('DOMContentLoaded',()=>{${widgetScript}\n},{once:true});}` });
  const page = await context.newPage(), errors = [];page.on('pageerror', e => errors.push(e.message));page.setDefaultTimeout(15000);
  const label = `${host}-${width}-${withWidget ? 'widget' : 'plain'}-${theme}`;
  try {
    await page.goto(entry);await page.getByRole('radiogroup', { name: '主题', exact: true }).getByRole('radio', { name: theme === 'light' ? '白天' : '黑夜', exact: true }).click();
    await enter(page, host, width);
    const slots = page.locator('[data-report-widget-slot]');
    if (withWidget) { await page.locator('[data-report-widget-slot]>#cds-widget').waitFor();assert.equal(await page.locator('#cds-widget').count(), 1); }
    else assert((await slots.evaluateAll(nodes => nodes.map(n => getComputedStyle(n).display))).every(x => x === 'none'));
    const modal = await imageModal(page, width, label), links = await linkContrast(page);
    const terminal = page.getByText(marker, { exact: true });await terminal.scrollIntoViewIfNeeded();
    const end = await terminal.evaluate(el => { const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);return { box: r.toJSON(), clear: !!hit && (el === hit || el.contains(hit)) }; });assert(end.clear);
    let docked, expanded;
    if (withWidget) {
      const widget = page.locator('#cds-widget');docked = await widget.boundingBox();assert(!overlap(docked, end.box));
      const body = await page.locator('.surface-inset').filter({ has: page.getByRole('heading', { name: /^日报周报月度总结固定长标题/ }) }).last().evaluate(el => { const r = el.getBoundingClientRect();let left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p), b = p.getBoundingClientRect();if (/auto|scroll|hidden|clip/.test(s.overflowY)) { top = Math.max(top, b.top);bottom = Math.min(bottom, b.bottom); }if (/auto|scroll|hidden|clip/.test(s.overflowX)) { left = Math.max(left, b.left);right = Math.min(right, b.right); } }return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }; });assert(!overlap(docked, body), '停靠widget不能覆盖可见报告正文的任何区域');
      const ancestors = await widget.evaluate(el => { const bad = [];for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p);if (s.transform !== 'none' || s.filter !== 'none' || s.backdropFilter !== 'none') bad.push({ tag: p.tagName, transform: s.transform, filter: s.filter, backdrop: s.backdropFilter }); }return bad; });assert.deepEqual(ancestors, []);
      assert.equal(await widget.evaluate(el => getComputedStyle(el).position), 'relative');
      await widget.scrollIntoViewIfNeeded();const compact = widget.locator('[data-action="expand-compact"]');if (await compact.count()) await compact.click();
      if (!await widget.locator('.cds-panel').count()) await widget.locator('[data-action="toggle"]').click();await widget.locator('.cds-panel').waitFor();
      assert.equal(await widget.evaluate(el => getComputedStyle(el).position), 'fixed');expanded = await widget.boundingBox();assert(expanded.x >= 0 && expanded.y >= 0 && expanded.x + expanded.width <= width && expanded.y + expanded.height <= 844, '展开面板必须完整位于视口');
      const close = widget.locator('[data-action="close-panel"]'), closeBox = await close.boundingBox();assert(closeBox.x >= 0 && closeBox.y >= 0 && closeBox.x + closeBox.width <= width && closeBox.y + closeBox.height <= 844);if (width === 390) assert(closeBox.width >= 44 && closeBox.height >= 44);
      await page.screenshot({ path: path.join(out, label + '-expanded.png') });await close.click();await page.waitForFunction(() => getComputedStyle(document.querySelector('#cds-widget')).position === 'relative');
    }
    await terminal.scrollIntoViewIfNeeded();await page.screenshot({ path: path.join(out, label + '-end.png') });
    await leave(page, host);
    if (withWidget) {
      assert(await page.locator('#cds-widget').evaluate(el => el.parentElement === document.body && getComputedStyle(el).position === 'fixed'));
      await enter(page, host, width);const compact = page.locator('#cds-widget [data-action="expand-compact"]');if (await compact.count()) await compact.click();if (!await page.locator('#cds-widget .cds-panel').count()) await page.locator('#cds-widget [data-action="toggle"]').click();await page.locator('#cds-widget [data-action="dismiss"]').click();
      await leave(page, host);assert.equal(await page.locator('#cds-widget').count(), 0, '主动关闭的widget不得由宿主cleanup复活');
    }
    assert.deepEqual(errors, []);results.push({ host, width, withWidget, theme, pass: true, modal, links, end, docked, expanded, returned: true, emptySlotNoSpace: !withWidget, widgetScriptSha256: createHash('sha256').update(widgetScript).digest('hex') });
  } catch (error) { await page.screenshot({ path: path.join(out, label + '-failure.png') });throw error; } finally { await context.close(); }
} } finally { await browser.close(); }
await fs.writeFile(path.join(out, 'browser-results.json'), JSON.stringify({ mode: 'local-real-report-hosts-fixed-api-old-parent-widget', results }, null, 2));console.log(JSON.stringify({ pass: true, cases: results.length }));
