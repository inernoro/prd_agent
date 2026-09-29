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
  const expressRuntime = { kind: 'release', label: '极速版', title: '', activeProfiles: 13, releaseProfiles: 13, sourceProfiles: 0, modes: ['prebuilt'], prebuilt: true };
  return [
    base('b-main', 'main', {
      status: 'idle', services: services(22000, 'stopped'),
      lastStopSource: 'webhook', lastStopReason: 'GitHub webhook 触发停止', lastStoppedAt: iso(-18 * 60 * MIN),
      lastDeployAt: iso(-20 * 60 * MIN),
    }),
    base('b-test', 'test', {
      status: 'running', services: services(22331, 'running'),
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
  { id: 'rabbitmq', name: 'rabbitmq', dockerImage: 'rabbitmq:3-management', containerPort: 5672, hostPort: 10488, status: 'running' },
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
      const phases = Object.fromEntries(rows.flatMap((r) => r.list).map((c) => [c.id, c.phase]));
      check(phases['b-pack'] === 'queued', `[${theme}] 排队卡 data-deploy-phase=queued（实际 ${phases['b-pack']}）`);
      check(phases['b-edison'] === 'ci-waiting', `[${theme}] 等镜像卡 data-deploy-phase=ci-waiting（实际 ${phases['b-edison']}）`);
      check(phases['b-ident'] === 'ready', `[${theme}] 就绪探测卡 data-deploy-phase=ready（实际 ${phases['b-ident']}）`);
      const metaTimes = await page.$$eval('[data-branch-card-id="b-pack"], [data-branch-card-id="b-ident"]', (els) => els.map((el) => el.textContent || ''));
      check(metaTimes.every((t) => /最近推送/.test(t)), `[${theme}] 构建中卡片右侧有「最近推送」时间`);
      for (const f of await footerTruncation(page)) {
        check(!f.clipped, `[${theme}] ${f.id} 页脚构建文字没被截断：「${f.text}」`);
      }
      await page.screenshot({ path: path.join(OUT, `grid-${theme}.png`), fullPage: true });

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
            const ordered = opacities.length === 3 && opacities[0] > opacities[1] && opacities[1] > opacities[2];
            check(ordered, `端口依次点亮（800ms 时三个 chip 不透明度 ${opacities.map((o) => o.toFixed(2)).join(' > ')}）`);
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
