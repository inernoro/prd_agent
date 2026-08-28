/**
 * 把设计稿画布切成一块一块画板，供审查智能体逐屏比对。
 *
 * 画板的识别判据不是「猜哪个 div 像手机」，而是设计稿自己的结构：
 * 每块画板上方都有一行短标签（R1 · 浅色 · 正在录音 / P3 · 浅色 · 词云 + 会议纪要…），
 * 标签的**下一个兄弟**就是画板本体。按这个抓，画板增减都能跟上，不会因为
 * 尺寸改了几像素就漏掉一块（predicate-and-wiring-discipline 形状 1）。
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * 仓库根从**这个脚本自己的位置**推出来（e2e/design-fidelity/ 往上两级），
 * 不写死作者机器上的绝对路径——换一台机器 / 换一个 checkout 目录，
 * 按 README 里那条命令跑就会在 Playwright 起来之前先抛「缺 React UMD」
 * （Codex 第二十五轮 P2）。REPO_ROOT 仍然保留为显式覆盖。
 */
const REPO_ROOT = process.env.REPO_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const OUT = process.env.OUT_DIR || '/tmp/claude-0/-home-user-prd-agent/e94f0ca4-fb88-51cb-95f1-831ce61d00ee/scratchpad/design-boards';
fs.mkdirSync(OUT, { recursive: true });

/**
 * 设计稿是**可交互原型**：画板内容由它自带的 `support.js` 渲染，而那个运行时
 * 开局就要 `window.React` / `window.ReactDOM`，原稿是从 unpkg 取的——沙箱打不通。
 *
 * 我先前的绕法是剥掉脚本截静态副本，代价是凡由数据驱动的画板全切成了
 * 字面量 `{{ curTime }}`（B1 那块整个播放区都是），拿去判分等于拿废图当基准。
 * 重写一套模板引擎更糟：那是在猜设计稿的语义。
 *
 * 正解是把**本地的** React UMD 喂给它自己的运行时，让设计稿按它自己的逻辑渲染。
 * 于是这里改回加载带脚本的原稿，React 从 node_modules 注入。
 */
const PAGES = [
  { file: 'delivery-v2.html', prefix: 'v2' },
  { file: 'capture-and-result.html', prefix: 'cap' },
];

const REACT_UMD = [
  'prd-admin/node_modules/react/umd/react.production.min.js',
  'prd-admin/node_modules/react-dom/umd/react-dom.production.min.js',
].map((rel) => {
  const full = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(full)) throw new Error(`缺 React UMD：${full}（先在 prd-admin 装依赖）`);
  return fs.readFileSync(full, 'utf8');
});

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const manifest = [];

for (const { file, prefix } of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
  // 必须赶在页面脚本之前落地，否则 support.js 先跑一步就抛「React is not available yet」
  for (const source of REACT_UMD) await page.addInitScript({ content: source });
  // 拦掉原稿里指向 unpkg 的那两个 script：网络打不通，networkidle 会白等到超时
  await page.route('**://unpkg.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.goto(`http://localhost:8188/${file}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // 判据不能是「脚本加载了没有」，要看**渲染结果**：还留着未解析的 {{ }} 就是没渲染成功。
  // 这一条是形状 8 的防线——一块看着正常、实则整片是模板字面量的画板，
  // 拿去判分会得到一个像模像样却毫无意义的分数。
  const unresolved = await page.evaluate(() => (document.body.innerText.match(/\{\{[^}]*\}\}/g) || []).length);
  if (unresolved > 0) throw new Error(`${file} 仍有 ${unresolved} 处未解析模板，运行时没跑起来，不能用来判分`);

  const boards = await page.evaluate(() => {
    // 标签行的特征：13px / 500 字重的短文本，紧跟着一个有圆角和固定宽度的盒子
    const out = [];
    // 设计稿里有两种「标签 + 画板」的写法，都要认：
    //   大画板（手机/桌面整屏）：13px / 500 字重的标签
    //   状态卡（S1…Sn）：JetBrains Mono 12px 的标签
    // 只认其中一种就会漏掉整整一节（v2 的 S1-S8、另一份的 S1-S12 共 20 张）。
    // 光靠字号会把画板**内部**的「09:41」状态栏也当成标签（它同样是 mono 12px）。
    // 设计稿自己给每块画板编了号（R1/P1/A1/B1/D1/S1…），按编号认最稳。
    // 判据读**计算样式**，不读 style 属性的字面量。
    // 手写的静态副本里是 `font-size:13px`，同一份稿由运行时渲染出来是 `font-size: 13px`
    // ——冒号后多一个空格，字面量判据就整体翻转成 0 块（形状 1：语义相同、写法不同）。
    // 计算样式是浏览器求值后的结果，两种写法在这里收敛成同一个值。
    const SHAPES = [
      {
        match: (cs, text) => cs.fontSize === '13px' && cs.fontWeight === '500'
          && /^[A-Z]\d+\s*·/.test(text),
        minW: 200, minH: 200, kind: 'screen',
      },
      {
        match: (cs, text) => /JetBrains Mono/.test(cs.fontFamily) && cs.fontSize === '12px'
          && /^S\d+\s/.test(text),
        minW: 200, minH: 40, kind: 'state',
      },
    ];
    document.querySelectorAll('div').forEach((el) => {
      const label = (el.textContent || '').trim();
      if (!label || label.length > 40) return;
      const cs = getComputedStyle(el);
      const shape = SHAPES.find((s) => s.match(cs, label));
      if (!shape) return;
      const next = el.nextElementSibling;
      if (!(next instanceof HTMLElement)) return;
      if (next.hasAttribute('data-board-label')) return;
      const rect = next.getBoundingClientRect();
      if (rect.width < shape.minW || rect.height < shape.minH) return;
      next.setAttribute('data-board-label', label);
      out.push({ label, w: Math.round(rect.width), h: Math.round(rect.height), kind: shape.kind });
    });
    return out;
  });

  for (let i = 0; i < boards.length; i++) {
    const { label, w, h, kind } = boards[i];
    // 编号取设计稿自己给的代号（R4 / P3 / S5 / A1 / B2 / D1），不用位置序号。
    // 位置序号会随抓取判据变化整体位移——我就因此把「失败卡」拿去和「自动重试」比了一轮。
    const code = /^([A-Z]\d+)/.exec(label)?.[1];
    if (!code) { console.log('SKIP 无代号画板:', label); continue; }
    const id = `${prefix}-${code}`;
    const target = page.locator(`[data-board-label="${label.replace(/"/g, '\\"')}"]`).first();
    await target.screenshot({ path: `${OUT}/${id}.png` });
    manifest.push({ id, file, kind, label, width: w, height: h, image: `${OUT}/${id}.png` });
    console.log(id, kind, `${w}x${h}`, label);
  }
  await page.close();
}

fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log('total boards:', manifest.length);
await browser.close();
