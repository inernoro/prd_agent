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

const OUT = process.env.OUT_DIR || '/tmp/claude-0/-home-user-prd-agent/e94f0ca4-fb88-51cb-95f1-831ce61d00ee/scratchpad/design-boards';
fs.mkdirSync(OUT, { recursive: true });

const PAGES = [
  { file: 'static-delivery-v2.html', prefix: 'v2' },
  { file: 'static-capture-and-result.html', prefix: 'cap' },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const manifest = [];

for (const { file, prefix } of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
  await page.goto(`http://localhost:8188/${file}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const boards = await page.evaluate(() => {
    // 标签行的特征：13px / 500 字重的短文本，紧跟着一个有圆角和固定宽度的盒子
    const out = [];
    // 设计稿里有两种「标签 + 画板」的写法，都要认：
    //   大画板（手机/桌面整屏）：13px / 500 字重的标签
    //   状态卡（S1…Sn）：JetBrains Mono 12px 的标签
    // 只认其中一种就会漏掉整整一节（v2 的 S1-S8、另一份的 S1-S12 共 20 张）。
    // 光靠字号会把画板**内部**的「09:41」状态栏也当成标签（它同样是 mono 12px）。
    // 设计稿自己给每块画板编了号（R1/P1/A1/B1/D1/S1…），按编号认最稳。
    const SHAPES = [
      {
        match: (st, text) => /font-size:13px/.test(st) && /font-weight:500/.test(st)
          && /^[A-Z]\d+\s*·/.test(text),
        minW: 200, minH: 200, kind: 'screen',
      },
      {
        match: (st, text) => /JetBrains Mono/.test(st) && /font-size:12px/.test(st)
          && /^S\d+\s/.test(text),
        minW: 200, minH: 40, kind: 'state',
      },
    ];
    document.querySelectorAll('div').forEach((el) => {
      const style = el.getAttribute('style') || '';
      const label = (el.textContent || '').trim();
      if (!label || label.length > 40) return;
      const shape = SHAPES.find((s) => s.match(style, label));
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
