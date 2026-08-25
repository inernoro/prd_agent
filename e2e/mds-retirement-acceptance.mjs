/**
 * 「模型管理退场」真视觉验收：真人路径登录 → 点侧边栏进入模型管理 → 看到墓碑页 →
 * 双主题各截一张 → 确认页面上不再有任何写入口 → 确认「打开模型网关控制台」按钮存在且可点。
 *
 *   E2E_BASE_URL=<预览域名或本地 relay> MAP_USER=<用户名> MAP_PASSWORD=<密码> \
 *   OUT_DIR=/tmp/mds-acc node mds-retirement-acceptance.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.E2E_BASE_URL;
const OUT = process.env.OUT_DIR || '/tmp/mds-acc';
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
let n = 0;
const shot = async (page, name) => {
  const f = `${OUT}/${String(++n).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: f, fullPage: false });
  log('shot', f);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-proxy-server', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await (await browser.newContext({ viewport: { width: 1520, height: 940 } })).newPage();

const result = { themes: {}, writeAffordances: null, gatewayButton: null, navLabel: null };

try {
  // ── 登录 ──
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const userInput = page.locator('input:not([type="checkbox"])').first();
  const passInput = page.locator('input[type="password"]').first();
  await userInput.waitFor({ state: 'visible', timeout: 30_000 });
  await userInput.fill(process.env.MAP_USER);
  await passInput.fill(process.env.MAP_PASSWORD);
  await page.locator('button', { hasText: '进入控制台' }).first().click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });
  await page.waitForTimeout(2500);
  log('logged in →', page.url());

  // ── 真人路径：点侧边栏那颗「模型」进去，不用地址栏直达 ──
  // 侧栏是窄轨，显示的是 shortLabel（「模型」）；完整标签「模型管理（已迁移）」在 Cmd+K 与设置里。
  const clicked = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('a[href], button'))
      .find((x) => (x.getAttribute('href') || '') === '/mds'
        || (x.textContent || '').replace(/\s+/g, '') === '模型');
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  });
  result.navLabel = clicked ? '侧边栏「模型」' : null;
  if (!clicked) {
    log('侧边栏未命中入口，退回直达（记为降级路径）');
    await page.goto(`${BASE}/mds`, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForTimeout(4000);
  log('url:', page.url());

  // ── 暗色 ──
  await shot(page, '模型管理-墓碑页-暗色');
  const darkText = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '));
  result.themes.dark = /模型管理已经搬到「模型网关」/.test(darkText);

  // 页面上不该再有任何写入口
  const forbidden = ['新建模型池', '添加平台', '添加模型', '管理模型池', '删除平台', '保存', '应用模型池管理', '平台管理', '模型中继'];
  result.writeAffordances = await page.evaluate((words) => {
    const btns = Array.from(document.querySelectorAll('button, [role=tab]'))
      .map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim());
    return words.filter((w) => btns.some((t) => t === w));
  }, forbidden);

  const gwBtn = page.getByRole('button', { name: /打开模型网关控制台/ });
  result.gatewayButton = (await gwBtn.count()) > 0 && (await gwBtn.first().isEnabled());

  // ── 浅色 ──
  const toggled = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => ['深色', '浅色'].includes((b.textContent || '').replace(/\s+/g, ' ').trim()));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page.waitForTimeout(2500);
  if (!toggled) {
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.waitForTimeout(1200);
  }
  await shot(page, '模型管理-墓碑页-浅色');
  result.themes.light = await page.evaluate(
    () => /模型管理已经搬到「模型网关」/.test((document.body.innerText || '').replace(/\s+/g, ' '))
  );
  result.themeAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));

  console.log('\nRESULT', JSON.stringify(result, null, 2));
} catch (e) {
  console.log('FAILED:', String(e).slice(0, 400));
  await shot(page, 'failure');
  process.exitCode = 1;
} finally {
  await browser.close();
}
