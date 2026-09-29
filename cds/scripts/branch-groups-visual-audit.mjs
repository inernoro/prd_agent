#!/usr/bin/env node
/*
 * 分支自定义分组的视觉取证（离线，2026-09-29）：自起 vite dev、把 /api/* 换成合成数据，
 * 用真浏览器走一遍用户会走的路——第一次切到「按分组」→ 按前缀建组 → 拖卡片钉入 →
 * 用卡片菜单移组 → 拖回未归组取消钉入 → 收起分组 → 编辑规则看实时命中 → 拖组头调顺序 →
 * 别人刚改过时保存冲突 → 定位收起分组里已停止的卡。每一步断言页面真的变了，并截图。
 *
 * 分组接口用内存里的一份数据应答（GET / PUT），可按需让下一次 PUT 返回 409 与「别人刚存的」
 * 最新版本，驱动的是页面里真实的保存与冲突处理代码。
 *
 * 用法：node scripts/branch-groups-visual-audit.mjs [--out <dir>] [--width 1920]
 * 截图写进 --out（默认 /tmp/branch-groups-audit），不进仓库。任一判据不满足退出码非 0。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { startViteDevServer } from './lib/vite-dev-server.mjs';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || 'playwright');

const argValue = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const OUT = argValue('--out', '/tmp/branch-groups-audit');
const WIDTH = Number(argValue('--width', '1920'));
fs.mkdirSync(OUT, { recursive: true });

const PROJECT_ID = 'fixture-project';
const PROFILES = ['api', 'admin', 'web'];
const MIN = 60_000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

function services(basePort, status, overrides = {}) {
  const out = {};
  PROFILES.forEach((id, i) => {
    out[id] = { profileId: id, containerName: `fixture-${id}-${basePort}`, hostPort: basePort + i * 17, status, ...(overrides[id] || {}) };
  });
  return out;
}

function makeBranches() {
  const base = (id, name, extra) => ({
    id,
    projectId: PROJECT_ID,
    branch: name,
    createdAt: iso(-3 * 24 * 60 * MIN),
    commitSha: `${id.replace(/[^0-9a-f]/g, '').padEnd(7, 'a').slice(0, 7)}${'0'.repeat(33)}`,
    subject: '合成提交：分支分组视觉取证',
    tags: [],
    ...extra,
  });
  const running = (port) => ({ status: 'running', services: services(port, 'running'), lastAccessedAt: iso(-5 * MIN), lastDeployAt: iso(-40 * MIN) });
  const stopped = (port) => ({ status: 'idle', services: services(port, 'stopped'), lastStopSource: 'scheduler', lastStoppedAt: iso(-15 * 60 * MIN), lastDeployAt: iso(-16 * 60 * MIN) });
  return [
    base('b-main', 'main', running(22000)),
    base('b-test', 'test', running(22100)),
    base('b-rel', 'release/2026.09', { ...running(22200) }),
    base('b-edison', 'claude/beautiful-edison-mx81', { ...running(22300), tags: ['登录重构'] }),
    base('b-scan', 'claude/scan-risk-admin', {
      status: 'error',
      services: services(22400, 'running', { api: { status: 'error', errorMessage: '就绪探测超时（120 秒内 /health 未返回 200）' } }),
      errorMessage: 'api: 就绪探测超时（120 秒内 /health 未返回 200）',
      lastAccessedAt: iso(-19 * MIN),
    }),
    base('b-dirac', 'claude/laughing-dirac-t4e4ug', running(22500)),
    base('b-old1', 'claude/old-experiment-1', stopped(22600)),
    base('b-old2', 'claude/old-experiment-2', stopped(22700)),
    base('b-pack', 'codex/packaging-supplier-flow', running(22800)),
    base('b-ident', 'codex/identity-menu-clarify', { ...running(22900), tags: ['登录重构'] }),
    base('b-feat', 'feat/solo-branch', stopped(23000)),
  ];
}

let branches = makeBranches();
let groupStore = { groups: [], updatedAt: null, updatedBy: null };
let conflictNext = null;
const puts = [];
const profiles = PROFILES.map((id) => ({ id, name: id, containerPort: 8080, dockerImage: `fixture/${id}:latest` }));

function resolve(pathname) {
  if (pathname === '/api/branches') return { branches, capacity: { maxContainers: 200, runningContainers: 30, totalMemGB: 96 } };
  if (pathname === '/api/infra') return { services: [] };
  if (pathname === '/api/build-profiles') return { profiles };
  if (pathname === `/api/projects/${PROJECT_ID}`) {
    return { id: PROJECT_ID, slug: PROJECT_ID, name: '取证项目', cloneStatus: 'ready', branchCount: branches.length };
  }
  return resolveFixture(pathname);
}

const FAKE_SSE = `
(() => {
  const Real = window.EventSource;
  class FakeEventSource {
    constructor(url) {
      this.url = String(url); this.listeners = {}; this.readyState = 1;
      if (!this.url.includes('/api/branches/stream')) return new Real(url);
      setTimeout(() => this.onopen && this.onopen({}), 0);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
    close() { this.readyState = 2; }
  }
  window.EventSource = FakeEventSource;
})();
`;

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`); };

async function openPage(browser, url, theme) {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: 1180 }, deviceScaleFactor: 1 });
  await context.addInitScript(`try{localStorage.setItem('cds_theme','${theme}')}catch(e){}`);
  await context.addInitScript(FAKE_SSE);
  await context.route('**/api/**', async (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    if (isEventStream(pathname)) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/branch-groups`) {
      if (req.method() === 'PUT') {
        const body = JSON.parse(req.postData() || '{}');
        puts.push(body);
        if (conflictNext) {
          groupStore = conflictNext;
          conflictNext = null;
          await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'stale', message: '分组刚被别人改过', latest: groupStore }) });
          return;
        }
        groupStore = { groups: body.groups, updatedAt: new Date().toISOString(), updatedBy: 'user' };
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ...groupStore }) });
      return;
    }
    const body = resolve(pathname);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body ?? {}) });
  });
  const page = await context.newPage();
  await page.goto(`${url}/branch-list?project=${PROJECT_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-branch-card-id="b-main"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  return { context, page };
}

/** 哪个区块里有这张卡（按分组视图）。 */
async function sectionOf(page, branchId) {
  return page.evaluate((id) => document.querySelector(`[data-branch-card-id="${id}"]`)?.closest('[data-branch-group]')?.getAttribute('data-branch-group') ?? null, branchId);
}

async function sectionOrder(page) {
  return page.$$eval('[data-branch-group]', (els) => els.map((el) => el.getAttribute('data-branch-group')));
}

/** 用原生拖拽事件把 fromSelector 拖到 toSelector；hold=true 时停在悬停态不松手（取证提示用）。 */
async function dragTo(page, fromSelector, toSelector, { hold = false } = {}) {
  await page.evaluate(({ from, to, hold: keep }) => {
    const src = document.querySelector(from);
    const dst = document.querySelector(to);
    if (!src || !dst) throw new Error(`drag target missing: ${from} -> ${to}`);
    const dataTransfer = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    dst.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    window.__pendingDrag = { dataTransfer, dst, src };
    if (!keep) {
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
    }
  }, { from: fromSelector, to: toSelector, hold });
  await page.waitForTimeout(400);
}

async function releaseDrag(page) {
  await page.evaluate(() => {
    const pending = window.__pendingDrag;
    if (!pending) return;
    pending.dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: pending.dataTransfer }));
    pending.src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: pending.dataTransfer }));
    window.__pendingDrag = null;
  });
  await page.waitForTimeout(400);
}

async function main() {
  const server = await startViteDevServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' });
    for (const theme of ['dark', 'light']) {
      branches = makeBranches();
      groupStore = { groups: [], updatedAt: null, updatedBy: null };
      puts.length = 0;
      const { context, page } = await openPage(browser, server.url, theme);

      // 1. 第一次切到「按分组」：给按前缀建组的建议，一个分支的前缀默认不勾
      await page.click('[data-branch-view-toggle="groups"]');
      await page.waitForSelector('[data-branch-group-suggestions]', { timeout: 10000 });
      const suggestionRows = await page.$$eval('[data-branch-group-suggestions] input[type="checkbox"]', (els) => els.map((el) => ({
        prefix: el.closest('label')?.querySelector('.font-mono')?.textContent?.trim(),
        checked: el.checked,
      })));
      const checkedOf = (prefix) => suggestionRows.find((row) => row.prefix === prefix)?.checked;
      check(checkedOf('claude/') === true && checkedOf('codex/') === true, `[${theme}] 建议里 claude/、codex/ 默认勾上（${JSON.stringify(suggestionRows)}）`);
      check(checkedOf('release/') === false && checkedOf('feat/') === false, `[${theme}] 只有 1 个分支的前缀默认不勾`);
      await page.screenshot({ path: path.join(OUT, `1-suggestions-${theme}.png`), fullPage: true });

      // 2. 一键建组
      await page.getByRole('button', { name: /^创建 2 个分组$/ }).click();
      await page.waitForSelector('[data-branch-group="__ungrouped__"]', { timeout: 10000 });
      await page.waitForTimeout(500);
      const claudeId = groupStore.groups.find((g) => g.name === 'Claude 在做')?.id;
      const codexId = groupStore.groups.find((g) => g.name === 'Codex 在做')?.id;
      check(Boolean(claudeId && codexId) && puts.length === 1, `[${theme}] 建组写进了项目共享的分组（PUT ${puts.length} 次，${groupStore.groups.map((g) => g.name).join(' / ')}）`);
      check(await sectionOf(page, 'b-scan') === claudeId && await sectionOf(page, 'b-pack') === codexId && await sectionOf(page, 'b-main') === '__ungrouped__',
        `[${theme}] 分支按前缀进了对应分组，main 落在未归组`);
      const claudeHeader = await page.textContent(`[data-branch-group="${claudeId}"] [data-branch-group-header]`);
      check(/1 个出错需要处理/.test(claudeHeader || ''), `[${theme}] 组头汇总与页头同口径（「${(claudeHeader || '').replace(/\s+/g, ' ').trim()}」）`);
      const dormantToggle = await page.textContent(`[data-branch-group-dormant-toggle="${claudeId}"]`);
      check(/另有 2 个已停止/.test(dormantToggle || '') && !(await page.$('[data-branch-card-id="b-old1"]')),
        `[${theme}] 组内已停止的收成一行（「${(dormantToggle || '').trim()}」），卡片不占位`);
      const heights = await page.$$eval(`[data-branch-group="${claudeId}"] [data-branch-card-id]`, (els) => els.map((el) => Math.round(el.getBoundingClientRect().height * 10) / 10));
      check(heights.length >= 3 && Math.max(...heights) - Math.min(...heights) <= 1, `[${theme}] 分组里的卡片仍等高（${heights.join(' / ')}）`);
      await page.screenshot({ path: path.join(OUT, `2-grouped-${theme}.png`), fullPage: true });

      // 窄屏：组头折行、规则片收起，页面不许横向溢出
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(overflow <= 1, `[${theme}] 390px 窄屏下分组视图没有横向溢出（多出 ${overflow}px）`);
      await page.screenshot({ path: path.join(OUT, `2-grouped-390-${theme}.png`), fullPage: false });
      await page.setViewportSize({ width: WIDTH, height: 1180 });
      await page.waitForTimeout(300);

      if (theme === 'dark') {
        // 3. 拖卡片进组：悬停时组头给提示，松手即钉入（优先于规则），名字旁出现图钉
        await dragTo(page, '[data-branch-card-id="b-main"]', `[data-branch-group="${claudeId}"]`, { hold: true });
        const hint = await page.textContent(`[data-branch-group="${claudeId}"] [data-branch-group-drop-hint]`).catch(() => null);
        check(/松手放入「Claude 在做」/.test(hint || ''), `拖动悬停时组头给出落点提示（「${(hint || '').trim()}」）`);
        await page.screenshot({ path: path.join(OUT, '3-drag-hover-dark.png'), fullPage: true });
        await releaseDrag(page);
        check(await sectionOf(page, 'b-main') === claudeId, '松手后 main 进了「Claude 在做」');
        check(groupStore.groups.find((g) => g.id === claudeId)?.pinnedBranchIds.includes('b-main'), '钉入写进了共享的分组数据');
        check(Boolean(await page.$('[data-branch-card-id="b-main"] [data-branch-pinned-group="Claude 在做"]')), '钉入的卡片名字旁出现图钉');

        // 4. 卡片菜单「移到分组」：拖拽的键盘 / 触屏等价入口
        await page.click('[data-branch-card-id="b-test"] button[aria-label="更多操作"]');
        await page.getByRole('menuitem', { name: /Codex 在做/ }).click();
        await page.waitForTimeout(500);
        check(await sectionOf(page, 'b-test') === codexId, '卡片菜单「移到分组」把 test 移进了「Codex 在做」');

        // 5. 拖回未归组 = 取消钉入，回到按规则归组
        await dragTo(page, '[data-branch-card-id="b-main"]', '[data-branch-group="__ungrouped__"]');
        check(await sectionOf(page, 'b-main') === '__ungrouped__' && !(await page.$('[data-branch-card-id="b-main"] [data-branch-pinned-group]')),
          '拖回未归组取消钉入，图钉消失');

        // 6. 收起分组：卡片不渲染，组头汇总照样在
        await page.click(`[data-branch-group="${claudeId}"] button[aria-label="收起Claude 在做"]`);
        await page.waitForTimeout(300);
        const collapsedHeader = await page.textContent(`[data-branch-group="${claudeId}"] [data-branch-group-header]`);
        check(!(await page.$('[data-branch-card-id="b-scan"]')) && /1 个出错需要处理/.test(collapsedHeader || ''),
          '收起后卡片不占位，组头仍显示「1 个出错需要处理」');

        // 7. 编辑规则：命中预览实时刷新；被上方分组占用的单独列出
        await page.click(`[data-branch-group="${codexId}"] button[aria-label="编辑分组Codex 在做"]`);
        await page.waitForSelector('[data-branch-group-preview]', { timeout: 5000 });
        const before = await page.textContent('[data-branch-group-preview]');
        await page.getByRole('button', { name: '添加规则' }).click();
        const valueInputs = page.getByRole('textbox', { name: '规则值' });
        await valueInputs.last().fill('claude/');
        await page.waitForTimeout(200);
        const after = await page.textContent('[data-branch-group-preview]');
        check(/现在命中 3 个分支/.test(before || '') && /已归了别的分组/.test(after || ''),
          `编辑规则时命中预览实时刷新，被上方分组先认领的单独列出（前「${(before || '').slice(0, 14)}」）`);
        await page.screenshot({ path: path.join(OUT, '4-editor-dark.png') });
        await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
        await page.waitForTimeout(300);

        // 8. 拖组头把手调顺序：Codex 挪到 Claude 前面
        await dragTo(page, `[data-branch-group="${codexId}"] [data-branch-group-header] [draggable="true"]`, `[data-branch-group="${claudeId}"]`);
        const order = await sectionOrder(page);
        check(order.indexOf(codexId) < order.indexOf(claudeId) && groupStore.groups[0]?.id === codexId,
          `拖组头把手调整分组顺序（${order.join(' → ')}）`);

        // 9. 别人刚改过：保存得到 409，载入最新版本并说清楚
        conflictNext = {
          groups: [...groupStore.groups, { id: 'g-other', name: '别人新建的组', color: 'purple', rules: [{ kind: 'prefix', value: 'feat/' }], pinnedBranchIds: [] }],
          updatedAt: new Date(Date.now() + 1000).toISOString(),
          updatedBy: 'ai:reviewer',
        };
        await page.click('[data-branch-card-id="b-ident"] button[aria-label="更多操作"]');
        await page.getByRole('menuitem', { name: /Claude 在做/ }).click();
        await page.waitForTimeout(600);
        const banner = await page.textContent('[data-branch-view="groups"] [role="alert"]').catch(() => null);
        check(/分组刚被别人改过，已载入最新版本/.test(banner || '') && Boolean(await page.$('[data-branch-group="g-other"]')) && await sectionOf(page, 'b-ident') === codexId,
          `保存冲突时提示并载入最新版本，这次移动没有生效（「${(banner || '').trim().slice(0, 30)}」）`);
        await page.screenshot({ path: path.join(OUT, '5-conflict-dark.png'), fullPage: true });

        // 10. 定位收起分组里已停止的卡：先展开组与已停止那一行，再滚进视野
        await page.setViewportSize({ width: WIDTH, height: 500 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.evaluate((pid) => window.dispatchEvent(new CustomEvent('cds:focus-branch', { detail: { branchId: 'b-old1', projectId: pid } })), PROJECT_ID);
        await page.waitForTimeout(1200);
        const focused = await page.evaluate(() => {
          const el = document.querySelector('[data-branch-card-id="b-old1"]');
          if (!el) return { mounted: false, inView: false };
          const r = el.getBoundingClientRect();
          return { mounted: true, inView: r.bottom > 0 && r.top < window.innerHeight };
        });
        check(focused.mounted && focused.inView, `定位收起分组里已停止的卡：展开并滚进视野（${focused.mounted ? '已渲染' : '未渲染'}、${focused.inView ? '在视野内' : '不在视野内'}）`);
        await page.setViewportSize({ width: WIDTH, height: 1180 });
      }
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    server.stop();
  }
  console.log(`\n截图目录：${OUT}`);
  if (failures.length) {
    console.log(`\n${failures.length} 条未通过`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((err) => { console.error(err); process.exit(1); });
