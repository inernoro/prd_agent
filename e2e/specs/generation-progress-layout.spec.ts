/** 真实组件的浏览器布局回归。只证明显示与缩放，不代表真实上游生图成功。 */
import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const adminRoot = resolve(import.meta.dirname, '../../prd-admin');
const requireAdmin = createRequire(resolve(adminRoot, 'package.json'));
const { createElement } = requireAdmin('react');
const { renderToStaticMarkup } = requireAdmin('react-dom/server');
let renderLoader: (w: number, h: number, elapsed?: number) => string;
let css: string;

test.beforeAll(async () => {
  // 借用应用自己的 Vite/React，不复制进度组件或单独维护一份测试 CSS。
  const { createServer } = await import(resolve(adminRoot, 'node_modules/vite/dist/node/index.js'));
  const server = await createServer({
    root: adminRoot, configFile: false,
    resolve: { alias: { '@': resolve(adminRoot, 'src') } },
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const { GenSweepLoader } = await server.ssrLoadModule('/src/components/ui/GenSweepLoader.tsx');
    renderLoader = (screenW, screenH, elapsed = 18) => renderToStaticMarkup(createElement(GenSweepLoader, {
      screenW, screenH, createdAt: Date.now() - elapsed * 1000,
    }));
    const source = readFileSync(resolve(adminRoot, 'src/components/ui/GenSweepLoader.tsx'), 'utf8');
    css = source.match(/const GLOBAL_CSS = `([\s\S]*?)`;/)![1];
  } finally {
    await server.close();
  }
});

function fixture(w: number, h: number, zoom: number, theme = 'dark', elapsed = 18) {
  return `<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>生图进度组件布局回归</title><style>${css}
    body{margin:16px;font:14px system-ui;background:${theme === 'dark' ? '#18191d' : '#f4f4f5'};color:${theme === 'dark' ? '#eee' : '#222'}}
    .stage{position:relative;width:${w * zoom}px;height:${h * zoom}px;margin-top:24px}
    .world{position:absolute;transform-origin:0 0;transform:scale(${zoom});--invZoom:${1 / zoom};width:${w}px;height:${h}px}
    .card{position:relative;width:100%;height:100%;border-radius:16px;background:${theme === 'dark' ? '#30333c' : '#e4e4e7'}}
    </style><h1>生图进度 · ${w}×${h} · ${zoom * 100}%</h1>
    <p>组件布局回归：检查文字可读、进度条完整、不超过卡片边界。这里使用真实组件与确定性等待状态，不调用模型，不作为真实生图结果。</p>
    <div class="stage"><div class="world"><div class="card">${renderLoader(w * zoom, h * zoom, elapsed)}</div></div></div></html>`;
}

async function assertReadable(page: Page, zoom: number) {
  const host = await page.getByTestId('generation-progress').boundingBox();
  const bar = await page.getByTestId('generation-progress-bar').boundingBox();
  expect(host).not.toBeNull();
  expect(bar).not.toBeNull();
  expect(bar!.width).toBeGreaterThanOrEqual(Math.min(host!.width * 0.8, 300) - 1);
  expect(bar!.width).toBeLessThanOrEqual(341);
  expect(bar!.x).toBeGreaterThanOrEqual(host!.x + 7);
  expect(bar!.x + bar!.width).toBeLessThanOrEqual(host!.x + host!.width - 7);
  expect(bar!.y).toBeGreaterThanOrEqual(host!.y);
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(host!.y + host!.height - 7);
  const textSize = await page.locator('.gen-sweep__row').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  expect(textSize * zoom).toBeCloseTo(12, 1);
  const track = await page.locator('.gen-sweep__track').boundingBox();
  expect(track!.height).toBeCloseTo(5, 1);
  for (const span of await page.locator('.gen-sweep__row > span').all()) {
    const text = await span.boundingBox();
    expect(text!.x).toBeGreaterThanOrEqual(bar!.x);
    expect(text!.x + text!.width).toBeLessThanOrEqual(bar!.x + bar!.width);
    expect(text!.y + text!.height).toBeLessThanOrEqual(bar!.y + bar!.height);
    // 半透明底色即使叠在纯白图上，也必须保住小字号文字的对比度。
    const contrast = await span.evaluate(el => {
      const rgba = (color: string) => {
        const values = color.match(/[\d.]+/g)!.map(Number);
        return [...values.slice(0, 3), values[3] ?? 1];
      };
      const over = (fg: number[], bg: number[]) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
      const luminance = (rgb: number[]) => rgb.map(v => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const bg = over(rgba(getComputedStyle(el.closest('.gen-sweep__bar')!).backgroundColor), [255, 255, 255]);
      const fg = over(rgba(getComputedStyle(el).color), bg);
      return (luminance(fg) + 0.05) / (luminance(bg) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  }
}

test('方图横图竖图在 5%–300% 缩放下保持可读或明确收起', async ({ page }) => {
  const sizes = [[256, 256], [512, 512], [1024, 1024], [1536, 1024], [1024, 1536], [2048, 2048], [1536, 2752], [2752, 1536], [2048, 512], [512, 2048]];
  for (const [w, h] of sizes) {
    for (const zoom of [0.05, 0.125, 0.2, 0.25, 0.5, 1, 2, 3]) {
      await test.step(`${w}×${h} / ${zoom * 100}%`, async () => {
        await page.setContent(fixture(w, h, zoom));
        if (w * zoom >= 200 && h * zoom >= 120) await assertReadable(page, zoom);
        else {
          await expect(page.getByTestId('generation-progress-bar')).toHaveCount(0);
          await expect(page.locator('.gen-sweep__glare')).toHaveCount(1);
        }
      });
    }
  }
});

test('缩放逐帧更新时不用等待 React 同步，长耗时文字也不裁切', async ({ page }) => {
  await page.setContent(fixture(1536, 1024, 0.2, 'dark', 99999));
  await assertReadable(page, 0.2);
  for (const zoom of [0.25, 0.5, 1, 0.2]) {
    await page.locator('.world').evaluate((el, z) => {
      (el as HTMLElement).style.transform = `scale(${z})`;
      (el as HTMLElement).style.setProperty('--invZoom', String(1 / z));
    }, zoom);
    await assertReadable(page, zoom);
  }
});

test('非画布宿主缺省缩放为 1', async ({ page }) => {
  await page.setContent(fixture(300, 180, 1));
  await page.locator('.world').evaluate(el => (el as HTMLElement).style.setProperty('--invZoom', 'initial'));
  await assertReadable(page, 1);
});

test('触控手机双主题下方图、横图、竖图进度完整', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  try {
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
    for (const theme of ['dark', 'light']) {
      for (const [w, h, zoom] of [[1024, 1024, 0.3], [1536, 1024, 0.2], [1024, 1536, 0.3]]) {
        await page.setContent(fixture(w, h, zoom, theme));
        await assertReadable(page, zoom);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      }
    }
  } finally {
    await ctx.close();
  }
});

// 人工复测可选取证。产物只写仓库外，始终标明这是组件 fixture，不冒充线上旅程。
if (process.env.PROGRESS_LAYOUT_EVIDENCE_DIR) {
  test('组件尺寸证据取图', async () => {
    const out = process.env.PROGRESS_LAYOUT_EVIDENCE_DIR!;
    process.env.PWPATH = createRequire(import.meta.url).resolve('playwright');
    const harness = await import(resolve(adminRoot, '../.agents/skills/create-visual-test-to-kb/scripts/harness.mjs'));
    const cfg = { screenshot: { width: 1440, height: 900, deviceScaleFactor: 1 } };
    const { browser, ctx, page } = await harness.launch(cfg);
    let index = 0;
    try {
      for (const theme of ['dark', 'light']) {
        for (const [w, h, zoom] of [[1024, 1024, 0.3], [2752, 1536, 0.2], [1536, 2752, 0.2]]) {
          await page.setContent(fixture(w, h, zoom, theme));
          await assertReadable(page, zoom);
          const name = `${String(++index).padStart(2, '0')}-${theme}-${w}x${h}`;
          await harness.box(page, page.getByTestId('generation-progress-bar'), '进度可读且未裁切');
          await harness.shot(page, out, name, `进度偏小复测：${w}×${h} / ${zoom * 100}% / ${theme}，屏幕字号12px且进度完整（组件 fixture）`, {
            skipReady: true, expectText: '已耗时', environment: 'deterministic-fixture', theme,
          });
        }
      }
      const mobile = await harness.createMobileContext(browser, cfg, { viewport: { width: 390, height: 844 } });
      try {
        for (const [w, h, zoom] of [[1024, 1024, 0.3], [1536, 1024, 0.2], [1024, 1536, 0.3]]) {
          await mobile.page.setContent(fixture(w, h, zoom, 'light'));
          await assertReadable(mobile.page, zoom);
          const name = `${String(++index).padStart(2, '0')}-mobile-${w}x${h}`;
          await harness.box(mobile.page, mobile.page.getByTestId('generation-progress-bar'), '进度可读且未裁切');
          await harness.shot(mobile.page, out, name, `手机进度复测：390×844触控视口，${w}×${h} / ${zoom * 100}%，文字和进度完整（组件 fixture）`, {
            skipReady: true, expectText: '已耗时', environment: 'deterministic-fixture', theme: 'light',
          });
        }
      } finally {
        await mobile.ctx.close();
      }
      harness.writeManifest(out, { target: '生图进度多尺寸组件诊断', verdict: 'conditional', themeSupport: { supportsLight: true } });
    } finally {
      await ctx.close();
      await browser.close();
    }
  });
}
