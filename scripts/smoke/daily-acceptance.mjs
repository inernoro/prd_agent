#!/usr/bin/env node
/**
 * 每日关键功能验收 —— 断言「产物真的出现在屏幕上」，不是「代码写对了」。
 *
 * 为什么需要它：2026-08-23~25 白屏缺陷连续三轮才修好，而仓库里 1500+ 条测试全绿。
 * 原因是那些测试测的都是源码与纯函数，而白屏的形态恰恰是**源码全对、产物没出来**。
 * 能测红它的判据只有一条：**iframe 里真的有字**。
 *
 * 同期还漏掉一个「看得见点不动」——批量勾选框被 hover 条整条盖住。它躲过所有检查，
 * 是因为程序化 `.click()` 会绕过命中测试。所以这里的交互一律走**真实指针序列**。
 *
 * 用法：
 *   node scripts/smoke/daily-acceptance.mjs --base http://127.0.0.1:7801 [--json out.json]
 *
 * --base 指向**能被浏览器打开**的地址。沙箱里公网域名浏览器直连会 ERR_CONNECTION_RESET，
 * 先用 .claude/skills/sandbox-net 起两跳隧道，再把 --base 指到本地端口。
 *
 * 凭据只从环境变量取（MAP_USER / MAP_PASSWORD），不写进文件、不打印。
 * 退出码：0 全过 / 1 有用例红 / 2 参数或前置条件问题（这种不算「功能坏了」）。
 *
 * 已排进计划任务：Routine `trig_017sNsVhR9oSVa5SKbVLwC8i`「每日关键功能验收（网页托管）」，
 * 每天 01:05 UTC（北京时间 09:05）在一个全新会话里跑，失败推送 + 邮件。
 * 被测环境钉死在 https://main-prd-agent.miduo.org（main 分支预览）——不跟着功能分支跑，
 * 否则分支一合并这条例程就永远拿不到地址。同一环境上还有 48 小时一轮的稳定冒烟
 * （Routine `trig_01ALxMepdiLx49Qhw3ZdvoXC`，走 .claude/skills/stable-smoke）。
 * 两者分工：本脚本管「产物有没有出现」的快判据，稳定冒烟管全业务线的双环境矩阵。
 * 改 cron 或停用走 claude.ai 的 Routines 界面，或让 agent 调 update_trigger / delete_trigger。
 *
 * 加一条用例的成本：往 FORMS 加一行（形态类），或往主流程加一个 checkXxx（交互类）。
 * 加之前先问一句：**这条断言能被测红吗？** 不能测红的用例比没有更糟——
 * 它会让下一个人以为这件事已经验过了。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
const KEEP = process.argv.includes('--keep-fixtures');
if (!BASE) {
  console.error('必填：--base <浏览器能打开的地址>');
  process.exit(2);
}
if (!process.env.MAP_USER || !process.env.MAP_PASSWORD) {
  console.error('缺少 MAP_USER / MAP_PASSWORD 环境变量 —— 没有登录态就只能测到匿名那一层，等于没测。');
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

/** 验收用的站点形态。加一种形态 = 加一行，不用改流程。
 *  html 与 markdown 是本次事故的两条真实分叉（前者走 srcDoc、后者曾被判据排除掉）。 */
const FORMS = [
  {
    key: 'html',
    title: '[每日验收] HTML 站',
    file: 'acceptance-html.html',
    body: '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>验收 HTML</title></head>'
      + '<body><h1>每日验收 · HTML 站</h1><p>这一段文字就是判据：它必须出现在分享页的 iframe 里。</p>'
      + '<p>如果这里是空的，说明托管站点的渲染链断了。</p></body></html>',
    minChars: 30,
  },
  {
    key: 'markdown',
    title: '[每日验收] Markdown 站',
    file: 'acceptance-md.md',
    body: '# 每日验收 · Markdown 站\n\n这一段文字就是判据：它必须出现在分享页的 iframe 里。\n\n'
      + '- MD 站会被后端包装成一层 HTML 壳子\n- 这层壳子曾经被判据一刀切排除，导致整页白屏\n\n'
      + '> 如果这里是空的，说明包装站的取正文链路又断了。\n',
    minChars: 30,
  },
];

/**
 * 页面级「有没有东西」判据。按业务功能台账（stable-smoke/reference/business-function-catalog.json）
 * 里的 P0 功能线挑，再按真实数据量排序 —— 只挑读路径，写入与计费类不放进日常例程
 * （生图/视频要花钱、要清理，属于 48 小时那一轮的事）。
 *
 * anchor 是这一屏「渲染成功才会出现」的字样。选常驻文案，不要选依赖数据的字段：
 * 数据一变判据就假红，假红几次之后没人再看这份报告。
 */
const PAGES = [
  { key: 'shell',      route: '/',               anchor: null,     minChars: 60, label: '导航与应用外壳' },
  { key: 'web-pages',  route: '/web-pages',      anchor: '网页托管', minChars: 80, label: '网页托管主控台' },
  { key: 'doc-store',  route: '/document-store', anchor: null,     minChars: 60, label: '知识库 / 文件解析' },
  { key: 'defect',     route: '/defect-agent',   anchor: null,     minChars: 60, label: '缺陷管理' },
  { key: 'visual',     route: '/visual-agent',   anchor: null,     minChars: 60, label: '视觉创作' },
];

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '[通过]' : '[失败]'} ${name}${detail ? ` —— ${detail}` : ''}`);
};

async function api(pathname, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: payload });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null, text }; }
}

async function login() {
  const r = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { username: process.env.MAP_USER, password: process.env.MAP_PASSWORD, clientType: 'admin' },
  });
  const d = r.json?.data;
  if (!r.json?.success || !d?.accessToken) {
    throw new Error(`登录失败（HTTP ${r.status}）：${r.json?.error?.message || '无响应体'}`);
  }
  return d;
}

/** 找到（或建出）这一形态的验收站点。复用已有的，避免每天堆一堆垃圾站点。 */
async function ensureSite(token, form) {
  // 按标题让服务端筛，不要拉一页回来自己找。
  // 这里原先写的是 `?pageSize=200`——而这个端点的参数叫 `limit`，`pageSize` 被直接忽略，
  // 实际只拿回默认的 50 条最新站点。等验收站点被新站点挤出这 50 条，这里就找不到它，
  // 于是每天再建一个同名的：账号越攒越脏，而且验收的是随便哪一个重名副本。
  // keyword 走服务端正则匹配 Title，不受窗口大小影响。
  const q = new URLSearchParams({ keyword: form.title, limit: '200' });
  const list = await api(`/api/web-pages?${q}`, { token });
  const hit = (list.json?.data?.items || []).find((s) => s.title === form.title);
  if (hit) return hit;

  const tmp = path.join(os.tmpdir(), form.file);
  fs.writeFileSync(tmp, form.body);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(tmp)]), form.file);
  fd.append('title', form.title);
  const up = await api('/api/web-pages/upload', { method: 'POST', token, form: fd });
  if (!up.json?.success) throw new Error(`上传 ${form.key} 验收站点失败：${up.json?.error?.message || up.status}`);
  return up.json.data;
}

/** 找到（或建出）一条**公开**分享链接：验收要覆盖匿名访客真正走的那条路。 */
async function ensureShare(token, site) {
  // 这个端点不分页（只认 includeRevoked），原先带的 pageSize 是句空话，去掉免得误导下一个人。
  const mine = await api('/api/web-pages/shares', { token });
  const hit = (mine.json?.data?.items || []).find(
    (l) => l.siteId === site.id && l.visibility === 'public' && !l.isRevoked && !l.isExpired,
  );
  if (hit) return hit;
  const created = await api('/api/web-pages/share', {
    method: 'POST', token,
    body: { siteId: site.id, shareType: 'single', title: site.title, expiresInDays: 30, visibility: 'public', forceNew: true },
  });
  if (!created.json?.success) throw new Error(`建分享链接失败：${created.json?.error?.message || created.status}`);
  return created.json.data;
}

/** 分享页的产物判据：iframe 不能停在 about:blank，里面必须真的有字。 */
async function checkShareArtifact(ctx, form, token4Url) {
  const page = await ctx.newPage();
  const bad = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.startsWith(BASE) && r.status() >= 400) bad.push(`${r.status()} ${u.slice(BASE.length).slice(0, 60)}`);
  });
  page.on('pageerror', (e) => bad.push(`pageerror: ${e.message.slice(0, 60)}`));
  await page.goto(`${BASE}/s/wp/${token4Url}`, { waitUntil: 'domcontentloaded' });
  // LLM 无关的静态站点，但服务端要去 COS 取原文；给足时间，别用超时假装成失败
  await page.waitForTimeout(12000);
  const probe = await page.evaluate(() => {
    const f = document.querySelector('iframe');
    if (!f) return { mode: 'no-iframe', chars: 0 };
    const mode = f.getAttribute('srcdoc') != null ? 'srcDoc' : (f.getAttribute('src') ? 'direct' : 'about:blank');
    let chars = null;
    try { chars = f.contentDocument?.body?.innerText?.replace(/\s+/g, '').length ?? null; } catch { chars = 'cross-origin'; }
    return { mode, chars };
  });
  await page.close();

  const ok = probe.mode !== 'about:blank' && probe.mode !== 'no-iframe'
    && (typeof probe.chars === 'number' ? probe.chars >= form.minChars : probe.mode === 'direct');
  record(
    `分享页产物可见 · ${form.key}`,
    ok && bad.length === 0,
    `mode=${probe.mode} 正文字数=${probe.chars}${bad.length ? ` 异常=${bad.slice(0, 2).join(' / ')}` : ''}`,
  );
}

/**
 * 主控台的批量勾选：必须用真实指针序列。
 * 程序化 `.click()` 会绕过命中测试 —— 上一次就是这样让「勾选框被 hover 条盖死」溜过去的。
 */
async function checkCheckboxHittable(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/web-pages`, { waitUntil: 'domcontentloaded' });
  // 等元素本身出现，别拿一个固定秒数当「加载好了」：8s 在慢一点的那次就不够，
  // 报出来是「页面上找不到勾选框」——一条会随网络快慢翻来翻去的判据，比没有更糟。
  const box = await page.waitForSelector('button[aria-label="选择"]', { timeout: 25000, state: 'visible' })
    .then((h) => h.boundingBox())
    .catch(() => null);
  if (!box) {
    record('主控台勾选框可点（真实指针）', false, '等了 25s 页面上仍然没有勾选框');
    await page.close();
    return;
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const railHead = await page.evaluate(() => {
    const aside = [...document.querySelectorAll('aside')].pop();
    return (aside?.innerText || '').split('\n')[0] || '';
  });
  await page.close();
  record('主控台勾选框可点（真实指针）', railHead.includes('选中的站点'), `右栏首行「${railHead}」`);
}

/**
 * 分享入口：点卡片上的「分享」必须就地展开下拉，而且下拉里得有能拿到链接的东西。
 *
 * 这是网页托管最常走的那条路（分享是这个功能存在的理由）。同样用真实指针序列：
 * 下拉锚在 hover 条里的按钮上，程序化点击既不触发 hover 也绕过命中测试，
 * 测出来的绿灯不作数。
 */
async function checkSharePopover(ctx) {
  const page = await ctx.newPage();
  const bad = [];
  page.on('pageerror', (e) => bad.push(e.message.slice(0, 60)));
  await page.goto(`${BASE}/web-pages`, { waitUntil: 'domcontentloaded' });

  const card = await page.waitForSelector('[data-hoverbar]', { timeout: 25000 })
    .then((h) => h.boundingBox())
    .catch(() => null);
  if (!card) {
    record('分享下拉能打开（真实指针）', false, '等了 25s 页面上仍然没有站点卡');
    await page.close();
    return;
  }
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.waitForTimeout(400);
  const btn = await page.locator('button[aria-label="分享"], button[aria-label^="管理分享"]').first().boundingBox().catch(() => null);
  if (!btn) {
    record('分享下拉能打开（真实指针）', false, 'hover 条里找不到分享按钮');
    await page.close();
    return;
  }
  await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(1200);

  const text = await page.evaluate(() => document.body.innerText);
  await page.close();
  // 两种形态都算开：没链接时是「生成链接并复制」，有链接时是那几行设置
  const opened = text.includes('生成链接并复制') || text.includes('谁能打开');
  record('分享下拉能打开（真实指针）', opened && bad.length === 0,
    opened ? (bad.length ? `但有 JS 异常：${bad[0]}` : '') : '点完没有下拉文案');
}

/**
 * 一屏「打开了但是空的」判据。
 * 只断言三件事：正文有字、自家域名没有 4xx、没有 pageerror。
 * 不断言具体数字或条数 —— 那些随数据变，会制造假红。
 */
async function checkPageAlive(ctx, page4) {
  const page = await ctx.newPage();
  const bad = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.startsWith(BASE) && r.status() >= 400) bad.push(`${r.status()} ${u.slice(BASE.length).slice(0, 50)}`);
  });
  page.on('pageerror', (e) => bad.push(`pageerror: ${e.message.slice(0, 50)}`));
  await page.goto(`${BASE}${page4.route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ''));
  await page.close();

  const enough = text.length >= page4.minChars;
  const anchored = !page4.anchor || text.includes(page4.anchor.replace(/\s+/g, ''));
  record(
    `页面产物可见 · ${page4.label}`,
    enough && anchored && bad.length === 0,
    `正文${text.length}字${page4.anchor ? ` 锚点${anchored ? '命中' : '缺失'}` : ''}${bad.length ? ` 异常=${bad.slice(0, 2).join(' / ')}` : ''}`,
  );
}

// ── 主流程 ──
let exitCode = 0;
try {
  const session = await login();
  console.log(`登录成功：${session.user?.username}`);

  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const auth = {
    state: {
      isAuthenticated: true, user: session.user, token: session.accessToken,
      refreshToken: session.refreshToken, sessionKey: session.sessionKey,
      permissions: [], permissionsLoaded: false, isRoot: session.user?.role === 'ADMIN', menuCatalog: [],
    },
    version: 0,
  };
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: 'prd-admin-auth', value: JSON.stringify(auth) }] }] },
  });

  for (const form of FORMS) {
    try {
      const site = await ensureSite(session.accessToken, form);
      const share = await ensureShare(session.accessToken, site);
      await checkShareArtifact(ctx, form, share.token);
    } catch (e) {
      record(`分享页产物可见 · ${form.key}`, false, `前置失败：${e.message}`);
    }
  }

  for (const p4 of PAGES) {
    try { await checkPageAlive(ctx, p4); } catch (e) { record(`页面产物可见 · ${p4.label}`, false, e.message.slice(0, 80)); }
  }

  await checkCheckboxHittable(ctx);
  await checkSharePopover(ctx);
  await ctx.close();
  await browser.close();
} catch (e) {
  record('前置：登录 / 浏览器', false, e.message);
  exitCode = 2;
}

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 条，失败 ${failed.length} 条`);
if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 1));
  console.log(`明细：${JSON_OUT}`);
}
if (!KEEP) console.log('（验收站点会复用，不重复创建；要清理就去主控台删掉标题带「[每日验收]」的那几个）');
if (failed.length && exitCode === 0) exitCode = 1;
process.exit(exitCode);
