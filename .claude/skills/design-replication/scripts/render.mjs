#!/usr/bin/env node
/**
 * 把「一块画布」渲染成逐画板、双主题的截图。
 *
 * 同一个脚本同时用于设计稿和实现页：两边走完全一样的视口、缩放、主题切换、
 * 等待策略，否则并排比出来的差异里会混进「取证方式不同」造成的噪音。
 *
 * 用法：
 *   node render.mjs --url <地址> --out <目录> --tag design \
 *     [--width 1440] [--themes dark,light] \
 *     [--state 'id=要点击的按钮文案'] ... \
 *     [--vendor <目录>] [--storage <storageState.json>] [--full]
 *
 * --state 可以给多次。不给则只截默认那一屏（id=default）。
 * --vendor 指向本地 React UMD 缓存（见 prefetch.sh）；设计稿画布从 unpkg 取
 *   React，容器网络直连不通，必须由 route 从本地喂进去。
 */
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// 脚本住在技能目录里，依赖装在工作目录里：必须从 cwd 解析，不能按脚本位置解析。
const { chromium } = createRequire(path.join(process.cwd(), 'noop.js'))('playwright');

function parseArgs(argv) {
  const out = { states: [], themes: ['dark', 'light'], width: 1440, full: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') out.url = next();
    else if (a === '--out') out.out = next();
    else if (a === '--tag') out.tag = next();
    else if (a === '--width') out.width = Number(next());
    else if (a === '--themes') out.themes = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--state') out.states.push(next());
    else if (a === '--vendor') out.vendor = next();
    else if (a === '--theme-click') out.themeClick = next();
    else if (a === '--storage') out.storage = next();
    else if (a === '--viewport-only') out.full = false;
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.url || !opts.out || !opts.tag) {
  console.error('必填：--url --out --tag');
  process.exit(2);
}
fs.mkdirSync(opts.out, { recursive: true });

const states = opts.states.length
  ? opts.states.map((s) => {
      const at = s.indexOf('=');
      return at < 0 ? { id: s, click: null } : { id: s.slice(0, at), click: s.slice(at + 1) };
    })
  : [{ id: 'default', click: null }];

const target = /^https?:/.test(opts.url) ? opts.url : pathToFileURL(path.resolve(opts.url)).href;
const CHROME = process.env.CHROME_BIN
  || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const problems = [];
const manifest = [];
const themeBg = new Map();

for (const theme of opts.themes) {
  const ctx = await browser.newContext({
    viewport: { width: opts.width, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme === 'light' ? 'light' : 'dark',
    storageState: opts.storage && fs.existsSync(opts.storage) ? opts.storage : undefined,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${theme}] console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${theme}] pageerror: ${e.message}`));

  if (opts.vendor) {
    await page.route('**/unpkg.com/**', async (route) => {
      const file = path.join(opts.vendor, path.basename(new URL(route.request().url()).pathname));
      if (fs.existsSync(file)) await route.fulfill({ path: file, contentType: 'application/javascript' });
      else await route.continue();
    });
  }

  await page.goto(target, { waitUntil: 'networkidle', timeout: 90000 });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  // 有的画布/应用不认 documentElement 上的 data-theme，主题挂在自己的组件状态里，
  // 只能点它自己的切换控件。--theme-click 给的就是那个控件的文案。
  if (opts.themeClick && theme !== opts.themes[0]) {
    try {
      await page.getByText(opts.themeClick, { exact: false }).first().click({ timeout: 8000 });
      await page.waitForTimeout(700);
    } catch {
      problems.push(`[${theme}] 点不到主题切换控件「${opts.themeClick}」`);
    }
  }
  await page.waitForTimeout(900);
  // 形状 6 自防：判据要读真正生效的值。主题切了没切，只认渲染出来的底色。
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  themeBg.set(theme, bg);

  for (const state of states) {
    if (state.click) {
      const hit = page.getByText(state.click, { exact: false }).first();
      try {
        await hit.click({ timeout: 8000 });
      } catch {
        problems.push(`[${theme}] 找不到可点击的「${state.click}」，画板 ${state.id} 用的是上一屏`);
      }
      await page.waitForTimeout(900);
    }
    const file = path.join(opts.out, `${opts.tag}.${state.id}.${theme}.${opts.width}.png`);
    await page.screenshot({ path: file, fullPage: opts.full });
    const chars = await page.evaluate(() => document.body.innerText.trim().length);
    // 空白画布是最常见的假成功：截图有了，内容其实没渲染出来。
    if (chars < 40) problems.push(`[${theme}] 画板 ${state.id} 正文只有 ${chars} 个字符，多半没渲染`);
    manifest.push({ tag: opts.tag, state: state.id, theme, width: opts.width, file, chars });
    console.log(`${file}  text=${chars}`);
  }
  await ctx.close();
}
await browser.close();

// 两个主题渲染出同一个底色 = 主题根本没切，两套截图是同一套，双主题验收是假的。
if (themeBg.size > 1 && new Set(themeBg.values()).size === 1) {
  problems.push(`所有主题的 body 底色都是 ${[...themeBg.values()][0]}：主题没有真的切换，`
    + '这批「双主题」截图是同一套，不算证据。给 --theme-click <切换控件文案> 重跑。');
}

fs.writeFileSync(path.join(opts.out, `${opts.tag}.manifest.json`), JSON.stringify(manifest, null, 2));
if (problems.length) {
  console.log('\n--- 取证异常（不许当作正常证据用）---');
  for (const p of problems.slice(0, 20)) console.log(p);
  process.exitCode = 1;
}
