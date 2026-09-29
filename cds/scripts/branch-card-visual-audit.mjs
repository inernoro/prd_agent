#!/usr/bin/env node
/*
 * 分支卡片视觉取证（离线）：自起 vite dev、把 /api/* 换成复刻真实截图的合成数据，
 * 用真浏览器量「同一排卡片是否等高」、截双主题图，并驱动一次「构建中 → 完成 / 失败」
 * 的状态翻转，把收尾动效逐帧拍下来。
 *
 * 为什么要它：这块界面反复出现「设计稿里好看、交付出来不像」。设计稿与实现之间
 * 唯一可靠的桥是同一组状态、同一个视口、同一把尺子——所以这里把用户截图里那七张卡
 * （停止 / 运行 / 出错 / 等 CI 镜像 / 排队 / 超时 / 停止）原样造出来，量完再截图。
 *
 * 判据（任一不满足退出码非 0）：
 *   1. 主网格同一排的卡片高度差 ≤ 1px（高低不齐的机械判据）；
 *   2. 每张在构建的卡带 data-deploy-phase，且取值符合它的真实状态；
 *   3. 状态翻转后 data-deploy-phase 依次变为 done / failed（收尾有没有接上线）；
 *   4. 页脚里的构建文字没有被截断（scrollWidth ≤ clientWidth）。
 *
 * 用法：node scripts/branch-card-visual-audit.mjs [--out <dir>] [--width 1920]
 * 截图写进 --out（默认 /tmp/branch-card-audit），不进仓库。
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
const OUT = argValue('--out', '/tmp/branch-card-audit');
const WIDTH = Number(argValue('--width', '1920'));
fs.mkdirSync(OUT, { recursive: true });

const PROJECT_ID = 'fixture-project';
const PROFILES = ['api', 'admin', 'web', 'worker', 'gateway', 'report', 'search', 'notify', 'billing', 'auth', 'media', 'export', 'scheduler'];

/* ── 合成数据：七张卡复刻用户 2026-09-29 截图 ─────────────────────────── */
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const MIN = 60_000;

function services(basePort, status, overrides = {}) {
  const out = {};
  PROFILES.forEach((id, i) => {
    out[id] = { profileId: id, containerName: `fixture-${id}-${basePort}`, hostPort: basePort + i * 17, status, ...(overrides[id] || {}) };
  });
  return out;
}

const expressRuntime = { kind: 'release', label: '极速版', title: '', activeProfiles: 13, releaseProfiles: 13, sourceProfiles: 0, modes: ['prebuilt'], prebuilt: true };

function makeBranches() {
  const base = (id, name, extra) => ({
    id,
    projectId: PROJECT_ID,
    branch: name,
    createdAt: iso(-3 * 24 * 60 * MIN),
    commitSha: `${id.replace(/[^0-9a-f]/g, '').padEnd(7, 'a').slice(0, 7)}${'0'.repeat(33)}`,
    subject: '合成提交：分支卡片视觉取证',
    builder: { name: 'fixture-builder', login: 'fixture-builder' },
    tags: [],
    ...extra,
  });
  return [
    base('b-main', 'main', {
      // 僵尸条目：构建配置 legacy-gw 已删，删的时候分支正忙没清掉，条目停在 error。
      // 它不在项目构建配置里，不许把这条分支算成「出错需要处理」（Codex P2）。
      status: 'idle', services: { ...services(22000, 'stopped'), 'legacy-gw': { profileId: 'legacy-gw', containerName: 'fixture-legacy-gw', hostPort: 22999, status: 'error', errorMessage: '构建配置已删除' } },
      lastStopSource: 'webhook', lastStopReason: 'GitHub webhook 触发停止', lastStoppedAt: iso(-18 * 60 * MIN),
      lastDeployAt: iso(-20 * 60 * MIN),
    }),
    base('b-test', 'test', {
      status: 'running', services: services(22331, 'running'),
      // 容器级复制集：三个容器各做了复制。标识与端口挤在同一条单行槽里，「+N」不能被挤出卡片。
      // 同时带「CI 失败」标记（极速版 CI 出镜像失败、旧版本仍在跑）：端口行最挤的情形，只剩一个端口名额。
      ciImageStatus: 'failed', ciWorkflowConclusion: 'failure', ciWorkflowRunUrl: 'https://github.com/example/actions/runs/1',
      // 再加配置漂移：端口行上四种附加标记（复制集 / CI 失败 / 基础设施异常 / 漂移）同时出现的最挤情形。
      deployRuntime: { kind: 'source', drift: { hasDrift: true, expectedCount: 13, healthyCount: 10, missingProfileIds: ['search', 'notify'], unhealthyProfileIds: ['api'] } },
      replicaMode: 'container',
      replicaSets: Object.fromEntries(['api', 'admin', 'web'].map((id) => [id, { enabled: true, members: [{ status: 'running' }, { status: 'running' }] }])),
      lastDeployAt: iso(-40 * MIN), lastAccessedAt: iso(-5 * MIN),
    }),
    base('b-scan', 'codex/scan-risk-admin-fix-branch', {
      status: 'error',
      services: services(22400, 'running', { api: { status: 'error', errorMessage: '就绪探测超时（120 秒内 /health 未返回 200）' } }),
      errorMessage: 'imp-api-mdimp: 就绪探测超时（120 秒内 /health 未返回 200），旧版本已下线',
      lastAccessedAt: iso(-19 * MIN),
    }),
    base('b-edison', 'claude/beautiful-edison-mx81', {
      status: 'running', services: services(22705, 'running'),
      deployRuntime: expressRuntime, ciImageStatus: 'waiting', ciWaitingSince: iso(-72_000), tags: ['登录重构'],
      lastPushAt: iso(-1 * MIN), lastDeployAt: iso(-3 * 60 * MIN),
      // 项目级复制集：13 个容器各有一个副本、同属一组，派生出一张复制集卡。成员多到换好几行，
      // 成员区必须在卡内滚动、「打开详情」留在卡底（Codex P2，PR #1646）。
      replicaMode: 'project',
      replicaSets: Object.fromEntries(PROFILES.map((id, i) => [id, { enabled: true, members: [{ id: `rs-${id}`, status: 'running', projectGroupId: 'pg-1', hostPort: 26000 + i }] }])),
    }),
    base('b-pack', 'codex/packaging-supplier-flow', {
      // 排队等构建槽时旧容器照常在跑（真实情况如此），卡片应说「旧版本仍在服务」。
      status: 'building', services: services(23827, 'running'),
      buildQueue: { queuedAt: iso(-134_000), ahead: 5, active: 3, max: 3, serviceIds: ['api'] },
      lastAccessedAt: iso(-134_000), lastPushAt: iso(-150_000),
      deployEstimate: { releaseMedianMs: null, releaseSamples: 0, sourceMedianMs: 448_000, sourceSamples: 6 },
    }),
    base('b-ident', 'codex/identity-menu-clarify', {
      status: 'starting', services: services(24184, 'running', { api: { status: 'starting' } }),
      // 先是未超时（04:05 / 约 06:10），脚本随后推一次更新让它超时。
      deployRuntime: expressRuntime, lastAccessedAt: iso(-245_000), lastPushAt: iso(-7 * MIN),
      deployEstimate: { releaseMedianMs: 370_000, releaseSamples: 8, sourceMedianMs: null, sourceSamples: 0 },
    }),
    base('b-relaxed', 'claude/relaxed-brown-hcib', {
      status: 'idle', services: services(24300, 'stopped'),
      lastStopSource: 'webhook', lastStopReason: 'GitHub webhook 触发停止', lastStoppedAt: iso(-15 * 60 * MIN),
      lastDeployAt: iso(-16 * 60 * MIN),
    }),
  ];
}

let branches = makeBranches();
const profiles = PROFILES.map((id) => ({ id, name: id, containerPort: 8080, dockerImage: `fixture/${id}:latest` }));
const infra = [
  { id: 'mysql', name: 'mysql', dockerImage: 'mysql:8', containerPort: 3306, hostPort: 10491, status: 'running' },
  { id: 'redis', name: 'redis', dockerImage: 'redis:7', containerPort: 6379, hostPort: 10487, status: 'running' },
  // 共享基础设施有一个异常：每张卡的端口行都会多出「基础设施异常」标记。
  { id: 'rabbitmq', name: 'rabbitmq', dockerImage: 'rabbitmq:3-management', containerPort: 5672, hostPort: 10488, status: 'error' },
];

function resolve(pathname) {
  if (pathname === '/api/branches') return { branches, capacity: { maxContainers: 200, runningContainers: 60, totalMemGB: 96 } };
  if (pathname === '/api/infra') return { services: infra };
  if (pathname === '/api/build-profiles') return { profiles };
  if (pathname === `/api/projects/${PROJECT_ID}`) {
    return { id: PROJECT_ID, slug: PROJECT_ID, name: '取证项目', cloneStatus: 'ready', branchCount: branches.length };
  }
  return resolveFixture(pathname);
}

/*
 * 分支 SSE 换成可控的假 EventSource：页面照常订阅，脚本用 window.__cdsFire(type, data)
 * 推事件。真实服务端也是这条通道把状态翻转推给卡片的，所以驱动的是同一条代码路径。
 */
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
    const pathname = new URL(route.request().url()).pathname;
    if (isEventStream(pathname)) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
      return;
    }
    const body = resolve(pathname);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body ?? {}) });
  });
  const page = await context.newPage();
  await page.goto(`${url}/branch-list?project=${PROJECT_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-branch-card-id="b-test"]', { timeout: 30000 });
  await page.waitForTimeout(1200);
  return { context, page };
}

/* 同一排 = 卡片顶边 y 相同。量每排的高度差。 */
async function measureRows(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-branch-card-id]')];
    const rows = new Map();
    for (const el of cards) {
      const r = el.getBoundingClientRect();
      const key = Math.round(r.top + window.scrollY);
      const list = rows.get(key) || [];
      list.push({ id: el.getAttribute('data-branch-card-id'), h: Math.round(r.height * 10) / 10, phase: el.getAttribute('data-deploy-phase') });
      rows.set(key, list);
    }
    return [...rows.entries()].map(([top, list]) => ({ top, list }));
  });
}

async function footerTruncation(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-branch-card-id] [data-footer-status]')]
    .map((el) => ({
      id: el.closest('[data-branch-card-id]').getAttribute('data-branch-card-id'),
      text: el.textContent.trim(),
      clipped: el.scrollWidth > el.clientWidth + 1,
    })));
}

async function shotCard(page, id, file) {
  // 外扩 14px：收尾的成功色外圈脉冲画在卡片边框之外，贴边截会把它裁掉。
  const box = await page.$eval(`[data-branch-card-id="${id}"]`, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }).catch(() => null);
  if (!box) return;
  const pad = 14;
  await page.screenshot({ path: path.join(OUT, file), clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 } });
}

async function main() {
  const server = await startViteDevServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' });
    for (const theme of ['dark', 'light']) {
      branches = makeBranches();
      const { context, page } = await openPage(browser, server.url, theme);
      const rows = await measureRows(page);
      rows.forEach((row, i) => {
        const hs = row.list.map((c) => c.h);
        const spread = Math.max(...hs) - Math.min(...hs);
        console.log(`[${theme}] 第 ${i + 1} 排 ${row.list.map((c) => `${c.id}=${c.h}`).join('  ')}`);
        check(spread <= 1, `[${theme}] 第 ${i + 1} 排卡片等高（差 ${spread.toFixed(1)}px）`);
      });
      // 复制集卡：与分支卡同高，成员区真的溢出并可在卡内滚动，底部按钮没被挤出卡片
      const replica = await page.evaluate(() => {
        const members = document.querySelector('[data-replica-members]');
        const card = members?.parentElement;
        const branchCard = document.querySelector('[data-branch-card-id="b-edison"]');
        const detail = card ? [...card.querySelectorAll('button')].find((b) => b.textContent?.includes('打开详情')) : null;
        if (!members || !card || !branchCard || !detail) return null;
        const c = card.getBoundingClientRect();
        const d = detail.getBoundingClientRect();
        const before = members.scrollTop;
        members.scrollTop = members.scrollHeight;
        const scrolled = members.scrollTop > before;
        members.scrollTop = 0;
        return {
          cardH: Math.round(c.height * 10) / 10,
          branchH: Math.round(branchCard.getBoundingClientRect().height * 10) / 10,
          overflow: members.scrollHeight - members.clientHeight,
          scrolled,
          overflowY: getComputedStyle(members).overflowY,
          detailInside: d.bottom <= c.bottom + 0.5 && d.top >= c.top,
        };
      });
      check(Boolean(replica) && Math.abs(replica.cardH - replica.branchH) <= 1,
        `[${theme}] 复制集卡与分支卡同高（${replica?.cardH} / ${replica?.branchH}）`);
      check(Boolean(replica) && replica.overflow > 0 && replica.scrolled && replica.detailInside,
        `[${theme}] 复制集成员多到溢出时在卡内滚动（溢出 ${replica?.overflow}px，滚动 ${replica?.scrolled}，overflow-y ${replica?.overflowY}），「打开详情」仍在卡内`);
      const phases = Object.fromEntries(rows.flatMap((r) => r.list).map((c) => [c.id, c.phase]));
      check(phases['b-pack'] === 'queued', `[${theme}] 排队卡 data-deploy-phase=queued（实际 ${phases['b-pack']}）`);
      check(phases['b-edison'] === 'ci-waiting', `[${theme}] 等镜像卡 data-deploy-phase=ci-waiting（实际 ${phases['b-edison']}）`);
      check(phases['b-ident'] === 'ready', `[${theme}] 就绪探测卡 data-deploy-phase=ready（实际 ${phases['b-ident']}）`);
      // 初始只有 b-scan 真出错；b-main 身上的僵尸 error 条目不计入，也不让卡片进出错态。
      const headline = (await page.textContent('[data-testid="branch-overview-bar"] h2')) || '';
      const erroredInitial = Number((headline.match(/(\d+)\s*个出错需要处理/) || [])[1] || 0);
      check(erroredInitial === 1, `[${theme}] 僵尸服务不计入「出错需要处理」（实际 ${erroredInitial}，「${headline.trim()}」）`);
      const mainRedeploy = await page.$$eval('[data-branch-card-id="b-main"] button[aria-label^="重新部署"]', (els) => els.length).catch(() => 0);
      check(phases['b-main'] !== 'failed' && mainRedeploy === 0, `[${theme}] 带僵尸 error 条目的分支卡不进出错态（phase=${phases['b-main']}，重新部署按钮 ${mainRedeploy} 个）`);
      const metaTimes = await page.$$eval('[data-branch-card-id="b-pack"], [data-branch-card-id="b-ident"]', (els) => els.map((el) => el.textContent || ''));
      check(metaTimes.every((t) => /最近推送/.test(t)), `[${theme}] 构建中卡片右侧有「最近推送」时间`);
      for (const f of await footerTruncation(page)) {
        check(!f.clipped, `[${theme}] ${f.id} 页脚构建文字没被截断：「${f.text}」`);
      }
      await page.screenshot({ path: path.join(OUT, `grid-${theme}.png`), fullPage: true });

      // 复制集标识 + 端口 + 「+N」同在一条单行槽：各档视口宽度下「+N」都要完整落在卡片里、点得到。
      for (const vw of [1920, 1280, 1100, 1000, 900, 760, 390]) {
        await page.setViewportSize({ width: vw, height: 1000 });
        await page.waitForTimeout(250);
        const fit = await page.$eval('[data-branch-card-id="b-test"]', (card) => {
          const btn = [...card.querySelectorAll('button[aria-haspopup="menu"]')].find((b) => /^\+\d+$/.test(b.textContent.trim()));
          if (!btn) return null;
          const c = card.getBoundingClientRect();
          const b = btn.getBoundingClientRect();
          const inside = (el) => {
            const r = el ? el.getBoundingClientRect() : null;
            return Boolean(r && r.width > 0 && r.right <= c.right - 8);
          };
          const infra = [...card.querySelectorAll('span')].find((el) => el.textContent.trim() === '基础设施异常');
          return {
            cardW: Math.round(c.width),
            inside: inside(btn)
              && inside(card.querySelector('button[aria-label^="CI 构建失败"]'))
              && inside(infra)
              && inside(card.querySelector('[data-drift-chip]')),
          };
        });
        if (vw === 1000) await shotCard(page, 'b-test', `port-row-markers-${theme}-${vw}.png`);
        check(Boolean(fit && fit.inside), `[${theme}] 视口 ${vw}px（卡宽 ${fit?.cardW ?? '?'}px）复制集 / CI 失败 / 基础设施异常 / 漂移四种标记都在时，它们与「+N」都完整落在卡内`);
      }
      await page.setViewportSize({ width: WIDTH, height: 1000 });
      await page.waitForTimeout(250);

      if (theme === 'dark') {
        // 同一张卡先未超时、再超时：两种时间写法都留证。
        await shotCard(page, 'b-ident', 'ready-on-time.png');
        const onTime = await page.textContent('[data-branch-card-id="b-ident"] [data-footer-status]');
        check(/\/\s*约/.test(onTime || ''), `未超时写成「用时 / 约 预计」（实际「${(onTime || '').trim()}」）`);
        // 呼吸：把卡里所有动画停在同一时刻拍两帧（判据不挂在亚秒截图上，时刻由脚本钉死）。
        for (const [ms, name] of [[0, 'breath-a'], [1000, 'breath-b']]) {
          await page.$eval('[data-branch-card-id="b-ident"]', (el, t) => {
            for (const a of el.getAnimations({ subtree: true })) { a.pause(); a.currentTime = t; }
          }, ms);
          await shotCard(page, 'b-ident', `${name}.png`);
        }
        await page.$eval('[data-branch-card-id="b-ident"]', (el) => { for (const a of el.getAnimations({ subtree: true })) a.play(); });
        const late = { ...branches.find((b) => b.id === 'b-ident'), lastAccessedAt: iso(-400_000) };
        branches = branches.map((b) => (b.id === late.id ? late : b));
        await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), late);
        await page.waitForTimeout(1200);
        await shotCard(page, 'b-ident', 'ready-overdue.png');
        const overText = await page.textContent('[data-branch-card-id="b-ident"] [data-footer-status]');
        check(/超出预计/.test(overText || ''), `超过历史中位后改说「超出预计」（实际「${(overText || '').trim()}」）`);

        // 收尾：identity-menu 从「就绪探测」翻成运行中。
        // 先把视口压到 100px 高，让这张卡完全不在视野里：收尾动效不该在屏幕外白白播完。
        const done = { ...branches.find((b) => b.id === 'b-ident'), status: 'running', services: services(24184, 'running'), lastDeployAt: iso(0) };
        branches = branches.map((b) => (b.id === done.id ? done : b));
        await shotCard(page, 'b-ident', 'finish-0-before.png');
        await page.setViewportSize({ width: WIDTH, height: 100 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), done);
        await page.waitForTimeout(700);
        const offscreenPhase = await page.getAttribute('[data-branch-card-id="b-ident"]', 'data-deploy-phase');
        const offscreenTop = await page.$eval('[data-branch-card-id="b-ident"]', (el) => Math.round(el.getBoundingClientRect().top));
        check(offscreenTop >= 100, `取证前提：卡片顶边 ${offscreenTop}px 在 100px 视口之外`);
        check(offscreenPhase === null, `卡片不在视野里时收尾先不播（实际 data-deploy-phase=${offscreenPhase}）`);
        await page.setViewportSize({ width: WIDTH, height: 1180 });
        const t0 = Date.now();
        for (const [ms, name] of [[150, '1-150ms'], [450, '2-450ms'], [760, '3a-800ms-stagger'], [850, '3-850ms'], [1300, '4-1300ms-ring'], [2000, '5-2000ms']]) {
          const wait = ms - (Date.now() - t0);
          if (wait > 0) await page.waitForTimeout(wait);
          if (name.includes('stagger')) {
            // 端口依次点亮：把卡内动画就地暂停拍一帧，并量前三个端口 chip 的不透明度——
            // 先点亮的更亮，逐个递减才算「依次」，同时亮起就是没做出来。
            const opacities = await page.$eval('[data-branch-card-id="b-ident"]', (el) => {
              // 收尾的所有动画是同一次渲染挂上的，起点相同；统一钉到 800ms（第一个 chip 已播 100ms、
              // 第二个 60ms、第三个 20ms），比读墙钟可靠——墙钟里还混着观察器回调与渲染的几十毫秒。
              for (const a of el.getAnimations({ subtree: true })) { a.pause(); a.currentTime = 800; }
              return [...el.querySelectorAll('.cds-finish-chip')].slice(0, 3).map((c) => Number(getComputedStyle(c).opacity));
            });
            await shotCard(page, 'b-ident', `finish-${name}.png`);
            await page.$eval('[data-branch-card-id="b-ident"]', (el) => { for (const a of el.getAnimations({ subtree: true })) a.play(); });
            // 共享基础设施报异常时每张卡的端口行多一个标记、少露一个端口，所以按「至少两个、逐个递减」判。
            const ordered = opacities.length >= 2 && opacities.every((o, i) => i === 0 || opacities[i - 1] > o);
            check(ordered, `端口依次点亮（800ms 时 ${opacities.length} 个 chip 不透明度 ${opacities.map((o) => o.toFixed(2)).join(' > ')}）`);
            continue;
          }
          await shotCard(page, 'b-ident', `finish-${name}.png`);
          if (name.includes('ring')) {
            const ring = await page.$eval('[data-branch-card-id="b-ident"]', (el) => el.getAnimations().map((a) => a.animationName || ''));
            check(ring.includes('cds-finish-ring'), `收尾外圈脉冲在播（实际 ${JSON.stringify(ring)}）`);
          }
        }
        const finishedAt = t0;

        const donePhase = await page.getAttribute('[data-branch-card-id="b-ident"]', 'data-deploy-phase');
        check(donePhase === 'done', `滚进视野后收尾播出，data-deploy-phase=done（实际 ${donePhase}）`);

        // 排队位次 6 → 5：新数字从下方滚进来。
        const moved = { ...branches.find((b) => b.id === 'b-pack') };
        moved.buildQueue = { ...moved.buildQueue, ahead: 4 };
        branches = branches.map((b) => (b.id === moved.id ? moved : b));
        // 判据不挂在亚秒动画的截图上（无头软渲染会掉帧），直接问浏览器这次换数字有没有挂上动画。
        const rolled = await page.evaluate(async (b) => {
          window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId });
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const el = document.querySelector('[data-branch-card-id="b-pack"] .cds-roll-in');
          return el ? el.getAnimations().map((a) => a.animationName || '') : [];
        }, moved);
        check(rolled.includes('cds-roll-in'), `位次变化时挂上了滚动动画（实际 ${JSON.stringify(rolled)}）`);
        // 把滚动动画停在 90ms 拍中间态，再放行拍终态。
        await page.$eval('[data-branch-card-id="b-pack"] .cds-roll-in', (el) => { for (const a of el.getAnimations()) { a.pause(); a.currentTime = 90; } });
        await shotCard(page, 'b-pack', 'queue-roll-90ms.png');
        await page.$eval('[data-branch-card-id="b-pack"] .cds-roll-in', (el) => { for (const a of el.getAnimations()) a.finish(); });
        await shotCard(page, 'b-pack', 'queue-roll-done.png');
        const queueText = await page.textContent('[data-branch-card-id="b-pack"] [data-footer-status]');
        check(/第\s*5\s*位/.test(queueText || ''), `排队位次滚到第 5 位（实际「${(queueText || '').trim()}」）`);

        // 失败：packaging 从排队进入构建再失败。
        const building = { ...branches.find((b) => b.id === 'b-pack'), buildQueue: null, status: 'building' };
        await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), building);
        await page.waitForTimeout(400);
        const failed = { ...building, status: 'error', errorMessage: 'api 启动后退出（退出码 137）', services: services(23827, 'running', { api: { status: 'error', errorMessage: '启动后退出（退出码 137）' } }) };
        await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), failed);
        await page.waitForTimeout(600);
        await shotCard(page, 'b-pack', 'failed.png');
        const failPhase = await page.getAttribute('[data-branch-card-id="b-pack"]', 'data-deploy-phase');
        check(failPhase === 'failed', `构建失败后 data-deploy-phase=failed（实际 ${failPhase}）`);
        // 别的卡状态变化会让列表重排；重排挪动 DOM 会把 CSS 动画从头重播。收尾卡必须停在终态。
        const previewOpacity = await page.evaluate(() => {
          const btn = document.querySelector('[data-branch-card-id="b-ident"] button[aria-label="预览"]');
          if (!btn) return 0;
          let o = 1;
          for (let el = btn; el; el = el.parentElement) o *= Number(getComputedStyle(el).opacity || 1);
          return o;
        });
        check(previewOpacity > 0.95, `重排后收尾卡的预览按钮仍可见（有效不透明度 ${previewOpacity.toFixed(2)}）`);
        const after = await measureRows(page);
        after.forEach((row, i) => {
          const hs = row.list.map((c) => c.h);
          check(Math.max(...hs) - Math.min(...hs) <= 1, `状态翻转后第 ${i + 1} 排仍等高`);
        });
        await page.screenshot({ path: path.join(OUT, 'grid-dark-after.png'), fullPage: true });

        // 60 秒后：「刚部署成功」退场，页脚换回提交信息。
        const remain = 61_500 - (Date.now() - finishedAt);
        if (remain > 0) await page.waitForTimeout(remain);
        await shotCard(page, 'b-ident', 'finish-6-after-60s.png');
        const settledPhase = await page.getAttribute('[data-branch-card-id="b-ident"]', 'data-deploy-phase');
        check(settledPhase === null, `60 秒后收尾态退场（实际 data-deploy-phase=${settledPhase}）`);

        // 单服务重建：分支保持 running，只有一个服务在 building（单 profile 部署 / webhook 只重建一个服务）。
        // 阶段条认得出来，时钟也必须从 lastDeployStartedAt 起走，不能停在 00:00（Codex P2）。
        const oneSvc = {
          ...branches.find((b) => b.id === 'b-test'),
          status: 'running',
          services: services(22331, 'running', { api: { status: 'building' } }),
          deployRuntime: expressRuntime,
          lastDeployStartedAt: iso(-65_000),
        };
        branches = branches.map((b) => (b.id === oneSvc.id ? oneSvc : b));
        await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), oneSvc);
        await page.waitForTimeout(1200);
        const tickA = (await page.textContent('[data-branch-card-id="b-test"] [data-footer-status]')) || '';
        await page.waitForTimeout(2200);
        const tickB = (await page.textContent('[data-branch-card-id="b-test"] [data-footer-status]')) || '';
        await shotCard(page, 'b-test', 'single-service-rebuild.png');
        check(await page.getAttribute('[data-branch-card-id="b-test"]', 'data-deploy-phase') === 'start', '单服务重建认作「启动容器」段');
        check(/01:0\d/.test(tickA) && tickA !== tickB, `单服务重建时钟从部署开始时刻起走（「${tickA.trim()}」→「${tickB.trim()}」）`);

        // 单服务进入就绪探测：分支仍 running、只有 api 在 starting。阶段不能消失（Codex P2）。
        const oneReady = { ...oneSvc, services: services(22331, 'running', { api: { status: 'starting' } }) };
        branches = branches.map((b) => (b.id === oneReady.id ? oneReady : b));
        await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), oneReady);
        await page.waitForTimeout(600);
        const readyPhase = await page.getAttribute('[data-branch-card-id="b-test"]', 'data-deploy-phase');
        check(readyPhase === 'ready', `单服务就绪探测仍显示「就绪探测」段（实际 ${readyPhase}）`);

        const erroredCount = async () => {
          const text = (await page.textContent('[data-testid="branch-overview-bar"] h2')) || '';
          const m = text.match(/(\d+)\s*个出错需要处理/);
          return { n: m ? Number(m[1]) : 0, text: text.trim() };
        };
        const erroredBefore = await erroredCount();
        // 单服务部署失败：api 落 error，其余服务健康、分支仍 running。不许播「部署成功」（Codex P1）。
        const oneFailed = {
          ...oneSvc,
          services: services(22331, 'running', { api: { status: 'error', errorMessage: '就绪探测超时（120 秒内 /health 未返回 200）' } }),
        };
        branches = branches.map((b) => (b.id === oneFailed.id ? oneFailed : b));
        await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), oneFailed);
        await page.waitForTimeout(900);
        const partialPhase = await page.getAttribute('[data-branch-card-id="b-test"]', 'data-deploy-phase');
        const partialFooter = (await page.textContent('[data-branch-card-id="b-test"] [data-footer-status]')) || '';
        const redeployVisible = await page.isVisible('[data-branch-card-id="b-test"] button[aria-label^="重新部署"]');
        await shotCard(page, 'b-test', 'single-service-failed.png');
        check(partialPhase === 'failed', `单服务部署失败进入失败态（实际 data-deploy-phase=${partialPhase}）`);
        check(/构建失败/.test(partialFooter) && /就绪探测/.test(partialFooter), `单服务失败页脚写「构建失败 · 在「就绪探测」」（实际「${partialFooter.trim()}」）`);
        check(redeployVisible, '单服务失败时直接给出「重新部署」');
        const erroredAfter = await erroredCount();
        check(erroredAfter.n === erroredBefore.n + 1, `单服务失败计入页头「出错需要处理」（${erroredBefore.n} → ${erroredAfter.n}，「${erroredAfter.text}」）`);
        // 数完再刷新（前面几步只推给了页面、没写回合成数据的状态，刷新后会复原）。
        // 刷新页面：没有「刚才那次翻转」可看了，卡片仍要从服务状态认出失败（Codex P1）。
        await page.reload();
        await page.waitForSelector('[data-branch-card-id="b-test"]', { timeout: 30000 });
        await page.waitForTimeout(1200);
        const reloadPhase = await page.getAttribute('[data-branch-card-id="b-test"]', 'data-deploy-phase');
        const reloadRedeploy = await page.isVisible('[data-branch-card-id="b-test"] button[aria-label^="重新部署"]');
        await shotCard(page, 'b-test', 'single-service-failed-after-reload.png');
        check(reloadPhase === 'failed' && reloadRedeploy, `刷新后单服务失败卡仍按出错呈现（data-deploy-phase=${reloadPhase}，重新部署按钮${reloadRedeploy ? '在' : '不在'}）`);

        // 极速版等 CI 镜像时旧版本在跑，CI 失败后等镜像这一段结束：不是一次部署，不许播「部署成功」（Codex P1）。
        const ciFailed = { ...branches.find((b) => b.id === 'b-edison'), ciImageStatus: 'failed' };
        branches = branches.map((b) => (b.id === ciFailed.id ? ciFailed : b));
        await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), ciFailed);
        await page.waitForTimeout(900);
        const ciPhase = await page.getAttribute('[data-branch-card-id="b-edison"]', 'data-deploy-phase');
        const ciFooter = (await page.textContent('[data-branch-card-id="b-edison"] footer')) || '';
        check(ciPhase !== 'done' && !/部署成功/.test(ciFooter), `CI 失败结束等镜像不播「部署成功」（实际 data-deploy-phase=${ciPhase}）`);

        // 一键重启：原地重启容器，没有构建。回到运行中时不许播「部署成功」（Codex P2）。
        const restarting = { ...oneSvc, status: 'restarting', services: services(22331, 'starting') };
        branches = branches.map((b) => (b.id === restarting.id ? restarting : b));
        await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), restarting);
        await page.waitForTimeout(600);
        // 部署没走完就转成重启：结束的是一次重启，不是那次部署。
        check(await page.getAttribute('[data-branch-card-id="b-test"]', 'data-deploy-phase') === 'restarting', '一键重启显示单段「正在重启」');
        await shotCard(page, 'b-test', 'restarting.png');
        const restarted = { ...restarting, status: 'running', services: services(22331, 'running') };
        branches = branches.map((b) => (b.id === restarted.id ? restarted : b));
        await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), restarted);
        await page.waitForTimeout(900);
        const afterRestart = await page.getAttribute('[data-branch-card-id="b-test"]', 'data-deploy-phase');
        check(afterRestart !== 'done', `重启结束不播「部署成功」（实际 data-deploy-phase=${afterRestart}）`);

        // 单服务部署跑完、容器起来了，但分支状态没落盘（接口报错）：卡片离开部署阶段，不许播「部署成功」（Codex P2）
        {
          const fBuild = { ...restarted, services: services(22331, 'running', { api: { status: 'building' } }), lastDeployStartedAt: iso(-30_000) };
          branches = branches.map((b) => (b.id === fBuild.id ? fBuild : b));
          await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), fBuild);
          await page.waitForTimeout(600);
          const fDone = { ...fBuild, services: services(22331, 'running') };
          branches = branches.map((b) => (b.id === fDone.id ? fDone : b));
          await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId, stateFlushFailed: true }), fDone);
          await page.waitForTimeout(900);
          const fPhase = await page.getAttribute('[data-branch-card-id="b-test"]', 'data-deploy-phase');
          const fFooter = (await page.textContent('[data-branch-card-id="b-test"] footer')) || '';
          check(fPhase !== 'done' && fPhase !== 'start' && !/部署成功/.test(fFooter),
            `状态落盘失败的那次部署不播「部署成功」，也不停在部署阶段（实际 data-deploy-phase=${fPhase}）`);
          // 标记只属于那一条事件：接下来一次正常部署照常播「部署成功」
          const nBuild = { ...fDone, services: services(22331, 'running', { api: { status: 'building' } }), lastDeployStartedAt: iso(-20_000) };
          branches = branches.map((b) => (b.id === nBuild.id ? nBuild : b));
          await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), nBuild);
          await page.waitForTimeout(600);
          const nDone = { ...nBuild, services: services(22331, 'running') };
          branches = branches.map((b) => (b.id === nDone.id ? nDone : b));
          await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), nDone);
          await page.waitForTimeout(900);
          const nPhase = await page.getAttribute('[data-branch-card-id="b-test"]', 'data-deploy-phase');
          check(nPhase === 'done', `落盘失败之后的下一次正常部署照常播「部署成功」（实际 data-deploy-phase=${nPhase}）`);
        }

        // 混合模式分支正在等 CI 镜像，这时手动部署一个源码服务：阶段条按源码三段走，不被等镜像那一段锁成极速版（Codex P2）
        {
          const mixedRuntime = { kind: 'mixed', label: '混合', title: '', activeProfiles: 13, releaseProfiles: 12, sourceProfiles: 1, modes: ['prebuilt', 'source'], prebuilt: true, prebuiltProfileIds: PROFILES.filter((id) => id !== 'api') };
          const waiting = { ...branches.find((b) => b.id === 'b-edison'), deployRuntime: mixedRuntime, ciImageStatus: 'waiting', ciWaitingSince: iso(-30_000), status: 'running', services: services(22705, 'running') };
          branches = branches.map((b) => (b.id === waiting.id ? waiting : b));
          await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), waiting);
          await page.waitForTimeout(600);
          const waitPhase = await page.getAttribute('[data-branch-card-id="b-edison"]', 'data-deploy-phase');
          const manual = { ...waiting, status: 'building', services: services(22705, 'running', { api: { status: 'building' } }), lastDeployStartedAt: iso(-5_000) };
          branches = branches.map((b) => (b.id === manual.id ? manual : b));
          await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), manual);
          await page.waitForTimeout(600);
          const manualPhase = await page.getAttribute('[data-branch-card-id="b-edison"]', 'data-deploy-phase');
          check(waitPhase === 'ci-waiting' && manualPhase === 'build',
            `等 CI 镜像时手动部署源码服务，阶段条从「等镜像」换成源码「构建」（${waitPhase} → ${manualPhase}）`);
          // 耗时预计取源码样本（10 分钟），不取发布版样本（1 分钟）：已用 2 分钟不该报「超出预计」（Codex P2）
          {
            const withEstimate = { ...manual, lastDeployStartedAt: iso(-120_000), deployEstimate: { releaseMedianMs: 60_000, releaseSamples: 5, sourceMedianMs: 600_000, sourceSamples: 5 } };
            branches = branches.map((b) => (b.id === withEstimate.id ? withEstimate : b));
            await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), withEstimate);
            await page.waitForTimeout(700);
            const etaText = (await page.textContent('[data-branch-card-id="b-edison"] [data-footer-status]')) || '';
            // 从页脚反推取的是哪个样本桶的中位（源码 10 分钟、发布版 1 分钟）
            const secs = (t) => { const [m, sec] = t.split(':').map(Number); return m * 60 + sec; };
            // 先去掉「2/3」这种步数，它和紧跟的用时之间没有空格
            const times = [...etaText.replace(/\d\/\d/, ' ').matchAll(/(\d+:\d{2})/g)].map((m) => secs(m[1]));
            const over = /超出预计/.test(etaText);
            // 未超时是「已用 / 约 预计」，第二个数就是中位；超时是「已用 · 超出预计 X」，中位 = 已用 − X
            const median = times.length >= 2 ? (over ? times[0] - times[1] : times[1]) : NaN;
            check(Math.abs(median - 600) <= 2,
              `混合分支只重建源码服务时，耗时预计按源码样本（推得中位 ${median}s，「${etaText.trim()}」）`);
            // 计时从这次部署开始算（2 分钟前），不从很久以前的 lastAccessedAt 算（Codex P2）
            check(times.length >= 1 && times[0] >= 100 && times[0] <= 180,
              `从运行中分支单独部署时，计时从本次部署开始（已用 ${times[0]}s，「${etaText.trim()}」）`);
          }
          // 手动部署跑完、CI 仍在等：回到「等镜像」。之后 CI 失败，不许把刚才那次部署播成「部署成功」（Codex P2）
          const backToWait = { ...manual, status: 'running', services: services(22705, 'running') };
          branches = branches.map((b) => (b.id === backToWait.id ? backToWait : b));
          await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), backToWait);
          await page.waitForTimeout(600);
          const backPhase = await page.getAttribute('[data-branch-card-id="b-edison"]', 'data-deploy-phase');
          const ciFailedAfter = { ...backToWait, ciImageStatus: 'failed' };
          branches = branches.map((b) => (b.id === ciFailedAfter.id ? ciFailedAfter : b));
          await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), ciFailedAfter);
          await page.waitForTimeout(900);
          const afterCiFail = await page.getAttribute('[data-branch-card-id="b-edison"]', 'data-deploy-phase');
          const afterCiFooter = (await page.textContent('[data-branch-card-id="b-edison"] footer')) || '';
          check(backPhase === 'ci-waiting' && afterCiFail !== 'done' && !/部署成功/.test(afterCiFooter),
            `部署跑完回到等镜像、随后 CI 失败：不把旧部署播成「部署成功」（${backPhase} → ${afterCiFail}）`);
          // 等镜像期间手动重部署的服务失败了（分支因其余服务仍是 running）：失败优先，卡片按出错呈现（Codex P2）
          const waitAgain = { ...ciFailedAfter, ciImageStatus: 'waiting', ciWaitingSince: iso(-10_000) };
          branches = branches.map((b) => (b.id === waitAgain.id ? waitAgain : b));
          await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), waitAgain);
          await page.waitForTimeout(500);
          const failWhileWaiting = { ...waitAgain, services: services(22705, 'running', { api: { status: 'error', errorMessage: '就绪探测超时' } }) };
          branches = branches.map((b) => (b.id === failWhileWaiting.id ? failWhileWaiting : b));
          await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), failWhileWaiting);
          await page.waitForTimeout(700);
          const failPhase = await page.getAttribute('[data-branch-card-id="b-edison"]', 'data-deploy-phase');
          const failRedeploy = await page.isVisible('[data-branch-card-id="b-edison"] button[aria-label^="重新部署"]');
          check(failPhase !== 'ci-waiting' && failRedeploy,
            `等 CI 镜像期间服务失败：卡片按出错呈现并给出「重新部署」（data-deploy-phase=${failPhase}，重新部署按钮${failRedeploy ? '在' : '不在'}）`);
        }

        // 出错的分支重新部署：旧服务的 error 还没被覆盖时，页头与卡片一样算「在构建」，不算「出错」（Codex P2）
        {
          const overviewText = async () => ((await page.textContent('[data-testid="branch-overview-bar"] h2')) || '').trim();
          const count = (text, re) => Number((text.match(re) || [])[1] || 0);
          const before = await overviewText();
          const retrying = { ...branches.find((b) => b.id === 'b-scan'), status: 'building', lastDeployStartedAt: iso(-10_000) };
          branches = branches.map((b) => (b.id === retrying.id ? retrying : b));
          await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), retrying);
          await page.waitForTimeout(700);
          const after = await overviewText();
          const cardPhase = await page.getAttribute('[data-branch-card-id="b-scan"]', 'data-deploy-phase');
          check(cardPhase === 'build' && count(after, /(\d+)\s*个出错需要处理/) === count(before, /(\d+)\s*个出错需要处理/) - 1
            && count(after, /(\d+)\s*个在构建/) === count(before, /(\d+)\s*个在构建/) + 1,
            `出错分支重试时页头与卡片一致算「在构建」（「${before}」→「${after}」）`);
        }

        // 已删配置留下的僵尸条目带着镜像拉取错误，当前服务是编译失败：出错类别按当前服务算「应用代码错误」（Codex P2）
        {
          const main = branches.find((b) => b.id === 'b-main');
          const zombieMix = {
            ...main,
            status: 'running',
            errorMessage: undefined,
            services: {
              ...services(22000, 'running', { api: { status: 'error', errorMessage: 'error TS2322: Type string is not assignable to number' } }),
              'legacy-gw': { profileId: 'legacy-gw', containerName: 'fixture-legacy-gw', hostPort: 22999, status: 'error', errorMessage: 'image pull access denied: repository does not exist' },
            },
          };
          branches = branches.map((b) => (b.id === zombieMix.id ? zombieMix : b));
          await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), zombieMix);
          await page.waitForTimeout(700);
          const cardText = (await page.textContent('[data-branch-card-id="b-main"]')) || '';
          check(/应用代码错误/.test(cardText) && !/CDS 运行时错误/.test(cardText),
            `出错类别不被已删配置的僵尸条目带偏（${/应用代码错误/.test(cardText) ? '应用代码错误' : /CDS 运行时错误/.test(cardText) ? 'CDS 运行时错误' : '无标签'}）`);
        }

        // 「已停止」分组收起时定位其中一张卡（搜索下拉 / cds:focus-branch）：要先展开分组，卡片真的滚进视野（Codex P2）。
        await page.evaluate(() => window.scrollTo(0, 0));
        const toggle = page.locator('section[aria-label="未运行的分支"] > div > button[aria-expanded]').first();
        if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
        await page.waitForTimeout(300);
        // 同时开着标签筛选：main 既被筛掉、又在收起的分组里（Codex P2：已停止判定不能取筛选后的列表）
        await page.click('button[title="按 #登录重构 过滤"]');
        await page.waitForTimeout(300);
        const hiddenBefore = (await page.$('[data-branch-card-id="b-main"]')) === null;
        await page.setViewportSize({ width: WIDTH, height: 500 });
        await page.evaluate((pid) => window.dispatchEvent(new CustomEvent('cds:focus-branch', { detail: { branchId: 'b-main', projectId: pid } })), PROJECT_ID);
        await page.waitForTimeout(1200);
        const focused = await page.evaluate(() => {
          const el = document.querySelector('[data-branch-card-id="b-main"]');
          if (!el) return { mounted: false, inView: false };
          const r = el.getBoundingClientRect();
          return { mounted: true, inView: r.bottom > 0 && r.top < window.innerHeight };
        });
        check(hiddenBefore && focused.mounted && focused.inView, `收起的「已停止」分组里定位卡片：展开并滚进视野（收起时${hiddenBefore ? '未渲染' : '已渲染'}，定位后${focused.mounted ? '已渲染' : '未渲染'}、${focused.inView ? '在视野内' : '不在视野内'}）`);
        await page.setViewportSize({ width: WIDTH, height: 1180 });

        // 从停止状态单独部署一个服务：分支仍是 idle、只有 api 在 building。它在部署，不许留在收起的「未运行」分组里被藏起来（Codex P2）。
        await page.click('button[title="清除过滤"]').catch(() => undefined);
        await page.waitForTimeout(300);
        if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
        await page.waitForTimeout(300);
        const relaxedHidden = (await page.$('[data-branch-card-id="b-relaxed"]')) === null;
        const relaxedDeploying = { ...branches.find((b) => b.id === 'b-relaxed'), services: services(24300, 'stopped', { api: { status: 'building' } }) };
        await page.evaluate((b) => window.__cdsFire('branch.updated', { branch: b, projectId: b.projectId }), relaxedDeploying);
        await page.waitForTimeout(700);
        const relaxedShown = await page.evaluate(() => {
          const el = document.querySelector('[data-branch-card-id="b-relaxed"]');
          return { mounted: Boolean(el), inDormant: Boolean(el?.closest('section[aria-label="未运行的分支"]')) };
        });
        check(relaxedHidden && relaxedShown.mounted && !relaxedShown.inDormant,
          `停止的分支单独部署一个服务时离开收起的「未运行」分组（部署前${relaxedHidden ? '被收起' : '可见'}，部署中${relaxedShown.mounted ? '已渲染' : '未渲染'}${relaxedShown.inDormant ? '、仍在未运行分组' : ''}）`);
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
