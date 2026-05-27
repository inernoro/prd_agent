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
const shots = [];
export async function shot(page, outDir, name, caption, { fullPage = false } = {}) {
  require('fs').mkdirSync(outDir, { recursive: true });
  const path = `${outDir}/${name}.png`;
  await page.screenshot({ path, fullPage });
  const rec = { name, caption, path };
  shots.push(rec);
  console.log(`  截图 ${name} | ${caption}`);
  return rec;
}

export function manifest() { return shots; }
// 把截图清单写出，供 archive_report.py 读取（name/caption/path）
export function writeManifest(outDir) {
  require('fs').writeFileSync(`${outDir}/manifest.json`, JSON.stringify(shots, null, 2));
  return `${outDir}/manifest.json`;
}
