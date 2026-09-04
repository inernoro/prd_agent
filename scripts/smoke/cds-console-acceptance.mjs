#!/usr/bin/env node
/**
 * CDS 控制台 · 每日关键功能验收 —— 断言「产物真的出现在屏幕上」，且**窄屏也算数**。
 *
 * 为什么需要它（两个缺口，第二个才是根本的）：
 *
 * 1. 每日视觉验收此前只覆盖 MAP（scripts/smoke/daily-acceptance.mjs 打
 *    main-prd-agent.miduo.org），CDS 控制台从来没有任何一条日常判据看着。
 * 2. 更要命的是那条例程**只跑 1600x1000 一个桌面视口**。也就是说整条 loop
 *    从来没有任何一个窄屏档——哪怕对 MAP 也一样。2026-09-04 用户在手机上撞到
 *    「接入 Agent 向导步骤 03 没有下一步、也滑不动」，PR #1487 修掉了它并给
 *    CDS 仓库补了 per-PR 的真浏览器判据，但那些判据跑在离线合成数据上，
 *    证明不了**线上这一版**在窄屏能用。这个脚本补的是后半句。
 *
 * 判据形状（三条并列，缺一不可）：
 *   - 路由独有的正文锚点命中；
 *   - 全局错误边界文案「页面渲染异常」缺席；
 *   - 该 origin 下没有 4xx/5xx 响应、没有 pageerror。
 *
 * 第二条是实测加进来的：本地拿合成数据跑时，/overview 与 /reports 明明已经
 * 「页面渲染异常」，面包屑 `CDS / 概览` 却照常渲染。所以**面包屑不能当锚点**，
 * 而错误边界必须单独断言——否则一个崩掉的页面会被判成绿的。
 *
 * 锚点怎么选（选错就等于没判据，这一点在 PR #1487 里栽过四次）：
 *   - 必须是这条路由自己的正文字样，不能是外壳。CDS 控制台的外壳常驻文案是
 *     `项目 发布 任务 报告 状态 Agent 缺陷 设置 黑天 账号` 加面包屑与搜索框，
 *     取其中任何一个，路由渲不渲染都命中。
 *   - 本文件里的锚点都经过一次交叉核对：它们各自只出现在对应页面的 lazy chunk
 *     里（ProjectListPage-*.js / ReleaseCenterPage-*.js / …），也就是说按构造
 *     只有那条路由加载时才可能出现。源码侧的机械守卫见
 *     scripts/tests/cds-console-acceptance-anchors.test.mjs。
 *
 * 用法：
 *   node scripts/smoke/cds-console-acceptance.mjs --base http://127.0.0.1:7901 [--json out.json]
 *
 * --base 指向**能被浏览器打开**的地址。沙箱里公网域名浏览器直连会
 * ERR_CONNECTION_RESET，先用 .claude/skills/sandbox-net 起两跳隧道，
 * 再把 --base 指到本地端口。
 *
 * 凭据只从环境变量取（CDS_USERNAME / CDS_PASSWORD），不写进文件、不打印。
 * 登录走 POST /api/login（生产实例是 basic 模式，会话 cookie 名 cds_token；
 * github 模式下的 /api/auth/login 在生产上是 404，前端自己也做同样的回退）。
 *
 * 退出码：0 全过 / 1 有用例红 / 2 参数或前置条件问题（这种不算「功能坏了」）。
 *
 * **只读**：本脚本在生产控制台上不做任何写操作。上手向导只走到步骤 04 的渲染
 * 为止——`advance(1/2/3)` 是纯本地状态，只有步骤 04 的「生成我的上手包」会调
 * POST /api/projects/:id/agent-profile，那一步永远不点。加用例时请守住这条线。
 *
 * 加一条用例的成本：往 PAGES 加一行。加之前先问一句：**这条断言能被测红吗？**
 * 不能测红的用例比没有更糟——它会让下一个人以为这件事已经验过了。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(path.join(process.cwd(), 'noop.js'));
let chromium;
try {
  ({ chromium } = require_('playwright-core'));
} catch {
  try { ({ chromium } = require_('playwright')); } catch { /* 下面统一报 */ }
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : process.argv[i + 1];
}
const BASE = (arg('--base') || '').replace(/\/$/, '');
const JSON_OUT = arg('--json', null);
if (!BASE) {
  console.error('必填：--base <浏览器能打开的地址>');
  process.exit(2);
}
if (!process.env.CDS_USERNAME || !process.env.CDS_PASSWORD) {
  console.error('缺少 CDS_USERNAME / CDS_PASSWORD 环境变量 —— 没有登录态就只能测到登录页，等于没测。');
  process.exit(2);
}
if (!chromium) {
  console.error('找不到 playwright-core。这条验收必须真的开浏览器，装不上就如实报失败，不要降级成 curl。');
  process.exit(2);
}
const CHROME = process.env.CHROME_BIN
  || (fs.existsSync('/opt/pw-browsers')
    ? fs.readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-'))
      .map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find((p) => fs.existsSync(p))
    : undefined);

/** 全局错误边界的文案。它出现 = 这一屏其实崩了，哪怕外壳与面包屑照常渲染。 */
const ERROR_BOUNDARY = '页面渲染异常';

/**
 * 页面级判据。anchor 必须是这条路由自己的正文字样（见文件头「锚点怎么选」）。
 * route 支持 `{projectId}` 占位，运行时用真实项目 ID 替换——写死一个 ID
 * 会在项目被删掉那天变成假红。
 */
const PAGES = [
  { key: 'project-list',  route: '/project-list',           anchor: '资源占用',   label: '项目列表' },
  { key: 'branch-list',   route: '/branches/{projectId}',   anchor: '分支操作',   label: '分支列表' },
  { key: 'cds-settings',  route: '/cds-settings',           anchor: '权限总览',   label: 'CDS 系统设置' },
  { key: 'release-center', route: '/release-center',        anchor: '全环境矩阵', label: '发布中心' },
];

/**
 * 视口。窄屏这一档是本脚本存在的核心理由——旧例程只有桌面一档。
 * 390x844 对齐用户报缺陷时那台机器的尺寸。
 */
const VIEWPORTS = [
  { key: 'desktop', label: '桌面', width: 1440, height: 900 },
  { key: 'mobile',  label: '窄屏', width: 390,  height: 844 },
];

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '[通过]' : '[失败]'} ${name}${detail ? ` —— ${detail}` : ''}`);
};

/** 登录拿会话 cookie。返回可直接塞进 Playwright context 的 cookie 数组。 */
async function login() {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.CDS_USERNAME, password: process.env.CDS_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`登录失败（HTTP ${res.status}）—— 生产实例的登录端点是 /api/login（basic 模式）`);
  }
  // Node 的 fetch 把多个 Set-Cookie 合成一条，用 getSetCookie() 才拿得到全部。
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  const host = new URL(BASE).hostname;
  const cookies = raw
    .map((line) => {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx < 0) return null;
      return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), domain: host, path: '/' };
    })
    .filter(Boolean);
  if (!cookies.some((c) => c.name === 'cds_token')) {
    throw new Error('登录响应里没有 cds_token —— 鉴权模式可能变了，判据需要跟着改，不要跳过');
  }
  return cookies;
}

/** 取一个真实项目 ID。用列表第一个，而不是写死——写死的那天项目被删就变假红。 */
async function firstProjectId(cookies) {
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const res = await fetch(`${BASE}/api/projects`, { headers: { cookie: cookieHeader } });
  if (!res.ok) throw new Error(`取项目列表失败（HTTP ${res.status}）`);
  const body = await res.json();
  const list = body?.data?.projects || body?.projects || body?.data || [];
  const id = Array.isArray(list) && list.length ? (list[0].id || list[0].projectId) : null;
  if (!id) throw new Error('项目列表为空 —— 没有项目就没什么可验收的，这本身值得报出来');
  return id;
}

/**
 * 一屏的存活判据。三条并列：锚点命中 + 错误边界缺席 + 无 4xx/5xx / pageerror。
 * 窄屏另加一条横向溢出——窄屏最常见的坏法就是内容把页面撑宽、右半截摸不到。
 */
async function checkPage(ctx, page4, viewport, projectId) {
  const route = page4.route.replace('{projectId}', encodeURIComponent(projectId));
  const name = `${viewport.label} · ${page4.label}`;
  const page = await ctx.newPage();
  const bad = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.startsWith(BASE) && r.status() >= 400) bad.push(`${r.status()} ${u.slice(BASE.length).slice(0, 48)}`);
  });
  page.on('pageerror', (e) => bad.push(`pageerror: ${e.message.slice(0, 48)}`));

  let hit = false;
  let read = { chars: 0, boundary: false, overflow: 0 };
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // 等锚点真的出现，而不是干等固定秒数：慢的路由别被冤枉，快的路由别白等。
    const needle = page4.anchor.replace(/\s+/g, '');
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const r = await page.evaluate((n) => {
        const t = (document.body.innerText || '').replace(/\s+/g, '');
        return { hit: t.includes(n), chars: t.length };
      }, needle);
      if (r.hit) { hit = true; break; }
      await page.waitForTimeout(500);
    }
    read = await page.evaluate((boundary) => ({
      chars: (document.body.innerText || '').replace(/\s+/g, '').length,
      boundary: (document.body.innerText || '').includes(boundary),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }), ERROR_BOUNDARY);
  } catch (e) {
    bad.push(`导航失败: ${String(e.message || e).slice(0, 60)}`);
  }
  await page.close();

  const overflowed = viewport.key === 'mobile' && read.overflow > 2;
  const ok = hit && !read.boundary && bad.length === 0 && !overflowed;
  const detail = [
    `正文${read.chars}字`,
    `锚点「${page4.anchor}」${hit ? '命中' : '缺失（等了 25 秒）'}`,
    read.boundary ? `错误边界「${ERROR_BOUNDARY}」出现` : null,
    overflowed ? `横向溢出 ${read.overflow}px` : null,
    bad.length ? `异常=${bad.slice(0, 2).join(' / ')}` : null,
  ].filter(Boolean).join(' ');
  record(`页面产物可见 · ${name}`, ok, detail);
}

/*
 * 上手向导的窄屏可达性 —— 用户 2026-09-04 撞到的就是这一屏。
 *
 * 出口定位收敛成一个函数，量测与点击共用：两处各写一份找法就会出现
 * 「量的是 A、点的是 B」（predicate-and-wiring-discipline 形状 3）。
 */
const LOCATE_EXIT = `(exit) => {
  const flat = (s) => (s || '').replace(/\\s+/g, '');
  if (exit.button) {
    return Array.from(document.querySelectorAll('button'))
      .find((b) => flat(b.textContent).includes(flat(exit.button))) || null;
  }
  const rx = new RegExp(exit.card);
  return Array.from(document.querySelectorAll('button'))
    .filter((b) => b.getBoundingClientRect().height > 40)
    .find((b) => rx.test(b.textContent)) || null;
}`;

/**
 * 只走到步骤 04 的渲染为止。步骤 04 的「生成我的上手包」是唯一的写操作
 * （POST /api/projects/:id/agent-profile），生产上永远不点。
 */
const WIZARD_STEPS = [
  { id: '01', exit: { card: '经验', label: '经验档卡片' }, advance: true },
  { id: '02', exit: { card: '产品|前端|后端|全栈|测试|运维', label: '角色卡片' }, advance: true },
  { id: '03', exit: { button: '确认这些技能' }, advance: true },
  { id: '04', exit: { button: '生成我的上手包' }, advance: false },
];

async function checkWizardMobile(ctx, projectId) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/branches/${encodeURIComponent(projectId)}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);

    const entryVisible = await page.locator('[aria-label="接入 Agent"]:visible').count();
    if (!entryVisible) {
      record('窄屏 · 上手向导入口可见', false, '页面上找不到可见的「接入 Agent」入口——判据跑不起来，不当作通过');
      await page.close();
      return;
    }
    record('窄屏 · 上手向导入口可见', true, `找到 ${entryVisible} 个可见入口`);
    await page.locator('[aria-label="接入 Agent"]:visible').first().click({ timeout: 15000 });
    await page.waitForTimeout(1500);

    for (const step of WIZARD_STEPS) {
      const box = await page.evaluate(
        ([src, exit]) => {
          const locate = eval(src);
          const el = locate(exit);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) };
        },
        [LOCATE_EXIT, step.exit],
      );
      const label = step.exit.label || step.exit.button;
      if (!box) {
        record(`窄屏 · 向导步骤 ${step.id} 出口`, false, `找不到出口「${label}」——判据跑不起来，不当作通过`);
        break;
      }
      // 四边都要在视口内：只查上下的话，出口被横向推出屏幕照样全绿。
      const inBox = box.top >= 0 && box.bottom <= 844 && box.left >= 0 && box.right <= 390;
      record(
        `窄屏 · 向导步骤 ${step.id} 出口「${label}」`,
        inBox,
        `rect top=${box.top} bottom=${box.bottom} left=${box.left} right=${box.right}（视口 390x844）`,
      );
      if (!inBox || !step.advance) break;
      // 真实指针点击：合成 el.click() 会绕过命中测试，出口被浮层盖住照样能往下走。
      await page.evaluate(
        ([src, exit]) => { const el = eval(src)(exit); if (el) el.scrollIntoView({ block: 'center' }); },
        [LOCATE_EXIT, step.exit],
      );
      const clickable = step.exit.button
        ? page.locator(`button:has-text("${step.exit.button}")`).first()
        : page.locator('button').filter({ hasText: new RegExp(step.exit.card) }).first();
      await clickable.click({ timeout: 15000 });
      await page.waitForTimeout(1200);
    }
  } catch (e) {
    record('窄屏 · 上手向导可达性', false, `跑不完：${String(e.message || e).slice(0, 90)}`);
  }
  await page.close();
}

// ── 主流程 ──
let exitCode = 0;
let browser = null;
try {
  const cookies = await login();
  console.log(`登录成功：${process.env.CDS_USERNAME}`);
  const projectId = await firstProjectId(cookies);
  console.log(`取样项目：${projectId}`);

  browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  for (const viewport of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    // url 形式让 Playwright 自己推 domain/path，避免隧道下 host 与目标域不一致时对不上。
    await ctx.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, url: BASE })));
    for (const p of PAGES) await checkPage(ctx, p, viewport, projectId);
    if (viewport.key === 'mobile') await checkWizardMobile(ctx, projectId);
    await ctx.close();
  }
} catch (e) {
  record('前置条件', false, String(e.message || e).slice(0, 160));
  exitCode = 2;
} finally {
  if (browser) await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 条，失败 ${failed.length} 条`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, results }, null, 2));
if (exitCode !== 2) exitCode = failed.length ? 1 : 0;
process.exit(exitCode);
