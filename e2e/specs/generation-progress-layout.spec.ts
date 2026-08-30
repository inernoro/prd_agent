/** 真实组件的浏览器布局回归。只证明显示与缩放，不代表真实上游生图成功。 */
import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const adminRoot = resolve(import.meta.dirname, '../../prd-admin');
const requireAdmin = createRequire(resolve(adminRoot, 'package.json'));
const { createElement } = requireAdmin('react');
const { renderToStaticMarkup } = requireAdmin('react-dom/server');

type MetaLevel = 'full' | 'phase' | 'time' | 'pip';
let renderLoader: (w: number, h: number, zoom: number, elapsed?: number) => string;
let metaLevel: (screenW: number, screenH: number) => MetaLevel;
let css: string;
/**
 * 组件的配色全部走 --gen-wait-* token，所以 fixture 必须把 tokens.css 一起注进来。
 * 少了它，var() 全部落空、颜色退化成继承的 body 色 —— 浅色档下就是深字压深底
 * （实测对比度 0.83）。这不是组件的问题，是「判据读的值不是真正生效的那个值」。
 */
let tokens: string;

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
  tokens = readFileSync(resolve(adminRoot, 'src/styles/tokens.css'), 'utf8');
  try {
    const mod = await server.ssrLoadModule('/src/components/ui/GenDevelopLoader.tsx');
    // 直接取模块导出的 CSS，不再用正则从源码里抠 —— 那份 CSS 里有模板插值
    // （潜像 data-URI），抠出来的是未求值的源码文本，注进页面等于什么都没注
    //（判据纪律形状 6：判据读的值不是真正生效的那个值）。
    css = mod.GLOBAL_CSS;
    metaLevel = mod.metaLevel;
    renderLoader = (w, h, zoom, elapsed = 18) => renderToStaticMarkup(createElement(mod.GenDevelopLoader, {
      screenW: w * zoom, screenH: h * zoom, worldW: w, worldH: h,
      sizeLabel: `${w} × ${h}`, createdAt: Date.now() - elapsed * 1000,
    }));
  } finally {
    await server.close();
  }
});

/**
 * 还原画布上的真实层次：舞台（钉死的暗色）→ 缩放世界层 → 透明卡片 → loader。
 * 卡片自己不画底纱也不画边框，那两件都归 loader —— 与 AdvancedVisualAgentTab 一致。
 */
function fixture(w: number, h: number, zoom: number, theme = 'dark', elapsed = 18) {
  return `<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>生图等待态组件布局回归</title><style>${tokens}
    ${css}
    /* tokens.css 里有 html,body{width:100%}，再加 margin 就会把文档撑出视口
       （390 + 16 = 406，横向滚动条那条判据会误报到 fixture 自己头上）。用 padding。 */
    body{margin:0;padding:16px;box-sizing:border-box;font:14px system-ui;
      background:${theme === 'dark' ? '#18191d' : '#f4f4f5'};color:${theme === 'dark' ? '#eee' : '#222'}}
    .stage{position:relative;width:${w * zoom}px;height:${h * zoom}px;margin-top:24px;background-color:#1e1e1e;
      background-image:radial-gradient(circle, rgba(255,255,255,0.12) 1px, transparent 1px);background-size:${48 * zoom}px ${48 * zoom}px}
    .world{position:absolute;transform-origin:0 0;transform:scale(${zoom});--invZoom:${1 / zoom};width:${w}px;height:${h}px}
    .card{position:relative;width:100%;height:100%;border-radius:16px;background:transparent}
    </style><h1>生图等待态 · ${w}×${h} · ${zoom * 100}%</h1>
    <p>组件布局回归：检查文字可读、画框描边完整、不超过卡片边界。这里使用真实组件与确定性等待状态，不调用模型，不作为真实生图结果。</p>
    <div class="stage"><div class="world"><div class="card">${renderLoader(w, h, zoom, elapsed)}</div></div></div></html>`;
}

/** 前景文字与它真实底色的对比度，取保守下界（底越亮、算出来越低）。 */
async function contrastOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((el) => {
    const rgba = (color: string): number[] => {
      const v = (color.match(/[\d.]+/g) ?? []).map(Number);
      return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1];
    };
    const over = (fg: number[], bg: number[]) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]));
    const luminance = (rgb: number[]) => rgb.map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);

    // 逐层合成这行字底下真实的那一叠，全部取**对对比度最不利**的一档：
    let bg = rgba(getComputedStyle(document.querySelector('.stage')!).backgroundColor).slice(0, 3);
    bg = over(rgba(getComputedStyle(document.querySelector('.gen-dev__veil')!).backgroundColor), bg);
    // 潜像马赛克会把底提亮一点点，按上界 8% 白记账（实测单格最高不到 6%）。
    bg = over([255, 255, 255, 0.08], bg);
    // 渐变蒙版：取**最弱**的一档 alpha。文字实际落在靠底、蒙版更浓的位置，所以这是下界。
    const scrim = getComputedStyle(document.querySelector('.gen-dev__scrim')!).backgroundImage;
    const stops = [...scrim.matchAll(/rgba?\([^)]*\)/g)].map((m) => rgba(m[0])).filter((c) => c[3] > 0.01);
    if (stops.length) bg = over(stops.reduce((a, b) => (a[3] <= b[3] ? a : b)), bg);

    const fg = over(rgba(getComputedStyle(el).color), bg);
    return (luminance(fg) + 0.05) / (luminance(bg) + 0.05);
  });
}

/** 画框是唯一一个任何尺寸都不退场的进度载体，也是这版设计的核心主张。 */
async function assertFrame(page: Page, zoom: number) {
  const arc = page.locator('.gen-dev__arc');
  await expect(arc, '画框描边必须在场——进度画在画框上，它退场进度就没了').toHaveCount(1);
  const stroke = await arc.evaluate((el) => parseFloat(getComputedStyle(el).strokeWidth));
  // 按屏幕像素恒定：低倍下原来那条 1 世界像素的 border 早就看不见了，描边不能重蹈覆辙。
  expect(stroke * zoom, `${zoom * 100}% 下描边的屏幕宽度`).toBeCloseTo(2, 1);
  const offset = await arc.evaluate((el) => parseFloat(getComputedStyle(el).strokeDashoffset));
  expect(offset).toBeGreaterThan(0);   // 没出图就不许画满
  expect(offset).toBeLessThan(100);    // 但必须已经走出去一段
}

/** 底边一行：装得下、不裁切、字号按屏幕恒定、对比度达标。 */
async function assertMeta(page: Page, zoom: number, level: MetaLevel) {
  const host = (await page.getByTestId('generation-progress').boundingBox())!;
  const meta = (await page.getByTestId('generation-progress-meta').boundingBox())!;
  expect(host).not.toBeNull();
  expect(meta).not.toBeNull();
  expect(meta.x).toBeGreaterThanOrEqual(host.x - 0.5);
  expect(meta.x + meta.width).toBeLessThanOrEqual(host.x + host.width + 0.5);
  expect(meta.y + meta.height).toBeLessThanOrEqual(host.y + host.height + 0.5);

  const spans = await page.locator('.gen-dev__meta > span:not(.gen-dev__dot)').all();
  if (level === 'pip') {
    await expect(page.locator('.gen-dev__pip'), '最小档也要留一个点，说明这块在做事').toHaveCount(1);
    expect(spans).toHaveLength(1);
    return;
  }

  // 逐段脱落：full = 尺寸+阶段+时间，phase = 阶段+时间，time = 只剩时间。
  const expected = { full: 3, phase: 2, time: 1 }[level];
  expect(spans, `${level} 档应有 ${expected} 段`).toHaveLength(expected);
  await expect(page.locator('.gen-dev__size')).toHaveCount(level === 'full' ? 1 : 0);
  await expect(page.locator('.gen-dev__phase')).toHaveCount(level === 'time' ? 0 : 1);
  await expect(page.locator('.gen-dev__time')).toHaveCount(1);

  const fontSize = await page.locator('.gen-dev__meta').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize * zoom, '字号必须按屏幕像素恒定').toBeCloseTo(12.5, 1);

  for (const span of spans) {
    const box = (await span.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(host.x - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(host.x + host.width + 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(host.y + host.height + 0.5);
  }
  for (const cls of ['.gen-dev__size', '.gen-dev__phase', '.gen-dev__time']) {
    if (await page.locator(cls).count()) {
      expect(await contrastOf(page, cls), `${cls} 对比度`).toBeGreaterThanOrEqual(4.5);
    }
  }
}

test('方图横图竖图在 5%–300% 缩放下保持可读或明确逐段收起', async ({ page }) => {
  const sizes = [[256, 256], [512, 512], [1024, 1024], [1536, 1024], [1024, 1536], [2048, 2048], [1536, 2752], [2752, 1536], [2048, 512], [512, 2048]];
  for (const [w, h] of sizes) {
    for (const zoom of [0.05, 0.125, 0.2, 0.25, 0.5, 1, 2, 3]) {
      await test.step(`${w}×${h} / ${zoom * 100}%`, async () => {
        await page.setContent(fixture(w, h, zoom));
        // 期望档位由组件自己的判定函数给出，测试不另抄一份阈值（抄一份就会漂）。
        await assertMeta(page, zoom, metaLevel(w * zoom, h * zoom));
        await assertFrame(page, zoom);
      });
    }
  }
});

test('缩放逐帧更新时不用等待 React 同步，长耗时文字也不裁切', async ({ page }) => {
  await page.setContent(fixture(1536, 1024, 0.2, 'dark', 99999));
  await assertMeta(page, 0.2, metaLevel(1536 * 0.2, 1024 * 0.2));
  await assertFrame(page, 0.2);
  for (const zoom of [0.25, 0.5, 1, 0.2]) {
    await page.locator('.world').evaluate((el, z) => {
      (el as HTMLElement).style.transform = `scale(${z})`;
      (el as HTMLElement).style.setProperty('--invZoom', String(1 / z));
    }, zoom);
    // 只动 CSS 变量、不重渲染 React：字号和描边必须当帧就跟上。
    await assertFrame(page, zoom);
    const fontSize = await page.locator('.gen-dev__meta').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize * zoom).toBeCloseTo(12.5, 1);
  }
});

test('非画布宿主缺省缩放为 1', async ({ page }) => {
  await page.setContent(fixture(300, 180, 1));
  await page.locator('.world').evaluate((el) => (el as HTMLElement).style.setProperty('--invZoom', 'initial'));
  await assertMeta(page, 1, metaLevel(300, 180));
  await assertFrame(page, 1);
});

test('等待态配色不跟主题翻面（画布舞台本身就是钉死的暗色）', async ({ page }) => {
  // 这一族 token 故意不双写：舞台恒为 #1e1e1e，跟着翻会得到「暗底 + 浅色档的深色字」。
  // 哪天有人给 --gen-wait-* 补了浅色覆盖却没把舞台一起翻，这条会红，逼他一起改。
  const read = () => page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.gen-dev__meta')!);
    const time = getComputedStyle(document.querySelector('.gen-dev__time')!).color;
    const arc = getComputedStyle(document.querySelector('.gen-dev__arc')!).stroke;
    return { font: s.fontSize, time, arc };
  });
  await page.setContent(fixture(1024, 1024, 0.5, 'dark'));
  const dark = await read();
  await page.setContent(fixture(1024, 1024, 0.5, 'light'));
  expect(await read()).toEqual(dark);
});

test('触控手机双主题下方图、横图、竖图进度完整', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  try {
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
    for (const theme of ['dark', 'light']) {
      for (const [w, h, zoom] of [[1024, 1024, 0.3], [1536, 1024, 0.2], [1024, 1536, 0.3]]) {
        await page.setContent(fixture(w, h, zoom, theme));
        await assertMeta(page, zoom, metaLevel(w * zoom, h * zoom));
        await assertFrame(page, zoom);
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
      for (const [w, h, zoom] of [[1024, 1024, 0.3], [2752, 1536, 0.2], [1536, 2752, 0.2]]) {
        await page.setContent(fixture(w, h, zoom, 'dark'));
        await assertMeta(page, zoom, metaLevel(w * zoom, h * zoom));
        await assertFrame(page, zoom);
        const name = `${String(++index).padStart(2, '0')}-${w}x${h}`;
        await harness.box(page, page.getByTestId('generation-progress-meta'), '底边一行可读且未裁切');
        await harness.shot(page, out, name, `等待态多尺寸复测：${w}×${h} / ${zoom * 100}%，屏幕字号 12.5px 且画框描边完整（组件 fixture）`, {
          skipReady: true, expectText: '还需约', environment: 'deterministic-fixture', theme: 'dark',
        });
      }
      const mobile = await harness.createMobileContext(browser, cfg, { viewport: { width: 390, height: 844 } });
      try {
        for (const [w, h, zoom] of [[1024, 1024, 0.3], [1536, 1024, 0.2], [1024, 1536, 0.3]]) {
          await mobile.page.setContent(fixture(w, h, zoom, 'dark'));
          await assertMeta(mobile.page, zoom, metaLevel(w * zoom, h * zoom));
          const name = `${String(++index).padStart(2, '0')}-mobile-${w}x${h}`;
          await harness.box(mobile.page, mobile.page.getByTestId('generation-progress-meta'), '底边一行可读且未裁切');
          await harness.shot(mobile.page, out, name, `手机等待态复测：390×844 触控视口，${w}×${h} / ${zoom * 100}%，文字和画框完整（组件 fixture）`, {
            skipReady: true, expectText: '还需约', environment: 'deterministic-fixture', theme: 'dark',
          });
        }
      } finally {
        await mobile.ctx.close();
      }
      harness.writeManifest(out, { target: '生图等待态多尺寸组件诊断', verdict: 'conditional', themeSupport: { supportsLight: true } });
    } finally {
      await ctx.close();
      await browser.close();
    }
  });
}
