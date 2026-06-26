// MAP 验收 · 模拟人类浏览器取证 harness（项目无关）
// 核心约束（见 reference/standard-v2.md §4）：
//   - 禁止 page.goto 直达业务页；登录后用 gotoByClick 点击导航进入
//   - 按可见文本/role 定位，不按写死 index
//   - 截图带 caption，1440x900 @2x，支持双主题
//
// 用法：写一个 driver.mjs，import 这些 helper 拼出本次验收的"真人路径"。
// 运行：PWPATH=$(npm root -g)/playwright node driver.mjs

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const PW = process.env.PWPATH || '/opt/node22/lib/node_modules/playwright';
const { chromium } = require(PW);

export function loadConfig(path) {
  return JSON.parse(require('fs').readFileSync(path, 'utf8'));
}

export async function launch(cfg, opts = {}) {
  // 每次新会话清空模块级累积：同一 Node 进程内多次 launch（批量验收 / 自测）若不清空，会把上一轮的
  // shots / autoFindings 串进本轮 → result.json 混入历史 P0/P1、stale blocker 误折叠进新 manifest，
  // 造成误拒收或机读输出失真（Bugbot #4，2026-06-04）。launch 是文档化入口，在此重置最稳妥。
  shots.length = 0;
  autoFindings.length = 0;
  const session = _bumpCaptureSession(); // 令旧会话残留监听器失效（Bugbot #6）
  const sc = cfg.screenshot || {};
  // 代理环境（云端/CI 出口代理）：仅当显式设置 ACC_BROWSER_PROXY 时给 Chromium 配代理，
  // 不影响本地直连运行。TLS 由出口代理重签，浏览器需信任其 CA（云端镜像已注入 NSS 信任）。
  const launchOpts = { args: ['--no-sandbox', '--disable-setuid-sandbox'] };
  if (process.env.ACC_BROWSER_PROXY) launchOpts.proxy = { server: process.env.ACC_BROWSER_PROXY };
  const browser = await chromium.launch(launchOpts);
  // opts.viewport 允许调用方覆盖视口（手机端验收时传 {width:390,height:844}）。
  const vp = opts.viewport || { width: sc.width || 1440, height: sc.height || 900 };
  const ctxOpts = {
    viewport: vp,
    deviceScaleFactor: sc.deviceScaleFactor || 2,
    ignoreHTTPSErrors: true, // 出口代理证书
    ...(opts.isMobile ? { isMobile: true, hasTouch: true } : {}),
  };
  // v1.0（issue #605 二.1）：可选过程视频。比 N 张静态图更能让人 3 秒看懂"它怎么走的"。
  // 开法：launch(cfg, { recordVideoDir: outDir }) 或 cfg.screenshot.recordVideoDir。归档作可选附件。
  const videoDir = opts.recordVideoDir || sc.recordVideoDir;
  if (videoDir) {
    require('fs').mkdirSync(videoDir, { recursive: true });
    ctxOpts.recordVideo = { dir: videoDir, size: { width: sc.width || 1440, height: sc.height || 900 } };
  }
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  // v1.0（issue #605 二.2 / 楼上一致共识）：默认挂上 console/network/pageerror 自动捕获——
  // 这是"人眼扫静态图永远漏的维度"，最该让机器补。driver 无需手动开，launch 即装。
  attachAutoCapture(page, { ...(opts.autoCapture || {}), _session: session });
  return { browser, ctx, page };
}

// 登录（走表单，不注入 token）。返回登录后 URL。
export async function login(page, baseUrl, cfg) {
  const b = cfg.auth.browser;
  const user = process.env[b.userEnv];
  const pass = process.env[b.passEnv];
  if (!user || !pass) throw new Error(`缺少登录凭据：请设置 env ${b.userEnv} 和 ${b.passEnv}`);
  // 归一化 baseUrl：cdscli --human preview-url 带结尾 '/'，baseUrl + '/login' 会变成 '//login'
  // 命中 SPA 兜底，登录框永不出现（实测坑：登录 20s 超时 + API 拿到 HTML）。统一去掉结尾斜杠。
  baseUrl = String(baseUrl).replace(/\/+$/, '');
  await page.goto(baseUrl + b.loginPath, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector(b.userSelector, { timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.fill(b.userSelector, user);
  await page.fill(b.passSelector, pass);
  await page.click(b.submitSelector);
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return page.url();
}

// 模拟人类导航：点击可见文本进入目标页。禁止 goto 直达。
// 找不到入口本身就是一条缺陷（P1）——返回 {found:false} 让 driver 记录。
export async function gotoByClick(page, navText, { timeout = 8000 } = {}) {
  const sel = `a:has-text("${navText}"), button:has-text("${navText}"), [role=link]:has-text("${navText}"), [role=button]:has-text("${navText}"), [role=tab]:has-text("${navText}"), nav :text("${navText}")`;
  const loc = page.locator(sel).first();
  try {
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click({ timeout });
    await page.waitForTimeout(2000);
    return { found: true, navText };
  } catch {
    // 兜底：很多可点目标是 div/卡片（无 a/button/role 语义），上面的选择器点不到（实测坑：
    // 知识库空间卡片就是可点 div）。改按可见文本点击——点中文本节点，click 冒泡到卡片 onClick。
    // 先精确匹配，再退子串匹配。
    for (const opt of [{ exact: true }, { exact: false }]) {
      try {
        const byText = page.getByText(navText, opt).first();
        await byText.waitFor({ state: 'visible', timeout: Math.min(timeout, 4000) });
        await byText.click({ timeout });
        await page.waitForTimeout(2000);
        return { found: true, navText, via: `getByText(${opt.exact ? 'exact' : 'loose'})` };
      } catch { /* 试下一种匹配 */ }
    }
    return { found: false, navText };
  }
}

export async function click(page, text, { timeout = 8000 } = {}) {
  const loc = page.locator(`button:has-text("${text}"), a:has-text("${text}"), [role=button]:has-text("${text}"), [role=tab]:has-text("${text}")`).first();
  try {
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click({ timeout });
    await page.waitForTimeout(1500);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text, error: e.message };
  }
}

export async function type(page, selector, text, { clear = true } = {}) {
  if (clear) await page.fill(selector, '');
  await page.fill(selector, text);
}

// 切主题（best-effort）：设 data-theme 属性。应用不支持亮色时调用方截单张并注明。
export async function setTheme(page, mode, cfg) {
  const attr = (cfg.screenshot && cfg.screenshot.themeAttr) || 'data-theme';
  await page.evaluate(([a, m]) => { try { document.documentElement.setAttribute(a, m); } catch (e) {} }, [attr, mode]);
  await page.waitForTimeout(800);
}

export async function assertText(page, text) {
  return (await page.locator(`text=${JSON.stringify(text)}`).count()) > 0;
}

// 截图 + caption。返回 {name, caption, path} 供归档脚本消费。
// v2.2: 自动 waitForReady() 等页面真就绪，截后再 validate；不达标 retry 1 次后仍记录但打 warning。
const shots = [];

function repoRoot() {
  try {
    return require('child_process').execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function assertOutsideRepo(targetPath, label) {
  if (process.env.ALLOW_REPO_ACCEPTANCE_ARTIFACTS === '1') return;
  const pathMod = require('path');
  const root = repoRoot();
  if (!root) return;
  const abs = pathMod.resolve(targetPath);
  const rel = pathMod.relative(pathMod.resolve(root), abs);
  if (rel === '' || (!rel.startsWith('..') && !pathMod.isAbsolute(rel))) {
    throw new Error(`${label} 位于 git 仓库内：${abs}。验收截图、manifest、录屏必须写到 /tmp 或对象存储，避免污染代码库。`);
  }
}

// ── v1.0：console / network / pageerror 自动捕获（issue #605 二.2，机器最该补的维度）──
// 每条 finding: { kind, severity, message, url?, status?, ts, shotIndexAtCapture }
// 自动判级（保守，避免误杀）：
//   - pageerror（未捕获 JS 异常）          → P0（页面真崩了）
//   - 5xx 响应（同源 app 自己的接口）       → P0（后端炸了）
//   - console.error                        → P1（前端报错，多半 bug，但可能第三方噪声）
//   - 4xx 响应（同源，排除 401/403/404 探测）→ P1
// blockSeverity（默认 'P0'）：≥ 此级别的 finding 会自动 attach 成"截图 warning"，
//   从而被 archive_report.py 准入校验拒收（把"机器抓到的严重错误"变成硬门禁）。
//   P1/P2 仍记进 result.json 供报告引用，但不硬阻断（避免一条第三方 console 噪声卡死整轮）。
const autoFindings = [];
let _autoCaptureCfg = { blockSeverity: 'P0', ignore: [], appHostHint: null };
// 会话令牌（Bugbot #6）：launch() 每次自增。旧 page 的监听器闭包记下它注册时的 session，
// 一旦发生新 launch（session 变了），旧监听器 push 全部失效——无需 detach/关旧浏览器即可
// 杜绝"上一轮还开着的页面把事件灌进本轮 autoFindings"的串扰。
let _captureSession = 0;
export function _bumpCaptureSession() { return ++_captureSession; }

const SEV_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
function _sevGte(a, b) { return SEV_RANK[a] <= SEV_RANK[b]; } // P0 ≥ P1 ⇒ rank 更小

// 解析"本源 host"：appHostHint 优先，否则取当前 page host。解析不出返回 null（调用方据此保守跳过）。
function _resolveAppHost(page) {
  if (_autoCaptureCfg.appHostHint) return _autoCaptureCfg.appHostHint;
  try { const h = new URL(page.url()).host; return h || null; } catch { return null; }
}

export function attachAutoCapture(page, opts = {}) {
  _autoCaptureCfg = {
    blockSeverity: opts.blockSeverity || 'P0',
    ignore: (opts.ignore || []).map((p) => (p instanceof RegExp ? p : new RegExp(p))),
    appHostHint: opts.appHostHint || null,
  };
  const mySession = opts._session != null ? opts._session : _captureSession;
  const ignored = (s) => _autoCaptureCfg.ignore.some((re) => re.test(s || ''));

  const push = (f) => {
    if (mySession !== _captureSession) return; // 旧会话的残留监听器失效（Bugbot #6）
    if (ignored(f.message) || ignored(f.url || '')) return;
    autoFindings.push({ ...f, ts: Date.now(), shotIndexAtCapture: shots.length });
  };

  // 1) 未捕获 JS 异常 → P0
  page.on('pageerror', (err) => {
    push({ kind: 'pageerror', severity: 'P0', message: String(err && err.message || err).slice(0, 300) });
  });

  // 2) console.error → P1（只收 error，不收 warning，减少噪声）
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // 浏览器对 4xx/5xx 自带的 "Failed to load resource" 噪声留给 response 处理器统一判级
    if (/Failed to load resource/i.test(text)) return;
    push({ kind: 'console.error', severity: 'P1', message: text.slice(0, 300) });
  });

  // 3) 网络 4xx/5xx（仅同源 app 自己的接口；第三方/静态 CDN 不计）
  page.on('response', (resp) => {
    const status = resp.status();
    if (status < 400) return;
    const url = resp.url();
    let host = '';
    try { host = new URL(url).host; } catch { return; }
    const appHost = _resolveAppHost(page);
    // 无法确定本源（about:blank / 无效 URL / 还没导航）→ 保守不记网络类 finding，
    // 否则会把第三方/CDN 的 4xx-5xx 当成本源错误，制造假 P0/P1 blocker（Bugbot #5）。
    if (!appHost) return;
    if (host !== appHost) return; // 跨域第三方资源不计
    // 401/403/404 常是探测/鉴权预检，降噪：4xx 里只有这三类不直接判级（除非 5xx）
    let severity;
    if (status >= 500) severity = 'P0';
    else if ([401, 403, 404].includes(status)) return; // 高噪声，跳过
    else severity = 'P1';
    push({ kind: 'network', severity, status, url: url.slice(0, 200), message: `HTTP ${status} ${url.slice(0, 160)}` });
  });

  // 4) 请求彻底失败（DNS / 连接 reset 等）→ P1
  page.on('requestfailed', (req) => {
    const url = req.url();
    let host = '';
    try { host = new URL(url).host; } catch { return; }
    const appHost = _resolveAppHost(page);
    if (!appHost) return;        // 无法确定本源 → 保守不记（Bugbot #5）
    if (host !== appHost) return;
    // 忽略主动 abort（SPA 取消的 fetch 很常见）
    const failure = req.failure();
    if (failure && /aborted|ERR_ABORTED/i.test(failure.errorText || '')) return;
    push({ kind: 'requestfailed', severity: 'P1', url: url.slice(0, 200), message: `请求失败 ${failure && failure.errorText} ${url.slice(0, 140)}` });
  });
}

// 取出"自某次截图后新产生的 findings"，并按 blockSeverity 折叠成截图 warning 文案。
function drainFindingsForShot(shotIndex) {
  const blockers = autoFindings.filter(
    (f) => f.shotIndexAtCapture === shotIndex && _sevGte(f.severity, _autoCaptureCfg.blockSeverity) && !f._attached,
  );
  blockers.forEach((f) => { f._attached = true; });
  return blockers.map((f) => `自动捕获(${f.severity},${f.kind}): ${f.message}`);
}

export function findings() { return autoFindings; }

// ── v1.0：主题能力探测（issue #605 二.2 楼上：dark-only 页"双主题强制"是伪命令）──
// 设 light 后采样 body 背景亮度；若与 dark 几乎无差，则该页 light-only/dark-only，
// driver 据此单图取证 + 注明，不被逼交两张一模一样的图、也不计 fail。
export async function detectThemeSupport(page, cfg) {
  const attr = (cfg && cfg.screenshot && cfg.screenshot.themeAttr) || 'data-theme';
  // 记录探测前的主题；探测结束必须恢复，否则页面被遗留在 light（最后一次 setAttribute）——
  // driver 探测后若未显式 setTheme 就截图会截到错主题，违反 §5.4（Bugbot #2，2026-06-04）。
  const original = await page.evaluate(([a]) => document.documentElement.getAttribute(a), [attr]);
  const lum = async () => page.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor || 'rgb(0,0,0)';
    const m = bg.match(/\d+/g) || [0, 0, 0];
    const [r, g, b] = m.map(Number);
    return 0.299 * r + 0.587 * g + 0.114 * b; // 0(黑)~255(白)
  });
  await page.evaluate(([a]) => document.documentElement.setAttribute(a, 'dark'), [attr]);
  await page.waitForTimeout(400);
  const darkLum = await lum();
  await page.evaluate(([a]) => document.documentElement.setAttribute(a, 'light'), [attr]);
  await page.waitForTimeout(400);
  const lightLum = await lum();
  const delta = Math.abs(lightLum - darkLum);
  // 亮度差 < 24 视为"切了主题但没变"——该页不真支持双主题
  const supportsLight = delta >= 24;
  // 忠实恢复探测前状态：原本就没有该属性的页面（如 report-agent 把"无属性"当 dark，prd-admin 同理）
  // 必须 removeAttribute 还原，而非写死 'dark'——写 'dark' 会给"无属性=dark"的页面凭空加上属性，
  // 让后续截图主题与真实默认态偏离（Bugbot #3，2026-06-04）。
  await page.evaluate(([a, m]) => {
    if (m === null) document.documentElement.removeAttribute(a);
    else document.documentElement.setAttribute(a, m);
  }, [attr, original]);
  await page.waitForTimeout(200);
  return { supportsLight, darkLum: Math.round(darkLum), lightLum: Math.round(lightLum), delta: Math.round(delta), restoredTheme: original === null ? '(removed)' : original };
}

// ── v1.0：导航 timing（issue #605 二.5，呼应 CLAUDE §6 禁止空白等待）──
export async function captureTiming(page) {
  try {
    return await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      if (!nav) return null;
      return {
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
        load: Math.round(nav.loadEventEnd),
        firstByte: Math.round(nav.responseStart),
      };
    });
  } catch { return null; }
}

/**
 * 截图前主动等"页面真就绪"，截图后做内容校验。
 * 调用方仍可手动 waitForTimeout 强化等待；本函数是兜底，让"忘了等"也不至于截一张半成品。
 *
 * 就绪判定（三层 AND）：
 *  1. networkidle:500ms 内无网络请求（最多等 8s，超时不阻塞）
 *  2. 已知 loader 元素消失（[aria-busy="true"], .skeleton, .skeleton-loader, .map-spinner,
 *     .animate-pulse, [data-loading="true"], `text=加载中`, `text=Loading`）
 *  3. body 可见文本 ≥ 100 字（防"白屏 / 仅有空容器"）
 *
 * 截图后校验：
 *  - 文件大小 < 8KB 视为空白图（黑屏 / 1px 大小）—— 警告
 *  - body text 含明显失败词（"Cannot GET" / "Application Error" / "500 Internal"）—— 警告
 *  - 满足 expectText 选项时断言文本命中（精确锁住"这张图证明了什么"）
 */
export async function waitForReady(page, { timeout = 12000, minTextLen = 100, customLoaderSelectors = [] } = {}) {
  const t0 = Date.now();
  // 1) networkidle（最多等 8s；超时不抛错，继续走下游）
  try {
    await page.waitForLoadState('networkidle', { timeout: Math.min(8000, timeout) });
  } catch { /* 慢站/长轮询页面允许超时 */ }

  // 2) loader 消失（已知模式 + 调用方追加）
  const loaderSelectors = [
    '[aria-busy="true"]',
    '.skeleton',
    '.skeleton-loader',
    '.map-spinner',
    '.animate-pulse',
    '[data-loading="true"]',
    ...customLoaderSelectors,
  ];
  const loaderRe = /^(加载中|Loading|Loading\.+|正在加载|载入中|请稍候)/;
  const remaining = timeout - (Date.now() - t0);
  try {
    await page.waitForFunction(
      ({ selectors, reSource }) => {
        const re = new RegExp(reSource);
        // 任一 loader selector 还可见 → false
        for (const s of selectors) {
          const el = document.querySelector(s);
          if (el && el.offsetParent !== null) return false;
        }
        // 任一可见元素的 textContent 命中 loader 文案 → false
        const all = document.querySelectorAll('div, span, p, button');
        for (const el of all) {
          if (el.offsetParent === null) continue;
          const t = (el.textContent || '').trim();
          if (t && t.length < 30 && re.test(t)) return false;
        }
        return true;
      },
      { selectors: loaderSelectors, reSource: loaderRe.source },
      { timeout: Math.max(1000, remaining), polling: 200 },
    );
  } catch { /* 部分应用 loader 长期残留（如 keepalive 心跳），不阻塞 */ }

  // 3) 内容下限（防白屏）
  try {
    await page.waitForFunction(
      (min) => {
        const t = (document.body && document.body.innerText) || '';
        return t.trim().length >= min;
      },
      minTextLen,
      { timeout: Math.max(800, timeout - (Date.now() - t0)), polling: 150 },
    );
  } catch { /* 失败也不抛错，下游 validate 会把这种识别为问题 */ }

  // 微稳定窗：让 CSS transition / 渐入动画落幕（截到不正在变化的帧）
  await page.waitForTimeout(400);
}

/**
 * 截图后内容校验。命中失败词 / 太空 / 文件过小都记录 warning 到返回值。
 * expectText: 字符串或正则，断言截图时页面 body 文本中应包含此内容。
 */
async function validateShot(page, path, expectText) {
  const warnings = [];
  const fs = require('fs');
  try {
    const size = fs.statSync(path).size;
    if (size < 8 * 1024) warnings.push(`文件过小 ${size}B（疑似白屏/黑屏）`);
  } catch { warnings.push('截图文件读取失败'); }

  let bodyText = '';
  try { bodyText = await page.locator('body').innerText(); } catch {}
  if (!bodyText || bodyText.trim().length < 60) warnings.push('页面文本过少（< 60 字，疑似未渲染）');

  const failureKeywords = ['Cannot GET', 'Application Error', 'Internal Server Error', 'NS_ERROR', 'ChunkLoadError', 'preview is not ready', '502 Bad Gateway', '503 Service Unavailable'];
  for (const k of failureKeywords) {
    if (bodyText.includes(k)) warnings.push(`页面含失败关键字: ${k}`);
  }

  if (expectText) {
    const ok = expectText instanceof RegExp ? expectText.test(bodyText) : bodyText.includes(expectText);
    if (!ok) warnings.push(`expectText 未命中: ${expectText}`);
  }

  // 版式健康自动护栏（2026-06-02 反哺）：检测开启的 modal/弹窗是否「撑破」视口。
  // 根因：一次 CDS「一键部署项目」弹窗内容飞出视口顶部、主操作按钮够不到，验收却被判 PASS——
  // 因为旧 validateShot 只查"功能在不在"，不查"版式正不正"。frontend-modal.md / issues-system §5.2
  // 明确 Modal 撑破 = P0。这里把它变成每张图都跑的自动检查，杜绝靠人眼漏判。
  try {
    const layout = await page.evaluate(() => {
      const vh = window.innerHeight;
      const sels = ['[role="dialog"]', '[aria-modal="true"]', '.modal', '.cds-modal', '.ReactModal__Content'];
      const seen = new Set();
      for (const s of sels) {
        for (const el of Array.from(document.querySelectorAll(s))) {
          if (seen.has(el)) continue; seen.add(el);
          const r = el.getBoundingClientRect();
          if (r.width < 60 || r.height < 60) continue;     // 跳过隐藏/极小
          // 该容器或其子层是否提供了内部滚动？(cap 高度 + overflow 滚动 = 正确做法)
          const st = getComputedStyle(el);
          const selfScroll = /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 4;
          const innerScroll = !!el.querySelector(
            '[style*="overflow"], .overflow-auto, .overflow-y-auto, [class*="overflow-y-auto"]'
          );
          const cutTop = r.top < -8;                         // 顶部被切（"天上去了"）
          const cutBottom = r.bottom > vh + 8;               // 底部超出视口（主操作够不到）
          if ((cutTop || cutBottom) && !selfScroll && !innerScroll) {
            return `modal 高 ${Math.round(r.height)}px 超出视口 ${vh}px（top=${Math.round(r.top)} bottom=${Math.round(r.bottom)}），且无内部滚动 → 疑似撑破/内容飞出，主操作可能够不到`;
          }
        }
      }
      return null;
    });
    if (layout) warnings.push(`版式撑破(P0,frontend-modal.md): ${layout}`);
  } catch { /* 评估失败不阻塞 */ }

  return warnings;
}

/**
 * shot(): 截图主入口。
 * v2.2 起：自动 waitForReady() + validateShot() + 失败重试 1 次。
 *
 * @param {object} opts
 *   - fullPage: 整页截图
 *   - expectText: 断言页面含此文本（强烈推荐：让 caption 不只是描述、更是断言）
 *   - skipReady: 跳过就绪等待（仅极少数确知场景，如登录页输入框未就绪）
 *   - customLoaderSelectors: 项目特有的 loader 选择器
 */
export async function shot(page, outDir, name, caption, opts = {}) {
  const { fullPage = false, expectText, skipReady = false, customLoaderSelectors = [], overview = false } = opts;
  assertOutsideRepo(outDir, '截图输出目录');
  require('fs').mkdirSync(outDir, { recursive: true });
  const path = `${outDir}/${name}.png`;

  // 1) 等就绪
  if (!skipReady) await waitForReady(page, { customLoaderSelectors });

  // 2) 第一次截图
  await page.screenshot({ path, fullPage });

  // 3) 校验
  let warnings = await validateShot(page, path, expectText);

  // 4) 有 warning 时再等 2s 重试一次（覆盖"刚好慢一拍"的情况）
  if (warnings.length > 0) {
    console.log(`  ! ${name} 首次截图有问题：${warnings.join(' | ')} —— 等 2.5s 后重试`);
    await page.waitForTimeout(2500);
    if (!skipReady) await waitForReady(page, { timeout: 8000, customLoaderSelectors });
    await page.screenshot({ path, fullPage });
    warnings = await validateShot(page, path, expectText);
  }

  // 5) v1.0：把"截这张图之前自动捕获到的 ≥blockSeverity 错误"折叠进本图 warnings。
  //    这样一条 P0 console/network 错误会让该截图带 warning → archive_report.py 准入直接拒收，
  //    把"机器抓到的严重运行时错误"变成硬门禁（issue #605 二.2 / 楼上一致诉求）。
  const autoWarns = drainFindingsForShot(shots.length);
  if (autoWarns.length) warnings = warnings.concat(autoWarns);

  // 6) §B2 标注硬门禁（2026-06-05）：截图瞬间页面上有没有标记(box/circle = .__acc_box)?
  //    指向具体元素/差异的证据图没标记 → 读者"看到一个单独页面就懵逼"。这里自动探测并落进 manifest，
  //    archive_report.py 准入据此拒收，把"必须画框/圈"从 §B2 的纸面规则变成跑不过的硬门禁。
  //    整体观感/全局布局图无单一重点 → 调用方显式传 opts.overview=true 豁免。
  const annotated = await page.evaluate(() => document.querySelectorAll('.__acc_box').length > 0).catch(() => false);
  if (!annotated && !overview) {
    console.log(`  ⚠ ${name} 未画框/圈：指向性证据必须标注(stepClick/stepShot(highlight)/box)，整体图请传 {overview:true}`);
  }

  const rec = { name, caption, path, annotated, overview, warnings: warnings.length ? warnings : undefined };
  shots.push(rec);
  if (warnings.length > 0) {
    console.log(`  ⚠ 截图 ${name} | ${caption} | 仍有警告: ${warnings.join(' | ')}`);
  } else {
    console.log(`  截图 ${name} | ${caption}${annotated ? '' : overview ? ' (overview 豁免标注)' : ' (未标注!)'}`);
  }
  return rec;
}

export function manifest() { return shots; }
// 把截图清单写出，供 archive_report.py 读取（name/caption/path/warnings）。
// v1.0：同时写一份机读 result.json（issue #605 二.3），供下游 Agent（issues-visual-run / autofix）
//   直接消费，不必解析 markdown。manifest.json 契约不变（仍是 shots 数组，向后兼容 archive_report.py）。
// extra 可带 { verdict, target, themeSupport, timing, branch, commit }。
export function writeManifest(outDir, extra = {}) {
  const fs = require('fs');
  assertOutsideRepo(outDir, 'manifest 输出目录');
  // 闭合"晚到 P0"漏洞（Bugbot #1，2026-06-04）：drainFindingsForShot 只把 finding 折叠进"之后某次
  // shot() 调用"的 warnings。最后一张截图之后才抛的 ≥blockSeverity finding（典型：收尾时的未捕获
  // 异常 / 5xx）没有后续 shot 来 drain，会只躺在 result.json 里、不进 manifest.json，而 archive_report.py
  // 只按 manifest warnings 拒收 → 这轮可能照样 archive 成 pass。收尾时把这些"孤儿 blocker"挂到最后一张
  // 截图的 warnings 上，确保它进 manifest → 准入照样拒收。零截图的情况由档位截图下限(L0≥1)兜底拒收。
  const orphanBlockers = autoFindings.filter(
    (f) => !f._attached && _sevGte(f.severity, _autoCaptureCfg.blockSeverity),
  );
  if (orphanBlockers.length && shots.length) {
    const last = shots[shots.length - 1];
    last.warnings = (last.warnings || []).concat(
      orphanBlockers.map((f) => `自动捕获(${f.severity},${f.kind},末次截图后/未挂载): ${f.message}`),
    );
    orphanBlockers.forEach((f) => { f._attached = true; });
  }
  fs.writeFileSync(`${outDir}/manifest.json`, JSON.stringify(shots, null, 2));
  const p0 = autoFindings.filter((f) => f.severity === 'P0').length;
  const p1 = autoFindings.filter((f) => f.severity === 'P1').length;
  const unattachedBlockers = autoFindings.filter((f) => !f._attached && _sevGte(f.severity, _autoCaptureCfg.blockSeverity)).length;
  const result = {
    generatedAt: new Date().toISOString(),
    verdict: extra.verdict || null,
    target: extra.target || null,
    branch: extra.branch || null,
    commit: extra.commit || null,
    themeSupport: extra.themeSupport || null,
    timing: extra.timing || null,
    shots: shots.map((s) => ({ name: s.name, caption: s.caption, warnings: s.warnings || [] })),
    autoFindings: autoFindings.map(({ _attached, ...f }) => f),
    autoFindingsSummary: { P0: p0, P1: p1, total: autoFindings.length, unattachedBlockers },
  };
  fs.writeFileSync(`${outDir}/result.json`, JSON.stringify(result, null, 2));
  if (p0 || p1) {
    console.log(`  [自动捕获] P0=${p0} P1=${p1}（详见 result.json autoFindings；P0 已折叠进截图 warnings → 准入会拒收）`);
  }
  return `${outDir}/manifest.json`;
}

// v1.0：收尾保存过程视频。必须在 ctx.close() 后取 path（Playwright 关闭上下文才落盘）。
// 用法：const v = await finalizeVideo(page, ctx, outDir, 'walkthrough'); // 返回 mp4/webm 路径或 null
export async function finalizeVideo(page, ctx, outDir, name = 'walkthrough') {
  const video = page.video && page.video();
  if (!video) return null;
  try {
    await ctx.close(); // 触发落盘
    const raw = await video.path();
    const fs = require('fs');
    const ext = raw.split('.').pop();
    const dest = `${outDir}/${name}.${ext}`;
    if (raw !== dest) { try { fs.renameSync(raw, dest); } catch { fs.copyFileSync(raw, dest); } }
    console.log(`  过程视频已保存: ${dest}`);
    return dest;
  } catch (e) {
    console.log('  finalizeVideo 失败:', e.message);
    return null;
  }
}

// ── ZZ 照做：画框 + 步骤序号（核心：让"点哪到哪"一目了然）──
// 在目标元素上注入红框 + 序号角标，截图前调用；截完用 clearBoxes 清掉。
// opts.shape: 'box'(默认方框,框一片区域/差异) | 'circle'(圈圈,友好地指向单个按钮/输入框/图标)
// opts.color: 十六进制色,默认红 #ff3b30
export async function box(page, locator, label, { shape = 'box', color = '#ff3b30' } = {}) {
  const el = await locator.first().elementHandle().catch(() => null);
  if (!el) return false;
  const rect = await el.boundingBox().catch(() => null);
  if (!rect) return false;
  await page.evaluate(({ r, label, shape, color }) => {
    const isCircle = shape === 'circle' || shape === 'ellipse';
    const pad = isCircle ? 13 : 4;
    const mk = (style) => {
      const d = document.createElement('div');
      d.className = '__acc_box';
      Object.assign(d.style, { position: 'fixed', zIndex: 2147483647, pointerEvents: 'none' }, style);
      document.body.appendChild(d);
      return d;
    };
    mk({ left: (r.x - pad) + 'px', top: (r.y - pad) + 'px', width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px',
         border: `${isCircle ? 4 : 3}px solid ${color}`, borderRadius: isCircle ? '50%' : '8px', boxShadow: `0 0 0 3px ${color}40` });
    if (label) {
      const b = mk({ left: (r.x - 13) + 'px', top: (r.y - 13 - (isCircle ? pad : 0)) + 'px', minWidth: '22px', height: '22px',
        background: color, color: '#fff', borderRadius: '11px', textAlign: 'center', padding: '0 5px',
        font: '700 13px/22px -apple-system,BlinkMacSystemFont,sans-serif' });
      b.textContent = label;
    }
  }, { r: rect, label: String(label ?? ''), shape, color });
  return true;
}

export async function clearBoxes(page) {
  await page.evaluate(() => document.querySelectorAll('.__acc_box').forEach((e) => e.remove())).catch(() => {});
}

// 一步「点击导航/按钮」：框住目标 + 标序号 → 截「点这里」图 → 清框 → 真点击。
// locator 由调用方构造（getByRole/getByText/...），caption 写"点这里去哪"。
// v2.2: 支持 opts.expectText 透传给 shot()，让"点这里"图也能断言页面已就绪
// opts.shape='circle' 让"点这里"标记画成圈圈（指向单个按钮更友好）
export async function stepClick(page, outDir, stepNo, locator, name, caption, { timeout = 10000, expectText, shape = 'circle' } = {}) {
  await locator.first().waitFor({ state: 'visible', timeout }).catch(() => {});
  await box(page, locator, stepNo, { shape });
  await shot(page, outDir, name, `步骤 ${stepNo} · ${caption}`, { expectText });
  await clearBoxes(page);
  await locator.first().click({ timeout }).catch((e) => console.log('  stepClick 点击失败', name, e.message));
  await page.waitForTimeout(1800);
}

// 结果/验证截图：可选框住"变化处"(toast/卡片/激活态)，序号入 caption。
// v2.2: 支持 expectText 锁定结果断言（强烈推荐：结果图就是要证明 X 文本出现了）
// opts.shape: 默认方框框住一片变化区域；指向单个元素时传 'circle'
export async function stepShot(page, outDir, stepNo, name, caption, highlight, { expectText, shape = 'box' } = {}) {
  if (highlight) await box(page, highlight, stepNo, { shape });
  await shot(page, outDir, name, `步骤 ${stepNo} · ${caption}`, { expectText });
  if (highlight) await clearBoxes(page);
}
