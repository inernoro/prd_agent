#!/usr/bin/env node
/*
 * 「接入 Agent」上手向导的窄屏可达性判据。
 *
 * 为什么要用真浏览器：这一屏的既有守卫（tests/web/agent-starter-skill-library-contract）
 * 只能扫源码，能证明「主按钮写在 JSX 里」，证明不了「主按钮在手机上够不够得着」。
 * 2026-09-03 用户在手机上打开步骤 03，屏幕上没有任何前进出口，也滑不动——
 * 当时按钮确实在 DOM 里（源码守卫全绿），rect 却落在 y=961、视口只有 844，
 * 而整条祖先链上没有一个可滚容器。编译、类型、单测、源码守卫全都拦不住，
 * 只有真浏览器量得出来。
 *
 * 判据（每一步的主操作 = 这一步唯一的前进出口）：
 *   1. 硬判据 inViewport —— 不滚动就看得见。这就是「有没有下一步」本身。
 *   2. 兜底判据 reachable —— 万一 1 挂了，至少要能滚到，绝不允许「既看不见又滚不到」。
 * 两条都报，因为窄屏 CSS 里那条兜底 overflow-y:auto 会让 2 恒真——只看 2
 * 的话，高度链再断一次照样全绿（predicate-and-wiring-discipline 形状 4a）。
 *
 * 红绿闭环：删掉 index.css 里 `[data-agent-starter-slot='true']` 那条选择器
 * （窄屏高度链的一环），四档视口的 step03 立刻在硬判据上变红。
 *
 * 用法：node scripts/agent-starter-mobile-probe.mjs [baseUrl]
 * 不给 baseUrl 就自己起一个 vite dev server（需要 cds/web 已装依赖）。
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../web');

function loadPlaywright() {
  // 沙箱与 CI 装 playwright 的位置不同，允许显式指定（同 mobile-layout-smoke.mjs）。
  const candidates = [process.env.PWPATH, 'playwright', 'playwright-core'].filter(Boolean);
  const failures = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      failures.push(`${candidate}: ${err.message}`);
    }
  }
  throw new Error(`找不到 Playwright。已尝试 ${failures.join('; ')}`);
}

/** 真机常见的窄屏档；640 是窄屏样式的断点，四档都在它以下。 */
const VIEWPORTS = [
  { label: '360x640', width: 360, height: 640 },
  { label: '390x660', width: 390, height: 660 },
  { label: '390x844', width: 390, height: 844 },
  { label: '430x760', width: 430, height: 760 },
];

/*
 * 向导每一步的主操作。null 表示这一步靠点卡片前进，卡片本身就是出口。
 * 判据锁的是「这一步有没有前进出口」这个不变量，不锁按钮长什么样。
 */
const STEPS = [
  { id: '01', heading: '你希望 Agent 怎么跟你说话？', action: null, advance: { card: '经验' } },
  { id: '02', heading: '你主要负责什么？', action: null, advance: { card: '产品|前端|后端|全栈|测试|运维' } },
  { id: '03', heading: '带上哪些工作方法？', action: '确认这些技能', advance: { button: '确认这些技能' } },
  { id: '04', heading: '改完以后，怎么交给你？', action: '生成我的上手包', advance: { button: '生成我的上手包' } },
  { id: '05', heading: '你的 Agent 上手包已经配好', action: '复制启动提示词', advance: null },
];

const clickButton = (page, text) => page.evaluate((t) => {
  const flat = (s) => s.replace(/\s+/g, '');
  const btn = Array.from(document.querySelectorAll('button')).find((b) => flat(b.textContent).includes(flat(t)));
  if (!btn) return false;
  btn.click();
  return true;
}, text);

const clickCard = (page, pattern) => page.evaluate((src) => {
  const rx = new RegExp(src);
  const btn = Array.from(document.querySelectorAll('button'))
    .filter((b) => b.getBoundingClientRect().height > 40)
    .find((b) => rx.test(b.textContent));
  if (!btn) return false;
  btn.click();
  return true;
}, pattern);

const measure = (page, action, heading) => page.evaluate(([t, h]) => {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const flat = (s) => s.replace(/\s+/g, '');
  const onStep = Array.from(document.querySelectorAll('h4,h3,div,span'))
    .some((e) => e.textContent.trim() === h);
  const overflowX = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw;
  if (!t) return { onStep, overflowX, action: null };

  const btn = Array.from(document.querySelectorAll('button')).find((b) => flat(b.textContent).includes(flat(t)));
  if (!btn) return { onStep, overflowX, action: t, found: false };

  const before = btn.getBoundingClientRect();
  const inViewport = before.height > 0 && before.top >= 0 && before.bottom <= vh;
  // 兜底：有没有任何祖先能把它滚进来。滚完要还原，免得污染后续步骤的量测。
  const scrollers = [];
  for (let a = btn.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const s = getComputedStyle(a);
    if (/auto|scroll/.test(s.overflowY) && a.scrollHeight > a.clientHeight + 1) {
      scrollers.push({ el: (a.className || a.tagName).toString().slice(0, 40), top: a.scrollTop });
    }
  }
  btn.scrollIntoView({ block: 'nearest' });
  const after = btn.getBoundingClientRect();
  const reachable = after.height > 0 && after.top >= 0 && after.bottom <= vh;
  return {
    onStep, overflowX, action: t, found: true,
    top: Math.round(before.top), bottom: Math.round(before.bottom),
    inViewport, reachable,
    scrollers: scrollers.map((s) => s.el),
  };
}, [action, heading]);

async function startDevServer() {
  const port = 5100 + Math.floor(Math.random() * 400);
  const child = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: WEB_DIR, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite dev server 30s 没起来')), 30000);
    const onData = (buf) => {
      if (buf.toString().includes('ready in') || buf.toString().includes(String(port))) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`vite 退出，code=${code}`)); });
  });
  // dev server 首个请求要现编译，给它一点时间。
  await new Promise((r) => setTimeout(r, 1500));
  return { url, stop: () => child.kill('SIGTERM') };
}

async function main() {
  const explicitBase = process.argv[2];
  const server = explicitBase ? { url: explicitBase.replace(/\/+$/, ''), stop: () => {} } : await startDevServer();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--no-proxy-server'],
    executablePath: process.env.CDS_CHROMIUM_PATH || undefined,
  });

  const failures = [];
  try {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await page.goto(`${server.url}/probe.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1200);

      for (const step of STEPS) {
        const m = await measure(page, step.action, step.heading);
        const problems = [];
        if (!m.onStep) problems.push(`没停在这一步（找不到标题「${step.heading}」）`);
        if (m.overflowX > 2) problems.push(`横向溢出 ${m.overflowX}px`);
        if (step.action) {
          if (!m.found) problems.push(`找不到主操作「${step.action}」`);
          else {
            if (!m.reachable) problems.push(`主操作「${step.action}」既看不见也滚不到（top=${m.top}，视口高 ${vp.height}）`);
            else if (!m.inViewport) problems.push(`主操作「${step.action}」不在视口里，要先滚动才看得见（top=${m.top}，视口高 ${vp.height}）`);
          }
        }
        const label = `${vp.label} step${step.id}`;
        if (problems.length) {
          failures.push(`${label}: ${problems.join('；')}`);
          console.log(`FAIL ${label} ${problems.join('；')}`);
        } else {
          const detail = step.action ? `「${step.action}」 top=${m.top} 视口内` : '靠点卡片前进';
          console.log(`PASS ${label} ${detail}`);
        }
        if (step.advance) {
          const advanced = step.advance.button
            ? await clickButton(page, step.advance.button)
            : await clickCard(page, step.advance.card);
          if (!advanced) {
            failures.push(`${label}: 点不动，走不到下一步`);
            console.log(`FAIL ${label} 点不动，走不到下一步`);
            break;
          }
          await page.waitForTimeout(600);
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.stop();
  }

  if (failures.length) {
    console.error(`\n${failures.length} 处窄屏可达性问题：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nALL PASS 上手向导每一步的主操作在四档窄屏下都不滚动就可见');
}

main().catch((err) => {
  console.error(`FAIL ${err.stack || err.message}`);
  process.exit(1);
});
