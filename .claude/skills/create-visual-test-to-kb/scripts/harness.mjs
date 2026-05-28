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

export async function launch(cfg) {
  const sc = cfg.screenshot || {};
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: sc.width || 1440, height: sc.height || 900 },
    deviceScaleFactor: sc.deviceScaleFactor || 2,
    ignoreHTTPSErrors: true, // 出口代理证书
  });
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

// 登录（走表单，不注入 token）。返回登录后 URL。
export async function login(page, baseUrl, cfg) {
  const b = cfg.auth.browser;
  const user = process.env[b.userEnv];
  const pass = process.env[b.passEnv];
  if (!user || !pass) throw new Error(`缺少登录凭据：请设置 env ${b.userEnv} 和 ${b.passEnv}`);
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
  } catch (e) {
    return { found: false, navText, error: e.message };
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
  const { fullPage = false, expectText, skipReady = false, customLoaderSelectors = [] } = opts;
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

  const rec = { name, caption, path, warnings: warnings.length ? warnings : undefined };
  shots.push(rec);
  if (warnings.length > 0) {
    console.log(`  ⚠ 截图 ${name} | ${caption} | 仍有警告: ${warnings.join(' | ')}`);
  } else {
    console.log(`  截图 ${name} | ${caption}`);
  }
  return rec;
}

export function manifest() { return shots; }
// 把截图清单写出，供 archive_report.py 读取（name/caption/path）
export function writeManifest(outDir) {
  require('fs').writeFileSync(`${outDir}/manifest.json`, JSON.stringify(shots, null, 2));
  return `${outDir}/manifest.json`;
}

// ── ZZ 照做：画框 + 步骤序号（核心：让"点哪到哪"一目了然）──
// 在目标元素上注入红框 + 序号角标，截图前调用；截完用 clearBoxes 清掉。
export async function box(page, locator, label) {
  const el = await locator.first().elementHandle().catch(() => null);
  if (!el) return false;
  const rect = await el.boundingBox().catch(() => null);
  if (!rect) return false;
  await page.evaluate(({ r, label }) => {
    const mk = (style) => {
      const d = document.createElement('div');
      d.className = '__acc_box';
      Object.assign(d.style, { position: 'fixed', zIndex: 2147483647, pointerEvents: 'none' }, style);
      document.body.appendChild(d);
      return d;
    };
    mk({ left: (r.x - 4) + 'px', top: (r.y - 4) + 'px', width: (r.width + 8) + 'px', height: (r.height + 8) + 'px',
         border: '3px solid #ff3b30', borderRadius: '8px', boxShadow: '0 0 0 3px rgba(255,59,48,.25)' });
    if (label) {
      const b = mk({ left: (r.x - 13) + 'px', top: (r.y - 13) + 'px', minWidth: '22px', height: '22px',
        background: '#ff3b30', color: '#fff', borderRadius: '11px', textAlign: 'center', padding: '0 5px',
        font: '700 13px/22px -apple-system,BlinkMacSystemFont,sans-serif' });
      b.textContent = label;
    }
  }, { r: rect, label: String(label ?? '') });
  return true;
}

export async function clearBoxes(page) {
  await page.evaluate(() => document.querySelectorAll('.__acc_box').forEach((e) => e.remove())).catch(() => {});
}

// 一步「点击导航/按钮」：框住目标 + 标序号 → 截「点这里」图 → 清框 → 真点击。
// locator 由调用方构造（getByRole/getByText/...），caption 写"点这里去哪"。
// v2.2: 支持 opts.expectText 透传给 shot()，让"点这里"图也能断言页面已就绪
export async function stepClick(page, outDir, stepNo, locator, name, caption, { timeout = 10000, expectText } = {}) {
  await locator.first().waitFor({ state: 'visible', timeout }).catch(() => {});
  await box(page, locator, stepNo);
  await shot(page, outDir, name, `步骤 ${stepNo} · ${caption}`, { expectText });
  await clearBoxes(page);
  await locator.first().click({ timeout }).catch((e) => console.log('  stepClick 点击失败', name, e.message));
  await page.waitForTimeout(1800);
}

// 结果/验证截图：可选框住"变化处"(toast/卡片/激活态)，序号入 caption。
// v2.2: 支持 expectText 锁定结果断言（强烈推荐：结果图就是要证明 X 文本出现了）
export async function stepShot(page, outDir, stepNo, name, caption, highlight, { expectText } = {}) {
  if (highlight) await box(page, highlight, stepNo);
  await shot(page, outDir, name, `步骤 ${stepNo} · ${caption}`, { expectText });
  if (highlight) await clearBoxes(page);
}
