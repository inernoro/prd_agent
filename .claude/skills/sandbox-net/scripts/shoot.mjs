#!/usr/bin/env node
/**
 * 取证脚本：打开页面、双主题截图、顺手报出「越界元素 / 横向滚动 / 控制台报错 / 4xx 接口」。
 *
 * 内置了几条踩过的坑（详见 reference/failure-catalog.md）：
 *   - `--no-proxy-server`：Chromium 在 Linux 会读 env 里的 https_proxy，不显式关掉
 *     就会绕过 host 映射 / 本地 relay，直接撞上 agent proxy 然后 reset。
 *   - 不用 `waitUntil: 'networkidle'`：页面只要开着一条 SSE，networkidle 永不触发。
 *   - 越界检测跳过 position:fixed：它相对视口定位，跟 DOM 父级比必然假阳性。
 *
 * 用法：
 *   node shoot.mjs --url http://127.0.0.1:7801/some-page --out /tmp/shots \
 *                  [--themes dark,light] [--viewports 1440x900,390x844] [--wait 6000]
 *   --browser 默认 /opt/pw-browsers/chromium-1194/chrome-linux/chrome，可覆盖。
 *   --playwright 指向 playwright 的 index.mjs（默认从 PLAYWRIGHT_MODULE 环境变量取）。
 */
import fs from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg('url', '');
const out = arg('out', '');
if (!url || !out) {
  console.error('用法: node shoot.mjs --url <地址> --out <目录> [--themes dark,light] [--viewports 1440x900,390x844]');
  process.exit(2);
}
const themes = arg('themes', 'dark,light').split(',').filter(Boolean);
const viewports = arg('viewports', '1440x900').split(',').filter(Boolean)
  .map((v) => { const [w, h] = v.split('x').map(Number); return { width: w, height: h }; });
const waitMs = Number(arg('wait', '6000'));
const browserPath = arg('browser', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const pwModule = arg('playwright', process.env.PLAYWRIGHT_MODULE || '');
if (!pwModule) {
  console.error('找不到 playwright：用 --playwright 指向它的 index.mjs，或设 PLAYWRIGHT_MODULE。');
  console.error("提示: ls -d **/node_modules/playwright/index.mjs 里挑一个已装好的。");
  process.exit(2);
}

const { chromium } = await import(pwModule);
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: browserPath,
  args: ['--no-sandbox', '--disable-background-networking', '--no-proxy-server'],
});

let hasFinding = false;

for (const vp of viewports) {
  for (const theme of themes) {
    const name = `${vp.width}x${vp.height}-${theme}`;
    // viewport 走 context 而不是 --window-size：headless 会把窗口宽度夹到 500px 下限，
    // 用 --window-size=390 实际渲染出来是 500，窄屏结论会整个作废。
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
    page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });

    await page.addInitScript((t) => {
      try { localStorage.setItem('theme', t); localStorage.setItem('cds-theme', t); } catch { /* 无痕上下文 */ }
    }, theme);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(waitMs);
    await page.screenshot({ path: `${out}/${name}.png` });

    const layout = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('*').forEach((el) => {
        const parent = el.parentElement;
        if (!parent) return;
        if (getComputedStyle(el).position === 'fixed') return;   // 相对视口，不跟父级比
        const r = el.getBoundingClientRect();
        const pr = parent.getBoundingClientRect();
        if (r.width === 0 || pr.width === 0) return;
        if (r.right - pr.right > 2 || pr.left - r.left > 2) {
          bad.push(`${el.tagName}.${String(el.className).slice(0, 40)}`);
        }
      });
      return {
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        escaped: bad.slice(0, 6),
      };
    });

    const bad = layout.overflowX || layout.escaped.length > 0 || errors.length > 0;
    if (bad) hasFinding = true;
    console.log(`${bad ? '[有发现]' : '[干净]  '} ${name}  ${JSON.stringify({ ...layout, errors })}`);
  }
}

await browser.close();
console.log(hasFinding ? '\n有发现：上面每条都要看过截图再决定是不是真问题。' : '\n三项检查都干净，但截图仍然要人眼看一遍——它证明不了内容对不对。');
