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

const expressRuntime = { kind: 'release', label: '极速版', title: '', activeProfiles: 3, releaseProfiles: 3, sourceProfiles: 0, modes: ['prebuilt'], prebuilt: true };
const infra = [
  { id: 'mysql', name: 'mysql', dockerImage: 'mysql:8', containerPort: 3306, hostPort: 10491, status: 'running' },
  { id: 'redis', name: 'redis', dockerImage: 'redis:7', containerPort: 6379, hostPort: 10487, status: 'running' },
];

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
    // 构建中：启动容器这一段，有历史中位可比
    base('b-rel', 'release/2026.09', {
      status: 'building', services: services(22200, 'running', { api: { status: 'building' } }),
      deployRuntime: expressRuntime, lastDeployStartedAt: iso(-102_000), lastPushAt: iso(-3 * MIN),
      deployEstimate: { releaseMedianMs: 370_000, releaseSamples: 8, sourceMedianMs: null, sourceSamples: 0 },
    }),
    // 等 CI 镜像：旧版本仍在服务
    base('b-edison', 'claude/beautiful-edison-mx81', {
      ...running(22300), tags: ['登录重构'],
      deployRuntime: expressRuntime, ciImageStatus: 'waiting', ciWaitingSince: iso(-73_000), lastPushAt: iso(-1 * MIN),
    }),
    base('b-scan', 'claude/scan-risk-admin', {
      status: 'error',
      services: services(22400, 'running', { api: { status: 'error', errorMessage: '就绪探测超时（120 秒内 /health 未返回 200）' } }),
      errorMessage: 'api: 就绪探测超时（120 秒内 /health 未返回 200）',
      lastAccessedAt: iso(-19 * MIN),
    }),
    base('b-dirac', 'claude/laughing-dirac-t4e4ug', running(22500)),
    base('b-old1', 'claude/old-experiment-1', stopped(22600)),
    base('b-old2', 'claude/old-experiment-2', stopped(22700)),
    // 排队等构建槽（第 6 位）
    base('b-pack', 'codex/packaging-supplier-flow', {
      status: 'building', services: services(22800, 'running'),
      buildQueue: { queuedAt: iso(-134_000), ahead: 5, active: 3, max: 3, serviceIds: ['api'] },
      lastPushAt: iso(-150_000),
    }),
    base('b-ident', 'codex/identity-menu-clarify', { ...running(22900), tags: ['登录重构'] }),
    base('b-feat', 'feat/solo-branch', stopped(23000)),
  ];
}

let branches = makeBranches();
let groupStore = { groups: [], updatedAt: null, updatedBy: null };
let conflictNext = null;
/** 模拟慢网：PUT 延迟这么多毫秒再应答（串行保存那一步用）。 */
let putDelayMs = 0;
/** 下一次 PUT 模拟服务端故障（500，非冲突），用完即清。 */
let failNext = false;
const puts = [];
const profiles = PROFILES.map((id) => ({ id, name: id, containerPort: 8080, dockerImage: `fixture/${id}:latest` }));

function resolve(pathname) {
  if (pathname === '/api/branches') return { branches, capacity: { maxContainers: 200, runningContainers: 30, totalMemGB: 96 } };
  if (pathname === '/api/infra') return { services: infra };
  if (pathname === '/api/build-profiles') return { profiles };
  if (pathname === `/api/projects/${PROJECT_ID}`) {
    return { id: PROJECT_ID, slug: PROJECT_ID, name: '取证项目', cloneStatus: 'ready', branchCount: branches.length };
  }
  return resolveFixture(pathname);
}

const FAKE_SSE = `
(() => {
  const Real = window.EventSource;
  const live = [];
  class FakeEventSource {
    constructor(url) {
      this.url = String(url); this.listeners = {}; this.readyState = 1;
      if (!this.url.includes('/api/branches/stream')) return new Real(url);
      live.push(this);
      setTimeout(() => this.onopen && this.onopen({}), 0);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
    close() { this.readyState = 2; }
  }
  window.EventSource = FakeEventSource;
  // 脚本用它推一条分支事件，模拟部署中不断到来的 branch.updated
  window.__cdsFire = (type, data) => {
    for (const s of live) {
      if (s.readyState === 2) continue;
      for (const fn of s.listeners[type] || []) fn({ data: JSON.stringify(data) });
    }
    return live.length;
  };
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
        if (putDelayMs) await new Promise((r) => setTimeout(r, putDelayMs));
        if (failNext) {
          failNext = false;
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal', message: '模拟服务端故障' }) });
          return;
        }
        // 与真实接口同口径：版本号对不上就 409，别拿「最后一次写入者赢」掩盖并发问题。
        if (!conflictNext && (body.baseUpdatedAt ?? null) !== (groupStore.updatedAt ?? null)) {
          await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'stale', message: '分组刚被别人改过', latest: groupStore }) });
          return;
        }
        if (conflictNext) {
          groupStore = conflictNext;
          conflictNext = null;
          await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'stale', message: '分组刚被别人改过', latest: groupStore }) });
          return;
        }
        groupStore = { groups: body.groups, updatedAt: `${new Date().toISOString()}#${puts.length}`, updatedBy: 'user' };
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

/** 悬停中的拖拽不松手直接结束（相当于拖到别处放弃），不触发调序。 */
async function cancelDrag(page) {
  await page.evaluate(() => {
    const pending = window.__pendingDrag;
    if (!pending) return;
    pending.src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: pending.dataTransfer }));
    window.__pendingDrag = null;
  });
  await page.waitForTimeout(300);
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

      // 1b. 建议打开期间来了一条分支事件（部署中很常见）：用户已改的组名和勾选不许被重置（Codex P2）
      const claudeName = page.getByLabel('claude/ 的组名');
      await claudeName.fill('我的 Claude 组');
      const releaseBox = page.locator('[data-branch-group-suggestions] label', { hasText: 'release/' }).locator('input[type="checkbox"]');
      await releaseBox.check();
      const touched = branches.find((b) => b.id === 'b-main');
      await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: { ...b, lastAccessedAt: new Date().toISOString() }, projectId: b.projectId }), touched);
      await page.waitForTimeout(500);
      const keptName = await claudeName.inputValue();
      const keptCheck = await releaseBox.isChecked();
      check(keptName === '我的 Claude 组' && keptCheck, `[${theme}] 分支事件到来后建议里已改的组名与勾选保留（组名「${keptName}」，release/ 勾选 ${keptCheck}）`);
      await releaseBox.uncheck();

      // 1c. 建组失败（服务端故障）：面板重新出现时，用户改过的组名与勾选还在（Codex P2，PR #1647）
      failNext = true;
      await page.getByRole('button', { name: /^创建 2 个分组$/ }).click();
      await page.waitForSelector('[data-branch-group-suggestions]', { timeout: 10000 });
      await page.waitForTimeout(400);
      const afterFailName = await page.getByLabel('claude/ 的组名').inputValue();
      const afterFailRelease = await page.locator('[data-branch-group-suggestions] label', { hasText: 'release/' }).locator('input[type="checkbox"]').isChecked();
      const afterFailCodex = await page.locator('[data-branch-group-suggestions] label', { hasText: 'codex/' }).locator('input[type="checkbox"]').isChecked();
      check(afterFailName === '我的 Claude 组' && !afterFailRelease && afterFailCodex && groupStore.groups.length === 0,
        `[${theme}] 建组失败后建议面板回来，改过的组名与勾选都还在（组名「${afterFailName}」，release/ ${afterFailRelease}，codex/ ${afterFailCodex}）`);
      await page.getByLabel('claude/ 的组名').fill('Claude 在做');

      // 2. 一键建组
      const putsBeforeCreate = puts.length;
      putDelayMs = 700;
      await page.getByRole('button', { name: /^创建 2 个分组$/ }).click();
      await page.waitForTimeout(150);
      // 建组是乐观更新：请求还在路上时建议面板已经换成分组视图，不存在「请求途中还能改勾选 / 组名」的窗口
      const suggestionGone = !(await page.$('[data-branch-group-suggestions]'));
      const sectionsShown = (await page.$$('[data-branch-group]')).length > 1;
      await page.waitForTimeout(900);
      putDelayMs = 0;
      check(suggestionGone && sectionsShown, `[${theme}] 点「创建」后建议面板立即换成分组视图，请求途中没有可改的勾选与组名（面板已撤：${suggestionGone}）`);
      await page.waitForSelector('[data-branch-group="__ungrouped__"]', { timeout: 10000 });
      await page.waitForTimeout(500);
      const claudeId = groupStore.groups.find((g) => g.name === 'Claude 在做')?.id;
      const codexId = groupStore.groups.find((g) => g.name === 'Codex 在做')?.id;
      check(Boolean(claudeId && codexId) && puts.length - putsBeforeCreate === 1, `[${theme}] 建组写进了项目共享的分组（PUT ${puts.length - putsBeforeCreate} 次，${groupStore.groups.map((g) => g.name).join(' / ')}）`);
      check(await sectionOf(page, 'b-scan') === claudeId && await sectionOf(page, 'b-pack') === codexId && await sectionOf(page, 'b-main') === '__ungrouped__',
        `[${theme}] 分支按前缀进了对应分组，main 落在未归组`);
      const claudeHeader = await page.textContent(`[data-branch-group="${claudeId}"] [data-branch-group-header]`);
      check(/1 个出错需要处理/.test(claudeHeader || ''), `[${theme}] 组头汇总与页头同口径（「${(claudeHeader || '').replace(/\s+/g, ' ').trim()}」）`);
      const dormantToggle = await page.textContent(`[data-branch-group-dormant-toggle="${claudeId}"]`);
      check(/另有 2 个已停止/.test(dormantToggle || '') && !(await page.$('[data-branch-card-id="b-old1"]')),
        `[${theme}] 组内已停止的收成一行（「${(dormantToggle || '').trim()}」），卡片不占位`);
      const heights = await page.$$eval(`[data-branch-group="${claudeId}"] [data-branch-card-id]`, (els) => els.map((el) => Math.round(el.getBoundingClientRect().height * 10) / 10));
      check(heights.length >= 3 && Math.max(...heights) - Math.min(...heights) <= 1, `[${theme}] 分组里的卡片仍等高（${heights.join(' / ')}）`);
      const headerText = (await page.textContent('[data-testid="branch-overview-bar"]')) || '';
      check(/共享基础设施/.test(headerText) && /构建槽/.test(headerText), `[${theme}] 分组视图页头仍有共享基础设施与构建槽`);
      const codexHeader = (await page.textContent(`[data-branch-group="${codexId}"] [data-branch-group-header]`)) || '';
      check(/1 个排队/.test(codexHeader), `[${theme}] 组头汇总带排队（「${codexHeader.replace(/\s+/g, ' ').trim()}」）`);
      check(await page.getAttribute('[data-branch-card-id="b-edison"]', 'data-deploy-phase') === 'ci-waiting'
        && await page.getAttribute('[data-branch-card-id="b-rel"]', 'data-deploy-phase') === 'start',
        `[${theme}] 分组视图里构建中 / 等镜像的卡照常显示阶段条`);
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
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, '3b-move-menu-dark.png') });
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
        // 「命中 N 个」只数规则命中；菜单移进来的 test 在「手动钉入」那一行单独列
        check(/现在命中 2 个分支/.test(before || '') && /手动钉入 1 个/.test(before || '') && /已归了别的分组/.test(after || ''),
          `编辑规则时命中预览实时刷新，被上方分组先认领的单独列出（前「${(before || '').slice(0, 14)}」）`);
        await page.screenshot({ path: path.join(OUT, '4-editor-dark.png') });
        await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
        await page.waitForTimeout(300);

        // 8a. 往下拖组头时，提示说的是「后面」，与松手后的真实落点一致（Codex P2，PR #1647）
        {
          const before = await sectionOrder(page);
          const [upper, lower] = before.indexOf(claudeId) < before.indexOf(codexId) ? [claudeId, codexId] : [codexId, claudeId];
          await dragTo(page, `[data-branch-group="${upper}"] [data-branch-group-header] [draggable="true"]`, `[data-branch-group="${lower}"]`, { hold: true });
          const hint = (await page.textContent(`[data-branch-group="${lower}"] [data-branch-group-drop-hint]`).catch(() => '')) || '';
          await cancelDrag(page);
          check(/后面/.test(hint) && !/前面/.test(hint) && (await sectionOrder(page)).join() === before.join(),
            `往下拖组头时提示落在目标后面，放弃拖拽不改顺序（「${hint.trim()}」）`);
        }

        // 8. 拖组头把手调顺序：Codex 挪到 Claude 前面
        await dragTo(page, `[data-branch-group="${codexId}"] [data-branch-group-header] [draggable="true"]`, `[data-branch-group="${claudeId}"]`);
        const order = await sectionOrder(page);
        check(order.indexOf(codexId) < order.indexOf(claudeId) && groupStore.groups[0]?.id === codexId,
          `拖组头把手调整分组顺序（${order.join(' → ')}）`);

        // 8b. 从「管理分组 → 新建分组」建一个按标签归组的分组：编辑器里被别组先认领的按组分行，
        //     拖到最前后它认领带标签的分支，组头出现标签规则片
        await page.click('[data-branch-group-manage]');
        await page.getByRole('menuitem', { name: '新建分组' }).click();
        await page.waitForSelector('[data-branch-group-preview]', { timeout: 5000 });
        await page.getByRole('dialog').getByPlaceholder('例如：Claude 在做').fill('#登录重构');
        await page.getByRole('dialog').getByRole('combobox', { name: '规则类型' }).first().selectOption('tag');
        await page.getByRole('dialog').getByLabel('规则值').first().fill('登录重构');
        await page.waitForTimeout(200);
        const takenText = await page.textContent('[data-branch-group-taken]').catch(() => '');
        check(/归了「Claude 在做」/.test(takenText || '') && /归了「Codex 在做」/.test(takenText || ''),
          `新建标签分组时，被别组认领的按认领组分行说明（「${(takenText || '').replace(/\s+/g, ' ').slice(0, 60)}」）`);
        check(Boolean(await page.$('[data-branch-group-claim-order]')) && Boolean(await page.$('[data-branch-group-rule-kinds]')),
          '编辑器常驻认领顺序说明与规则类型提示');
        await page.screenshot({ path: path.join(OUT, '4b-editor-tag-rule-dark.png') });
        await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
        await page.waitForTimeout(600);
        const tagGroupId = groupStore.groups.find((g) => g.name === '#登录重构')?.id;
        check(Boolean(tagGroupId) && !(await page.$('[role="dialog"]')), '新建分组保存后弹窗关闭、分组写进共享数据');
        await dragTo(page, `[data-branch-group="${tagGroupId}"] [data-branch-group-header] [draggable="true"]`, `[data-branch-group="${(await sectionOrder(page))[0]}"]`);
        check(await sectionOf(page, 'b-edison') === tagGroupId && await sectionOf(page, 'b-ident') === tagGroupId,
          '标签分组挪到最前后认领了带「登录重构」标签的分支');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(OUT, '6-tag-group-dark.png'), fullPage: true });

        // 9. 别人刚改过：保存得到 409，载入最新版本并说清楚
        conflictNext = {
          groups: [...groupStore.groups, { id: 'g-other', name: '别人新建的组', color: 'purple', rules: [{ kind: 'prefix', value: 'feat/' }], pinnedBranchIds: [] }],
          updatedAt: new Date(Date.now() + 1000).toISOString(),
          updatedBy: 'ai:reviewer',
        };
        const identSectionBefore = await sectionOf(page, 'b-ident');
        await page.click('[data-branch-card-id="b-ident"] button[aria-label="更多操作"]');
        await page.getByRole('menuitem', { name: /Claude 在做/ }).click();
        await page.waitForTimeout(600);
        const banner = await page.textContent('[data-branch-view="groups"] [role="alert"]').catch(() => null);
        check(/分组刚被别人改过，已载入最新版本/.test(banner || '') && Boolean(await page.$('[data-branch-group="g-other"]')) && await sectionOf(page, 'b-ident') === identSectionBefore,
          `保存冲突时提示并载入最新版本，这次移动没有生效（「${(banner || '').trim().slice(0, 30)}」）`);
        await page.screenshot({ path: path.join(OUT, '5-conflict-dark.png'), fullPage: true });

        // 9b. 编辑器开着时撞上冲突：草稿换成最新版本里的这一组，再点保存不许拿旧草稿覆盖别人的修改
        const codexGroupId = groupStore.groups.find((g) => g.name === 'Codex 在做')?.id;
        await page.click(`[data-branch-group="${codexGroupId}"] button[aria-label="编辑分组Codex 在做"]`);
        await page.waitForSelector('[data-branch-group-preview]', { timeout: 5000 });
        conflictNext = {
          ...groupStore,
          groups: groupStore.groups.map((g) => (g.id === codexGroupId ? { ...g, name: 'Codex 别人改过' } : g)),
          updatedAt: new Date(Date.now() + 2000).toISOString(),
          updatedBy: 'ai:reviewer',
        };
        const nameInput = page.getByRole('dialog').getByPlaceholder('例如：Claude 在做');
        await nameInput.fill('我的改名');
        await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
        await page.waitForTimeout(600);
        const rebasedName = await nameInput.inputValue().catch(() => '');
        await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
        await page.waitForTimeout(600);
        const savedName = groupStore.groups.find((g) => g.id === codexGroupId)?.name;
        check(rebasedName === 'Codex 别人改过' && savedName === 'Codex 别人改过',
          `编辑器开着撞上冲突：草稿换成最新版本，再保存不覆盖别人的修改（草稿「${rebasedName}」，存下「${savedName}」）`);

        // 9d. 慢网下连续两次移组：请求串行、各自带上一次确认的版本号，两次都生效，不撞出假冲突
        putDelayMs = 700;
        const putsBefore = puts.length;
        const targetGroupId = groupStore.groups.find((g) => g.name === 'Codex 别人改过')?.id;
        for (const cardId of ['b-main', 'b-edison']) {
          await page.click(`[data-branch-card-id="${cardId}"] button[aria-label="更多操作"]`).catch(() => undefined);
          await page.getByRole('menuitem', { name: /Codex 别人改过/ }).click().catch(() => undefined);
          await page.waitForTimeout(80);
        }
        await page.waitForTimeout(2200);
        putDelayMs = 0;
        const pinned = groupStore.groups.find((g) => g.id === targetGroupId)?.pinnedBranchIds || [];
        const serialBanner = await page.textContent('[data-branch-view="groups"] [role="alert"]').catch(() => '');
        check(pinned.includes('b-main') && pinned.includes('b-edison') && !/别人改过，已载入/.test(serialBanner || '') && puts.length - putsBefore === 2,
          `慢网下连续两次移组都生效、没有假冲突（钉入 ${pinned.join(',') || '无'}，请求 ${puts.length - putsBefore} 次）`);

        // 9e. 慢网下第一步撞上冲突：排在它后面的那一步建立在它之上，一并撤回、不再发请求，提示里说清楚
        putDelayMs = 700;
        conflictNext = { ...groupStore, updatedAt: `${new Date(Date.now() + 5000).toISOString()}#other`, updatedBy: 'ai:reviewer' };
        const putsBeforeConflict = puts.length;
        const tagGroupName = groupStore.groups.find((g) => g.name === '#登录重构')?.name || '#登录重构';
        for (const cardId of ['b-main', 'b-edison']) {
          await page.click(`[data-branch-card-id="${cardId}"] button[aria-label="更多操作"]`).catch(() => undefined);
          await page.getByRole('menuitem', { name: new RegExp(tagGroupName) }).click().catch(() => undefined);
          await page.waitForTimeout(80);
        }
        await page.waitForTimeout(2200);
        putDelayMs = 0;
        const dropBanner = (await page.textContent('[data-branch-view="groups"] [role="alert"]').catch(() => '')) || '';
        check(puts.length - putsBeforeConflict === 1 && /一并撤回/.test(dropBanner),
          `第一步冲突时后面那一步一并撤回、不再发请求（请求 ${puts.length - putsBeforeConflict} 次，「${dropBanner.trim().slice(0, 60)}」）`);

        // 9f. 保存在路上时编辑器整张表单只读；规则加到上限后「添加规则」不可点
        {
          const gid = groupStore.groups.find((g) => g.name === 'Codex 别人改过')?.id;
          await page.click(`[data-branch-group="${gid}"] [data-branch-group-header] button[aria-label^="编辑分组"]`);
          await page.waitForSelector('[data-branch-group-preview]', { timeout: 5000 });
          const dialog = page.getByRole('dialog');
          const addRule = dialog.getByRole('button', { name: '添加规则' });
          let guard = 0;
          while (await addRule.isEnabled() && guard < 40) { await addRule.click(); guard += 1; }
          const ruleCount = await dialog.getByLabel('规则值').count();
          const limitHint = Boolean(await page.$('[data-branch-group-rule-limit]'));
          check(ruleCount === 20 && limitHint, `规则加到 20 条后「添加规则」不可点并提示上限（${ruleCount} 条）`);
          await dialog.getByRole('button', { name: '取消', exact: true }).click();
          await page.waitForTimeout(300);
          await page.click(`[data-branch-group="${gid}"] [data-branch-group-header] button[aria-label^="编辑分组"]`);
          await page.waitForSelector('[data-branch-group-preview]', { timeout: 5000 });
          putDelayMs = 900;
          await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
          await page.waitForTimeout(150);
          const lockedWhileSaving = await page.getByRole('dialog').getByPlaceholder('例如：Claude 在做').isDisabled();
          await page.waitForTimeout(1300);
          putDelayMs = 0;
          check(lockedWhileSaving && !(await page.$('[role="dialog"]')), `保存在路上时编辑器表单只读，保存成功后关闭（只读：${lockedWhileSaving}）`);
        }

        // 9g. 慢网钉入还没回来时打开编辑器，钉入随后失败（非冲突）：编辑器草稿换回已确认版本，
        //     再点保存不会把刚撤回的钉入悄悄写回去（Codex P2，PR #1647）
        {
          const gid = groupStore.groups.find((g) => g.name === 'Codex 别人改过')?.id;
          const gname = 'Codex 别人改过';
          const alreadyPinned = groupStore.groups.find((g) => g.id === gid)?.pinnedBranchIds || [];
          const assigned = await page.$$eval('[data-branch-group]', (els) => Object.fromEntries(els.flatMap((el) =>
            [...el.querySelectorAll('[data-branch-card-id]')].map((card) => [card.getAttribute('data-branch-card-id'), el.getAttribute('data-branch-group')]))));
          const candidate = ['b-ident', 'b-test', 'b-scan', 'b-pack', 'b-relaxed'].find((id) => !alreadyPinned.includes(id) && assigned[id] && assigned[id] !== gid);
          putDelayMs = 900;
          failNext = true;
          await page.click(`[data-branch-card-id="${candidate}"] button[aria-label="更多操作"]`);
          await page.getByRole('menuitem', { name: new RegExp(gname) }).click();
          await page.waitForTimeout(100);
          await page.click(`[data-branch-group="${gid}"] [data-branch-group-header] button[aria-label^="编辑分组"]`);
          await page.waitForSelector('[data-branch-group-preview]', { timeout: 5000 });
          await page.waitForTimeout(1400);
          putDelayMs = 0;
          const failBanner = (await page.textContent('[data-branch-view="groups"] [role="alert"]').catch(() => '')) || '';
          if (await page.$('[role="dialog"]')) {
            await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
            await page.waitForTimeout(700);
          }
          const pinnedAfter = groupStore.groups.find((g) => g.id === gid)?.pinnedBranchIds || [];
          check(Boolean(candidate) && /保存失败/.test(failBanner) && !pinnedAfter.includes(candidate),
            `钉入失败后，期间打开的编辑器不把撤回的钉入写回去（${candidate}，提示「${failBanner.trim().slice(0, 30)}」，存下的钉入 ${pinnedAfter.join(',') || '无'}）`);
          if (await page.$('[role="dialog"]')) {
            await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
            await page.waitForTimeout(300);
          }
        }

        // 9h. 慢网钉入还没回来时打开编辑器，钉入随后成功；之后编辑器自己保存失败：
        //     用户改过的草稿要留着好重试，不能按「取自乐观版本」换掉（Codex P2，PR #1647）
        {
          const gid = groupStore.groups.find((g) => g.name === 'Codex 别人改过')?.id;
          const alreadyPinned = groupStore.groups.find((g) => g.id === gid)?.pinnedBranchIds || [];
          const assigned = await page.$$eval('[data-branch-group]', (els) => Object.fromEntries(els.flatMap((el) =>
            [...el.querySelectorAll('[data-branch-card-id]')].map((card) => [card.getAttribute('data-branch-card-id'), el.getAttribute('data-branch-group')]))));
          const candidate = ['b-ident', 'b-test', 'b-scan', 'b-pack', 'b-relaxed'].find((id) => !alreadyPinned.includes(id) && assigned[id] && assigned[id] !== gid);
          putDelayMs = 700;
          await page.click(`[data-branch-card-id="${candidate}"] button[aria-label="更多操作"]`);
          await page.getByRole('menuitem', { name: /Codex 别人改过/ }).click();
          await page.waitForTimeout(100);
          await page.click(`[data-branch-group="${gid}"] [data-branch-group-header] button[aria-label^="编辑分组"]`);
          await page.waitForSelector('[data-branch-group-preview]', { timeout: 5000 });
          await page.waitForTimeout(1000);
          putDelayMs = 0;
          const nameInput = page.getByRole('dialog').getByPlaceholder('例如：Claude 在做');
          await nameInput.fill('Codex 我的改名');
          failNext = true;
          await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
          await page.waitForTimeout(700);
          const stillOpen = Boolean(await page.$('[role="dialog"]'));
          const keptName = stillOpen ? await nameInput.inputValue() : '';
          check(stillOpen && keptName === 'Codex 我的改名',
            `依赖的钉入已成功后，编辑器自己保存失败，草稿保留（弹窗${stillOpen ? '仍开着' : '已关'}，名称「${keptName}」）`);
          if (stillOpen) {
            await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
            await page.waitForTimeout(300);
          }
        }

        // 9c. 标签筛选开着时编辑分组：命中预览仍按项目全部分支算（规则保存后作用于全部分支）
        const openCodexEditor = async () => {
          await page.click(`[data-branch-group="${codexGroupId}"] [data-branch-group-header] button[aria-label^="编辑分组"]`);
          await page.waitForSelector('[data-branch-group-preview]', { timeout: 5000 });
          const text = (await page.textContent('[data-branch-group-preview]')) || '';
          await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
          await page.waitForTimeout(300);
          return (text.match(/现在命中 (\d+) 个分支/) || [])[1] || '0';
        };
        const hitsAll = await openCodexEditor();
        await page.click('button[title="按 #登录重构 过滤"]');
        await page.waitForTimeout(300);
        const hitsFiltered = await openCodexEditor();
        check(hitsAll === hitsFiltered && hitsAll !== '0', `标签筛选不影响编辑器命中预览（全部 ${hitsAll} 个，筛选时 ${hitsFiltered} 个）`);
        await page.click('button[title="清除过滤"]').catch(() => undefined);
        await page.waitForTimeout(300);

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
