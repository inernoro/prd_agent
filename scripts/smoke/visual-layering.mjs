#!/usr/bin/env node
/**
 * 视觉创作「AI 分层」端到端冒烟。
 *
 * 为什么存在：这条链路的缺陷（判定卡住、Frame 塌、元素重叠、层数对不上）**只在真实浏览器里
 * 跑真实模型才会现形**，纯函数单测一个都照不出来。此前每一轮都是让用户手工验收再截图反馈，
 * 一次往返十几分钟。这个脚本把那一整轮压成一条命令，判据全部机械可核。
 *
 * 用法：
 *   MAP_SMOKE_USER=xxx MAP_SMOKE_PASS=xxx node scripts/smoke/visual-layering.mjs
 *
 * 环境变量：
 *   MAP_SMOKE_USER / MAP_SMOKE_PASS  必填，冒烟账号
 *   SMOKE_BASE   被测地址；缺省用 cdscli 取当前分支预览域名
 *   SMOKE_SRC    待分层的原图；缺省用 scripts/smoke/assets/layering-source.png
 *   SMOKE_OUT    截图与产物输出目录；缺省 /tmp/map-smoke-layering
 *   SMOKE_PROXY  给 Chromium 用的代理（沙箱里 Chromium 到不了外网时用）
 *
 * 退出码：0 全过；1 有断言失败；2 环境/前置问题（没跑成，不代表功能坏）。
 *
 * 判据设计原则见 .claude/rules/predicate-and-wiring-discipline.md：
 * 每条断言都必须能在「把修复撤掉」时变红，且不依赖任何由本脚本伪造的条件——
 * 尤其**不给跨域响应注入 access-control-allow-origin**，伪造它会把真实的
 * 「跨域读像素被拦」整个藏起来（2026-08-10 就是这么漏掉一轮的）。
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const PW_PATH = process.env.PWPATH || '/opt/node22/lib/node_modules/playwright';
let chromium;
try {
  ({ chromium } = require(PW_PATH));
} catch {
  console.error(`[环境] 找不到 playwright（${PW_PATH}）。设 PWPATH 指向 playwright 安装位置。`);
  process.exit(2);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const OUT = process.env.SMOKE_OUT || '/tmp/map-smoke-layering';
const SRC = process.env.SMOKE_SRC || path.join(HERE, 'assets/layering-source.png');
const USER = process.env.MAP_SMOKE_USER;
const PASS = process.env.MAP_SMOKE_PASS;

if (!USER || !PASS) {
  console.error('[环境] 需要 MAP_SMOKE_USER / MAP_SMOKE_PASS。');
  process.exit(2);
}
if (!fs.existsSync(SRC)) {
  console.error(`[环境] 待分层原图不存在：${SRC}（用 SMOKE_SRC 指定）。`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

function resolveBase() {
  if (process.env.SMOKE_BASE) return process.env.SMOKE_BASE.replace(/\/+$/, '');
  // 预览地址只认 CDS 返回值，禁止本地 slugify（CLAUDE.md §11）。
  const cli = path.join(REPO, '.claude/skills/cds/cli/cdscli.py');
  const first = execSync(`python3 ${JSON.stringify(cli)} --human preview-url`, { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)[0];
  if (!first) throw new Error('cdscli 没返回预览地址');
  return first.replace(/\/+$/, '');
}

// ---------------------------------------------------------------- 断言收集
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

let shotIndex = 0;
const shot = async (page, name) => {
  shotIndex += 1;
  const file = path.join(OUT, `${String(shotIndex).padStart(2, '0')}_${name}.png`);
  await page.screenshot({ path: file });
  return file;
};
const esc = async (page, times = 2) => {
  for (let i = 0; i < times; i += 1) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
};

/**
 * 打开图层面板，且**只在它没开的时候点**。
 * 「图层面板」是个 toggle：分层跑完面板会自己展开，这时再点一下等于把它关掉，
 * 后面找「重新拆分」就永远找不到（第一版冒烟正是这么把三条重拆判据跳过去的）。
 * 判据取面板内部的按钮是否可见，而不是我们自己记的状态——记的状态会和真实 UI 漂移。
 */
const ensurePanelOpen = async (page, marker = '重新拆分') => {
  const inside = page.locator(`button:has-text("${marker}")`).first();
  if (await inside.count() && await inside.isVisible().catch(() => false)) return true;
  const entry = page.locator('button:has-text("图层面板")').first();
  if (!(await entry.count())) return false;
  const box = await entry.boundingBox();
  if (box) await page.mouse.click(box.x + 12, box.y + box.height / 2);
  await page.waitForTimeout(2500);
  return (await inside.count()) > 0;
};

/** 两个矩形是否重叠（留 1px 容差，避免相邻边被判成重叠）。 */
export function rectsOverlap(a, b, tolerance = 1) {
  if (!a || !b) return false;
  return a.x + a.width - tolerance > b.x
    && b.x + b.width - tolerance > a.x
    && a.y + a.height - tolerance > b.y
    && b.y + b.height - tolerance > a.y;
}

async function main() {
  const BASE = resolveBase();
  console.log(`被测地址：${BASE}`);
  console.log(`输出目录：${OUT}\n`);

  const launch = { args: ['--no-sandbox'] };
  if (process.env.SMOKE_PROXY) launch.proxy = { server: process.env.SMOKE_PROXY };
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });

  // 沙箱里 Chromium 可能到不了外网 HTTPS（对象存储上的图会解码失败），而 Node 可以。
  // 开 SMOKE_TUNNEL_CROSS_ORIGIN=1 后由 Node 代取跨域响应再喂回页面。
  // 只换搬运工，**原样透传上游响应头**——绝不补 access-control-allow-origin，
  // 伪造许可会把真实的「跨域读像素被拦」整个藏起来（2026-08-10 的教训）。
  if (process.env.SMOKE_TUNNEL_CROSS_ORIGIN === '1') {
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      try {
        const req = route.request();
        const headers = {};
        for (const [k, v] of Object.entries(req.headers())) {
          if (k.startsWith(':') || ['host', 'connection', 'content-length', 'accept-encoding', 'origin', 'referer'].includes(k)) continue;
          headers[k] = v;
        }
        const upstream = await fetch(url, {
          method: req.method(),
          headers,
          body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer(),
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        const out = {};
        upstream.headers.forEach((v, k) => { if (!['content-encoding', 'content-length'].includes(k)) out[k] = v; });
        await route.fulfill({ status: upstream.status, headers: out, body });
      } catch {
        await route.abort();
      }
    });
  }
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/fonts|favicon/.test(t)) consoleErrors.push(t.slice(0, 200));
  });

  try {
    // ---- 登录 + 从首页点进视觉创作（不用地址栏直达业务页）
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[type=text]', { timeout: 30000 });
    await page.fill('input[type=text]', USER);
    await page.fill('input[type=password]', PASS);
    await page.click('button:has-text("进入控制台")');
    await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 30000 });
    await page.waitForTimeout(2500);
    await esc(page);

    await page.getByText('视觉创作').first().click({ force: true });
    await page.waitForTimeout(4000);
    await esc(page);
    // 点进去可能直接续上最近画布；回列表再新建，保证每轮都是干净画布
    if (/\/visual-agent\/[^/]+$/.test(new URL(page.url()).pathname)) {
      await page.goto(`${BASE}/visual-agent`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      await esc(page);
    }
    const newProject = page.locator('[data-tour-id="visual-new-project"]').first();
    if (await newProject.count()) {
      const box = await newProject.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForSelector('text=新建 Workspace', { timeout: 15000 });
      await page.locator('input').last().fill(`分层冒烟-${Date.now().toString(36)}`);
      await page.locator('button:has-text("创建")').first().click();
    }
    await page.waitForFunction(() => /\/visual-agent\/[^/]+$/.test(location.pathname), { timeout: 40000 });
    await page.waitForTimeout(6000);
    await esc(page);
    const workspaceUrl = page.url();
    console.log(`画布：${workspaceUrl}\n`);

    // ---- 放原图
    const fileInput = page.locator('input[type=file]').first();
    if (await fileInput.count()) await fileInput.setInputFiles(SRC);
    else {
      const chooser = page.waitForEvent('filechooser', { timeout: 15000 });
      await page.locator('button:has-text("图片"), button:has-text("上传")').first().click({ force: true });
      (await chooser).setFiles(SRC);
    }
    // 等到图片真的解码出来并占据可点面积——只看 src 挂上了不算
    await page.waitForFunction(
      () => [...document.querySelectorAll('img')]
        .some((i) => i.naturalWidth > 200 && i.getBoundingClientRect().width > 60),
      { timeout: 180000 },
    );
    await page.waitForTimeout(4000);
    await esc(page);

    // ---- 选中原图 → AI 分层
    const images = page.locator('img');
    let srcBox = null;
    for (let i = 0; i < await images.count(); i += 1) {
      const el = images.nth(i);
      const info = await el.evaluate((node) => ({ nw: node.naturalWidth, w: node.getBoundingClientRect().width }));
      if (info.nw > 200 && info.w > 60) { srcBox = await el.boundingBox(); break; }
    }
    if (!srcBox) {
      const dump = await page.evaluate(() => [...document.querySelectorAll('img')]
        .map((n) => ({ nw: n.naturalWidth, w: Math.round(n.getBoundingClientRect().width), src: n.src.slice(0, 60) })));
      console.log('  [诊断] 页面上的 img：', JSON.stringify(dump));
    }
    check('原图已落到画布上', !!srcBox);
    if (!srcBox) throw new Error('画布上没有可选中的原图');
    await page.mouse.click(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
    await page.waitForTimeout(1500);
    const layerBtn = page.locator('button:has-text("AI 分层")').first();
    check('画布上能找到「AI 分层」入口', await layerBtn.count() > 0);
    if (!(await layerBtn.count())) throw new Error('没有分层入口，后续判据无从谈起');
    await layerBtn.click({ force: true });
    // 点「AI 分层」不该直接开拆，要先给用户说话的机会（用户原话：点完就拆了，
    // 根本没有输入自然语言的地方）。但也不能变慢——输入框自动聚焦、回车即开拆。
    await page.waitForTimeout(800);
    const intentInput = page.locator('[data-testid="layer-intent-input"]').first();
    const hasIntentBubble = await intentInput.count() > 0;
    check('点「AI 分层」先弹出拆法输入（不是点完就闷头开拆）', hasIntentBubble);
    if (hasIntentBubble) {
      const focused = await page.evaluate(() =>
        document.activeElement?.getAttribute('data-testid') === 'layer-intent-input');
      check('拆法输入框自动聚焦（回车即开拆，不比以前慢）', focused);
      await intentInput.fill('把人物和背景分开');
      await intentInput.press('Enter');
    }

    // ---- 等待态：三个头部元素不许互相压住（纯几何判据，肉眼看图容易漏）
    // 必须**跨缩放档位**测：这些标签用 scale(1/zoom) 反向放大以保持屏幕尺寸恒定，
    // 缩得越小它们相对 Frame 就越大，低倍下才会撞上（用户 12% 截图即此）。
    await page.waitForTimeout(3000);
    const measureOverlap = () => page.evaluate(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      // 按稳定钩子找，**不按文字找**。
      // 这三个标签在低倍下会按档收起（Frame 头部 <420px 换成短文案、按钮 <260px 只剩图标），
      // 那正是产品用来避免互相压住的手段。靠文字找的话，一收起选择器就失配，那几档
      // 等于没测——而低倍恰恰是最容易撞的区间（用户当初就是 12% 的截图）。
      const visible = (el) => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
      const headline = [...document.querySelectorAll('[data-frame-handle]')].find(visible);
      const panelBtn = [...document.querySelectorAll('[data-testid="frame-panel-button"]')].find(visible);
      const badge = [...document.querySelectorAll('[data-testid="frame-layering-badge"]')].find(visible);
      const named = [['Frame 头部', headline], ['图层面板按钮', panelBtn], ['图层分离中标记', badge]]
        .filter(([, el]) => el)
        .map(([name, el]) => ({ name, rect: rect(el) }));
      const hits = [];
      for (let i = 0; i < named.length; i += 1) {
        for (let j = i + 1; j < named.length; j += 1) {
          const a = named[i].rect; const b = named[j].rect;
          const over = a.x + a.width - 1 > b.x && b.x + b.width - 1 > a.x
            && a.y + a.height - 1 > b.y && b.y + b.height - 1 > a.y;
          if (over) hits.push(`${named[i].name} × ${named[j].name}`);
        }
      }
      return { present: named.map((n) => n.name), hits };
    });
    // 缩小：直接对画布发 ctrl+滚轮（与 gesture-unification 约定的缩放手势一致），
    // 不依赖没有文字的工具条按钮——按钮顺序一变，脚本就会静默点到「放大」，
    // 那样这条判据永远测不到低倍档（第一版就踩了这个，50% 一路点到 66%）。
    // 只发 ctrl+滚轮这一下。原来前面还多发了一次**不带修饰键**的滚轮，
    // 而按 gesture-unification 的约定，不带修饰键的滚轮是「平移」不是「缩放」——
    // 14 轮下来把画布推走了几千世界像素，控件飘出视口。旧的宽松判据把找不到的控件
    // 过滤掉，正好把这个跑偏藏住了（detail 里打印的又是第一档的 present，看不出后面
    // 已经在掉控件）。上一条判据收紧之后，这个坑就会直接现形（Codex PR #1363 P2）。
    const zoomOut = async () => {
      await page.mouse.move(700, 500);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, 260);
      await page.keyboard.up('Control');
      await page.waitForTimeout(700);
    };
    const zoomLabel = () => page.evaluate(() => (document.body.innerText.match(/\b(\d{1,3})%/) || [])[1] || '?');
    const overlapReport = [];
    for (let step = 0; step < 14; step += 1) {
      const zoom = await zoomLabel();
      const hit = await measureOverlap();
      overlapReport.push({ zoom, hits: hit.hits, present: hit.present });
      if (hit.hits.length) await shot(page, `overlap-at-${zoom}`);
      await zoomOut();
    }
    // 生成中不许提前下「模型实际给出 N 层」的结论——那会儿只铺了占位卡。
    const prematureVerdict = await page.evaluate(() => /模型实际给出/.test(document.body.innerText));
    check('生成中不提前宣布「模型实际给出 N 层」', !prematureVerdict);

    const bad = overlapReport.filter((r) => r.hits.length);
    // 三个控件必须**每一档都在场**才算测过。
    //
    // measureOverlap 会把找不到的控件过滤掉，而「没有两两配对」自然就没有重叠——
    // 于是分层提前跑完、或任何一个选择器漂了，这条判据都会在「一个都没比」的情况下
    // 判绿，宣称三个控件从不遮挡（Codex PR #1363 P2；正是本仓库判据纪律里的形状 4：
    // 不会红的证据比没有证据更糟）。缺控件时必须显式判红让人来看，不许静默放行。
    const EXPECTED_CONTROLS = ['Frame 头部', '图层面板按钮', '图层分离中标记'];
    const incomplete = overlapReport
      .map((r) => ({ zoom: r.zoom, missing: EXPECTED_CONTROLS.filter((name) => !r.present.includes(name)) }))
      .filter((r) => r.missing.length);
    const waitingShot = await shot(page, 'waiting');
    check(
      '等待态的 Frame 头部 / 图层面板按钮 / 分层中标记在各缩放档位都不遮挡',
      overlapReport.length > 0 && bad.length === 0 && incomplete.length === 0,
      bad.length
        ? `重叠档位：${bad.map((r) => `${r.zoom}%(${r.hits.join('、')})`).join('；')}`
        : incomplete.length
          ? `控件缺席，这一档等于没测：${incomplete.map((r) => `${r.zoom}%缺[${r.missing.join('、')}]`).join('；')}`
            + `（改用稳定钩子取元素之后，缺席就是真的没渲染——不要再当成「分层提前跑完」放过；`
            + `第一版按文字找，低倍下标签一收起就失配，那几档静默没测，正是这条判据要防的事）`
          : `测过 ${overlapReport.map((r) => `${r.zoom}%`).join('/')}，三个控件每档都在场（见 ${waitingShot}）`,
    );

    // ---- 闭环：等图层行真的渲染出来（覆盖率文案 = 内容判定已跑完）
    const deadline = Date.now() + 480000;
    let rendered = false;
    while (Date.now() < deadline) {
      const body = await page.evaluate(() => document.body.innerText);
      if (/覆盖\s*[\d.]+%|覆盖 不足/.test(body)) { rendered = true; break; }
      await page.waitForTimeout(5000);
    }
    const readyShot = await shot(page, rendered ? 'layers-ready' : 'layers-timeout');
    check('分层完成且图层面板出行（不拿 spinner 冒充）', rendered, rendered ? '' : `480s 未出结论，见 ${readyShot}`);
    if (!rendered) throw new Error('未闭环，后续判据不成立');

    // ---- 面板逐行事实
    const rows = await page.evaluate(() => [...document.querySelectorAll('div')]
      .filter((d) => /^图层 \d{2}$|^原图参考层$/.test((d.textContent || '').trim()) && d.children.length === 0)
      .map((d) => ({
        name: d.textContent.trim(),
        fact: (d.parentElement?.querySelector('div:nth-child(2)')?.textContent || '').trim(),
      })));
    check('图层行数 ≥ 2', rows.length >= 2, `实到 ${rows.length} 行`);
    check('每行主标题互不相同', new Set(rows.map((r) => r.name)).size === rows.length,
      rows.map((r) => r.name).join(' / '));
    // 原缺陷是「所有行显示同一串全局文本（文件名）」，所以判据是「事实行必须随层变化
    // 且带本层的量」。不要求全局唯一——两层覆盖率确实可能完全相同，那不是缺陷。
    const facts = rows.map((r) => r.fact);
    check('事实行随层变化，不是所有行同一串字',
      new Set(facts).size > 1,
      rows.map((r) => `${r.name}:${r.fact}`).join(' | '));
    check('每行事实行都带本层的覆盖率',
      facts.every((f) => /覆盖\s*(不足\s*)?[\d.]+%|覆盖 不足/.test(f)),
      facts.filter((f) => !/覆盖/.test(f)).join(' | ') || '');
    const dupes = facts.filter((f, i) => facts.indexOf(f) !== i);
    if (dupes.length) console.log(`  [提示] 有 ${dupes.length} 行事实完全相同：${[...new Set(dupes)].join(' / ')}`);
    check('没有任何一行停在「正在识别内容」',
      rows.every((r) => !r.fact.includes('正在识别')),
      rows.filter((r) => r.fact.includes('正在识别')).map((r) => r.name).join('、') || '',
    );

    // ---- 层数：面板显示的数字必须能解释实到层数
    const countText = await page.evaluate(() => {
      const t = document.body.innerText;
      const next = (t.match(/期望拆[\s\S]{0,12}?(\d+)[\s\S]{0,4}?层/) || [])[1];
      const explain = /本次请求 \d+ 层，模型实际给出 \d+ 层/.test(t);
      return { next: next ? Number(next) : null, explain };
    });
    check('层数控件有值', countText.next !== null, `下次拆 ${countText.next} 层`);

    // ---- 同一张图必须能反复拆：再点一次要真的重跑模型，不许拿旧结果搪塞
    const beforeResplit = await page.evaluate(() => [...document.querySelectorAll('img')]
      .map((i) => i.src).filter((src) => /assets|cfi\./.test(src)));
    // 走图层面板的「重新拆分」——叠放之后原图被压在最底下，点画布中心命中的是最上面
    // 那一层，等于拿一个图层去再拆（分辨率也会跟着那层走）。重拆的正规入口在面板里。
    await ensurePanelOpen(page);
    const layerAgain = page.locator('button:has-text("重新拆分")').first();
    // 拖走判据要认「这一轮新开的那个 Frame」，所以先记下开跑前已有哪些抓手。
    const frameHandleIds = () => page.evaluate(() => [...document.querySelectorAll('[data-frame-handle]')]
      .map((el) => el.getAttribute('data-frame-handle')).filter(Boolean));
    const framesBeforeResplit = await frameHandleIds();
    /**
     * 这一组落在**世界坐标**的哪里（读 style.left/top，不读 getBoundingClientRect）。
     *
     * 屏幕坐标在这条判据上是错的：分层跑完会做一次视角适配，镜头一动，同一个元素的
     * 屏幕坐标就变了。第一版拿屏幕坐标比，量到的是「镜头移动」而不是「图层落位」
     * （实测：拖前拖后都是 1265，跑完变 859——那 406px 全是镜头的功劳）。
     */
    const frameOrigin = (frameId) => page.evaluate((fid) => {
      const points = [...document.querySelectorAll('[data-canvas-key]')]
        .filter((el) => el.getAttribute('data-frame-id') === fid)
        .map((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (!points.length) return null;
      return {
        count: points.length,
        x: Math.round(Math.min(...points.map((p) => p.x))),
        y: Math.round(Math.min(...points.map((p) => p.y))),
      };
    }, frameId);
    /**
     * 把某个 Frame 的抓手平移到「鼠标真的点得到」的位置，返回可用的落点。
     *
     * 新副本落在原图右侧，通常正压在图层面板底下（面板占右侧约 310px）。
     * boundingBox() 不知道遮挡，照样返回坐标，于是 mouse.down 落在面板上，
     * 拖出来位移是 0——两轮真机跑都栽在这里。所以必须用 elementFromPoint
     * 确认那个点上最顶层的确实是这个抓手。
     *
     * 只平移、不缩放、不动面板：
     * - 动面板会把它切到别的组（面板按钮是「切到本组」不是「关闭」），
     *   后面所有依赖面板的判据会连锁失败（实测一次连废 4 条）。
     * - 动缩放会让后面按屏幕像素比对的判据出现亚像素误差。
     */
    const bringHandleIntoReach = async (frameId) => {
      for (let step = 0; step < 24; step += 1) {
        const box = await page.locator(`[data-frame-handle="${frameId}"]`).first()
          .boundingBox().catch(() => null);
        if (box) {
          const cx = box.x + Math.min(box.width, 80) / 2;
          const cy = box.y + box.height / 2;
          // 留出往右拖的余量，也别贴着上下边缘。
          const roomy = cx > 60 && cx < 1100 && cy > 60 && cy < 780;
          if (roomy) {
            const hit = await page.evaluate(([x, y, fid]) => {
              const el = document.elementFromPoint(x, y);
              if (!el) return 'nothing';
              const owner = el.closest('[data-frame-handle]');
              if (owner) return owner.getAttribute('data-frame-handle') === fid ? 'ok' : 'other-frame';
              return `${el.tagName}:${String(el.className || '').slice(0, 40)}`;
            }, [cx, cy, frameId]);
            if (hit === 'ok') return { cx, cy };
          }
        }
        // 两指拖动 = 平移（gesture-unification）：deltaX 为正把内容往左推。
        await page.mouse.move(700, 500);
        await page.mouse.wheel(260, 0);
        await page.waitForTimeout(350);
      }
      return null;
    };
    let midSplitDrag = null;
    if (await layerAgain.count()) {
      await layerAgain.click({ force: true });
      await page.waitForTimeout(4000);
      const reusedToast = await page.evaluate(() => /已复用|无需再次调用模型/.test(document.body.innerText));
      check('再次分层不会被「已复用」短路挡住', !reusedToast);

      // ---- 【关键】拆分途中把 Frame 拖走，后到的图层必须跟着落到新位置
      // 2026-08-11 用户实测：「在拆分进行时，我把正在渲染的拆分 frame 移动到了另一个地方，
      // 我忽然发现，拆分的图层居然在最开始的 frame 位置渲染」。根因是落位坐标在开跑那一刻
      // 就按 copyRect 定死了。判据必须在「还有图层没到」的时候拖——拖完就没人再落位的话，
      // 这条断言撤掉修复也不会红（形状 4：永远绿的测试）。所以下面同时断言「拖之后确实
      // 又有图层到达」，没到达就判失败而不是放行。
      let liveFrameId = null;
      const findUntil = Date.now() + 120000;
      while (Date.now() < findUntil) {
        const fresh = (await frameHandleIds()).filter((id) => !framesBeforeResplit.includes(id));
        if (fresh.length) { liveFrameId = fresh[0]; break; }
        await page.waitForTimeout(1500);
      }
      if (!liveFrameId) {
        check('拆分途中能认出新开的 Frame（拖走判据的前提）', false, '120s 内没出现新的 Frame 抓手');
      } else {
        const grip = await bringHandleIntoReach(liveFrameId);
        const before = await frameOrigin(liveFrameId);
        if (!before || !grip) {
          check('拆分途中能抓住新 Frame 的头部', false,
            `组内元素 ${before ? before.count : 0} 个，`
              + `${grip ? '有落点' : '平移 24 步后抓手仍被遮挡或不在可拖区域'}`);
        } else {
          // 往右下拖：向右只会拉大与原图那一簇的间距，不会破坏后面的「两簇」判据。
          const dx = 240;
          const dy = 180;
          await page.mouse.move(grip.cx, grip.cy);
          await page.mouse.down();
          await page.mouse.move(grip.cx + dx, grip.cy + dy, { steps: 16 });
          await page.mouse.up();
          await page.waitForTimeout(1500);
          const after = await frameOrigin(liveFrameId);
          // 屏幕位移换算成世界位移要除以缩放，这里不去读缩放值——只判「真的往右下动了、
          // 而且动的量不是零头」。具体动了多少写进 detail，供人工核对。
          const worldDx = after ? after.x - before.x : 0;
          const worldDy = after ? after.y - before.y : 0;
          check('拆分途中拖 Frame，它当场就跟着走了',
            worldDx > 80 && worldDy > 40,
            `世界坐标从 (${before.x},${before.y}) 移到 (${after ? after.x : '?'},${after ? after.y : '?'})，`
              + `位移 (${worldDx},${worldDy})`);
          await shot(page, 'dragged-mid-split');
          if (after && worldDx > 80) {
            // 记下「拖之后的落脚点」和「原来的落脚点」，等这一轮跑完再回来对账。
            midSplitDrag = {
              frameId: liveFrameId,
              home: before,
              moved: after,
              countAtDrag: after.count,
            };
          }
        }
      }

      /**
       * 等第二轮真的出结果——只看**这一组自己**的图层状态。
       *
       * 旧写法读整页文本，命中「覆盖 X%」就算跑完。但那串文字第一组也有：真机实测
       * （2026-08-12 第 4 次跑）第二组只落了 1 块占位卡、卡在 running，这条判据照样
       * 判绿，靠的是第一组的面板行。一个不会红的证据比没有证据更糟，所以改成按
       * data-frame-id 圈定本组，要求本组至少 2 块、且没有一块还在 running。
       */
      const liveGroupState = async () => (liveFrameId ? page.evaluate((fid) => {
        const items = [...document.querySelectorAll('[data-canvas-key]')]
          .filter((el) => el.getAttribute('data-frame-id') === fid);
        const statusOf = (el) => el.getAttribute('data-layer-status') || '';
        return {
          total: items.length,
          done: items.filter((el) => statusOf(el) === 'done').length,
          running: items.filter((el) => statusOf(el) === 'running').length,
          error: items.filter((el) => statusOf(el) === 'error').length,
        };
      }, liveFrameId) : null);
      const until = Date.now() + 480000;
      let second = false;
      let lastState = null;
      while (Date.now() < until) {
        lastState = await liveGroupState();
        if (lastState) {
          if (lastState.total >= 2 && lastState.running === 0) { second = lastState.done === lastState.total; break; }
        } else {
          // 连新 Frame 都没认出来时退回整页文本判断，并在 detail 里说明证明力较弱。
          const body = await page.evaluate(() => document.body.innerText);
          if (/覆盖\s*[\d.]+%|覆盖 不足/.test(body) && !/生成中/.test(body)) { second = true; break; }
        }
        await page.waitForTimeout(5000);
      }
      await shot(page, second ? 'second-split' : 'second-split-timeout');
      check('第二次分层能跑完并出结果', second,
        lastState
          ? `本组 ${lastState.total} 块：done ${lastState.done} / running ${lastState.running} / error ${lastState.error}`
          : '（未认出新 Frame，退回整页文本判断，证明力弱）');

      if (midSplitDrag) {
        const final = await frameOrigin(midSplitDrag.frameId);
        // 全组在拖动时一起右移，之后到达的图层都从组原点起算（裁剪只会让它更靠右），
        // 所以这一组的最左世界坐标必须仍贴着「拖之后的原点」。若有任何一块按开跑时的
        // 坐标落位，最左值会掉回「原来的原点」——那正是用户看到的 bug。
        const tolerance = 40;
        const landedAtMoved = !!final && final.x >= midSplitDrag.moved.x - tolerance;
        // 这条判据没有空跑的保证：拖走之后确实又有图层落进来了。
        const grew = !!final && final.count > midSplitDrag.countAtDrag;
        check('拖走之后到达的图层落在新位置，不回到最初那块地',
          landedAtMoved,
          `世界坐标：原位 x=${midSplitDrag.home.x}，拖后 x=${midSplitDrag.moved.x}，`
            + `跑完最左 x=${final ? final.x : '组消失了'}`);
        check('拖走之后确实还有图层继续到达（这条判据没有空跑）', grew,
          `拖走时 ${midSplitDrag.countAtDrag} 块，跑完 ${final ? final.count : 0} 块`);
      }
      const afterResplit = await page.evaluate(() => [...document.querySelectorAll('img')]
        .map((i) => i.src).filter((src) => /assets|cfi\./.test(src)));
      const changed = afterResplit.some((src) => !beforeResplit.includes(src));
      check('第二次拿到的是新产物（不是把上一轮原样端回来）', changed,
        `旧 ${beforeResplit.length} 张 / 新 ${afterResplit.length} 张`);
      // 2026-08-11 用户反馈：「我重新生成新的图层时候，他居然将原来的清理掉了？」
      // 重拆是「右边再多一份」，不是「覆盖这一份」。上一轮的产物必须一张不少地还在。
      const survived = beforeResplit.filter((src) => afterResplit.includes(src));
      check('重拆没有删掉上一轮的结果（两份并排可比较）',
        beforeResplit.length > 0 && survived.length === beforeResplit.length,
        `上一轮 ${beforeResplit.length} 张，重拆后仍在 ${survived.length} 张`);
    } else {
      check('图层面板里能找到「重新拆分」', false, '按钮不存在');
    }

    // ---- 副本落在原图右侧，原图原封不动
    // 只取画布元素（data-canvas-key）。用 img 会把图层面板里的预览缩略图一起算进来——
    // 那是面板不是画布，混在一起会得出「画布上多了一组幽灵图层」的错误结论（实测栽过两轮）。
    const worldRects = await page.evaluate(() => [...document.querySelectorAll('[data-canvas-key]')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 40 && r.height > 40)
      .map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))
      .sort((a, b) => a.x - b.x));
    // 原图必须还在：它是那颗没被切过的西瓜，用来和副本对照。
    // 判据取「最左边那块的面积应当明显大于最小的那块」不成立（原图可能被裁块超过），
    // 所以直接看横向是不是分成了两簇：原图一簇、副本一簇，且两簇不相交。
    const spanLeft = Math.min(...worldRects.map((r) => r.x));
    const spanRight = Math.max(...worldRects.map((r) => r.x + r.w));
    const gapAt = (() => {
      const sorted = [...worldRects].sort((a, b) => a.x - b.x);
      let edge = -Infinity;
      for (const r of sorted) {
        if (edge !== -Infinity && r.x > edge + 8) return { edge, next: r.x };
        edge = Math.max(edge, r.x + r.w);
      }
      return null;
    })();
    check('画布上分成「原图 + 右侧副本」两簇，原图没被盖住也没被删',
      !!gapAt && spanRight - spanLeft > 0,
      gapAt ? `两簇之间留白 ${Math.round(gapAt.next - gapAt.edge)}px` : `只有一簇：${JSON.stringify(worldRects)}`);

    // ---- 面板：自然语言拆法入口必须在（层数不再是唯一选择）
    await ensurePanelOpen(page);
    const intentBox = await page.evaluate(() => {
      const el = [...document.querySelectorAll('input')]
        .find((i) => /想怎么拆/.test(i.placeholder || ''));
      return el ? { ok: true, placeholder: el.placeholder } : { ok: false, placeholder: '' };
    });
    check('图层面板有自然语言拆法输入框', intentBox.ok, intentBox.placeholder);
    // 这里能拿到的多半是能力标识（image-layering），不是模型名。判据只认「如实说清是哪一条」，
    // 不认「把能力 id 摆出来当模型名」——后者是假事实，用户据此判断不了任何东西。
    const modelLine = await page.evaluate(() => ({
      honest: /本组走「.+」能力路由，具体模型由网关决定|本组由 .+ 拆分/.test(document.body.innerText),
      fake: /本组由 image-layering 拆分/.test(document.body.innerText),
    }));
    check('图层面板如实说明本组走了哪条能力/模型', modelLine.honest && !modelLine.fake,
      modelLine.fake ? '把能力标识 image-layering 当模型名显示了' : '');
    // 「最多拆 N 层」是个做不到的承诺：模型可能给得更多（实测请求 3 层给了 4 层）。
    const capWording = await page.evaluate(() => /最多拆/.test(document.body.innerText));
    check('层数文案不承诺做不到的上限', !capWording, capWording ? '仍写着「最多拆」' : '');

    // ---- 刷新后排版不塌
    // 先等画布静止：裁剪落位是异步的（读图 → 量包围盒 → 上传裁剪结果 → 回写），
    // 还在动的时候拍快照，比的就不是同一个状态。连续两次尺寸签名一致才算稳。
    const sizeSignature = () => page.evaluate(() => [...document.querySelectorAll('[data-canvas-key]')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 60 && r.height > 60)
      .map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`)
      .sort().join('|'));
    let settled = '';
    for (let i = 0; i < 45; i += 1) {
      const a = await sizeSignature();
      await page.waitForTimeout(2000);
      const b = await sizeSignature();
      if (a === b && b) { settled = b; break; }
    }
    check('裁剪落位会收敛（画布不会一直在动）', !!settled, settled ? `稳定于 ${settled}` : '90s 内未静止');
    // 落盘是 debounce 的，静止之后再给它一个窗口，别把「还没写完」误判成「写丢了」。
    await page.waitForTimeout(6000);
    const beforeReloadRects = await page.evaluate(() => [...document.querySelectorAll('[data-canvas-key]')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 60 && r.height > 60)
      .map((r) => ({ w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) })));
    // 诊断（不是判据）：刷新前后各打一份「这张图是谁、地址长什么样」，
    // 丢东西的时候能一眼看出丢的是哪一组、以及它的 src 是资产地址还是模型直链。
    const dumpImages = () => page.evaluate(() => [...document.querySelectorAll('[data-canvas-key]')]
      .map((el) => ({ r: el.getBoundingClientRect(), el }))
      .filter((x) => x.r.width > 40 && x.r.height > 40)
      .map((x) => `${Math.round(x.r.width)}x${Math.round(x.r.height)} @${Math.round(x.r.x)}`
        + ` group=${x.el.getAttribute('data-layer-group') || '-'}`
        + ` idx=${x.el.getAttribute('data-layer-index') || '-'}`
        + ` role=${x.el.getAttribute('data-layer-role') || '-'}`
        + ` st=${x.el.getAttribute('data-layer-status') || '-'}`));
    console.log('  [诊断] 刷新前：\n    ' + (await dumpImages()).join('\n    '));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(14000);
    await esc(page);
    const reloadShot = await shot(page, 'after-reload');
    const rects = await page.evaluate(() => [...document.querySelectorAll('[data-canvas-key]')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 60 && r.height > 60)
      .map((r) => ({ w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) })));
    // 刷新前后每块的尺寸必须一模一样。
    // 判据不能写成「所有图块等大」——那是上一版的错误模型（各层都是满幅方块）。
    // 现在每块都被裁成自己的最小非透明外接矩形，本来就该各不相同；
    // 真正要防的是「尺寸没落盘，刷新后被 onLoad 的 natural 尺寸覆盖」。
    const sizeKey = (list) => list.map((r) => `${r.w}x${r.h}`).sort().join('|');
    check('刷新后每块尺寸与刷新前一致（排版真的落盘了）',
      rects.length >= 2 && sizeKey(rects) === sizeKey(beforeReloadRects),
      `刷新前 ${sizeKey(beforeReloadRects)} / 刷新后 ${sizeKey(rects)}（见 ${reloadShot}）`);
    // 「最小非透明外接矩形」的可核对判据：各部件尺寸不该全都一样——
    // 全都一样就说明根本没裁，每块仍是满幅方块（2026-08-11 用户圈图指出的正是这个）。
    console.log('  [诊断] 刷新后：\n    ' + (await dumpImages()).join('\n    '));
    const uniqueSizes = [...new Set(rects.map((r) => `${r.w}x${r.h}`))];
    check('部件被裁成最小非透明外接矩形（不是清一色满幅方块）',
      uniqueSizes.length >= 2,
      `尺寸集合 ${JSON.stringify(uniqueSizes)}`);

    // ---- 导出 PSD：层名互不相同，文件非空
    await ensurePanelOpen(page);
    const exportBtn = page.locator('button:has-text("导出分层 PSD")').first();
    if (await exportBtn.count()) {
      const download = page.waitForEvent('download', { timeout: 300000 });
      await exportBtn.click({ force: true });
      try {
        const file = path.join(OUT, 'export.psd');
        await (await download).saveAs(file);
        const bytes = fs.statSync(file).size;
        const buf = fs.readFileSync(file);
        // 不靠在字节流里 grep 层名——那只能证明这几个字出现过。
        // 真正的校验是把 PSD **反读**回来：层数对不对、每层有没有自己的包围盒、
        // 画布尺寸是不是原图。用户要的「PSD 格式得到校验」就是这个意思。
        let parsed = null;
        let parseError = '';
        try {
          const { readPsd } = await import(path.join(REPO, 'prd-admin/node_modules/ag-psd/dist/index.js'));
          parsed = readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
        } catch (e) { parseError = String(e).slice(0, 120); }
        const group = parsed?.children?.find((c) => Array.isArray(c.children) && c.children.length);
        const psdLayers = group?.children ?? [];
        const names = new Set(psdLayers.map((l) => String(l.name ?? '')));
        const sized = psdLayers.filter((l) => (l.right ?? 0) - (l.left ?? 0) > 0 && (l.bottom ?? 0) - (l.top ?? 0) > 0);
        // 「满幅」要留容差：拉伸过的层因为边缘一两列近透明，包围盒会算成 1022x1022，
        // 而判据写成 >= 1024 就把它当成「有界」放过去了。真机实测正是这样漏掉一条 P1：
        // 覆盖 14% 的层在 PSD 里占 1021x1024，冒烟却报「满幅 2」判绿（Codex PR #1363 P1）。
        // 判据太窄的典型形态——差一像素就翻转结论（.claude/rules 形状 1）。
        const nearlyFull = (span, full) => full > 0 && span >= full * 0.98;
        const fullCanvas = psdLayers.filter((l) => nearlyFull((l.right ?? 0) - (l.left ?? 0), parsed?.width ?? 0)
          && nearlyFull((l.bottom ?? 0) - (l.top ?? 0), parsed?.height ?? 0));
        check('导出的 PSD 能被反读回来（不是只有个文件头）', !!parsed, parseError);
        check('PSD 是真分层：可编辑图层组里有多层',
          psdLayers.length >= 2, `层数 ${psdLayers.length}`);
        // 原图是 1024x1024 的 fixture；导出比它小就是掉分辨率，不能只判「大于 0」。
        check('PSD 画布尺寸 = 原图尺寸（不许掉分辨率）',
          !!parsed && parsed.width >= 1024 && parsed.height >= 1024,
          parsed ? `${parsed.width}x${parsed.height}` : '');
        check('每层都有自己的包围盒（不是每层都铺满整张画布）',
          sized.length >= 2 && fullCanvas.length < psdLayers.length,
          `有界 ${sized.length}/${psdLayers.length}，满幅 ${fullCanvas.length}`);
        check('导出的 PSD 非空且是真 PSD', bytes > 10000 && buf.subarray(0, 4).toString() === '8BPS', `${bytes} bytes`);
        check('PSD 里的层名互不相同', names.size >= 2, [...names].slice(0, 6).join(' / '));
      } catch (error) {
        check('导出分层 PSD', false, String(error).slice(0, 120));
      }
    } else {
      check('图层面板里能找到「导出分层 PSD」', false, '按钮不存在');
    }

    // ---- 单层 PNG 下载必须是裁剪版（这条欠了两轮，靠逻辑推导不算数）
    await ensurePanelOpen(page);
    // 必须挑**覆盖率最低**那一层来验证裁剪。
    // 随便挑一层是站不住的：背景层覆盖率 100%，它的最小非透明矩形本来就等于整幅，
    // 拿它当样本，无论裁没裁都会「通过」——那是恒成立的证据，等于没测
    //（第一版就这么自己骗了自己一次，见 predicate-and-wiring-discipline 形状 8）。
    const sparsest = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('[data-testid="layer-download"]')];
      let best = { index: -1, coverage: Infinity };
      buttons.forEach((button, index) => {
        const row = button.closest('div')?.parentElement?.parentElement;
        const text = row?.textContent || '';
        const m = text.match(/覆盖\s*([\d.]+)%/);
        const coverage = m ? Number(m[1]) : Infinity;
        if (coverage < best.coverage) best = { index, coverage };
      });
      return best;
    });
    check('能找到一个覆盖率明显不足 100% 的图层来验证裁剪',
      sparsest.index >= 0 && sparsest.coverage < 90,
      `第 ${sparsest.index + 1} 个下载按钮，覆盖 ${sparsest.coverage}%`);
    if (sparsest.index >= 0 && sparsest.coverage < 90) {
      const pngWait = page.waitForEvent('download', { timeout: 120000 });
      await page.locator('[data-testid="layer-download"]').nth(sparsest.index).click({ force: true });
      try {
        const pngFile = path.join(OUT, 'layer.png');
        await (await pngWait).saveAs(pngFile);
        const buf = fs.readFileSync(pngFile);
        // PNG 的 IHDR 固定在第 16 字节起：宽高各 4 字节大端。不引库，直接读。
        const isPng = buf.length > 24 && buf.subarray(1, 4).toString('ascii') === 'PNG';
        const pw = isPng ? buf.readUInt32BE(16) : 0;
        const ph = isPng ? buf.readUInt32BE(20) : 0;
        check('单层 PNG 能下载且是真 PNG', isPng && buf.length > 1000, `${buf.length} bytes`);
        // 模型返回的图层是 640² 满幅；一个覆盖率只有个位数/十几的部件，
        // 裁完面积必然远小于整幅。用面积比判，比单看某一边更难蒙混。
        const areaRatio = pw > 0 && ph > 0 ? (pw * ph) / (640 * 640) : 1;
        check('单层 PNG 是裁剪版（面积显著小于整幅，不是没裁过的满幅图）',
          isPng && areaRatio < 0.8,
          `${pw}x${ph}，占整幅 ${(areaRatio * 100).toFixed(1)}%（该层覆盖 ${sparsest.coverage}%）`);
      } catch (error) {
        check('单层 PNG 能下载且是真 PNG', false, String(error).slice(0, 120));
      }
    }

    // ---- 拖 Frame 头部 = 整组一起走（用户标注：图层要能选中一起拖拽）
    const handle = page.locator('[data-frame-handle]').first();
    if (await handle.count()) {
      const before = await page.evaluate(() => [...document.querySelectorAll('[data-canvas-key]')]
        .map((el) => ({ k: el.getAttribute('data-canvas-key'), r: el.getBoundingClientRect() }))
        .map((x) => ({ k: x.k, x: Math.round(x.r.x), y: Math.round(x.r.y) })));
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(1200);
      const after = await page.evaluate(() => [...document.querySelectorAll('[data-canvas-key]')]
        .map((el) => ({ k: el.getAttribute('data-canvas-key'), r: el.getBoundingClientRect() }))
        .map((x) => ({ k: x.k, x: Math.round(x.r.x), y: Math.round(x.r.y) })));
      const moved = after.filter((a) => {
        const b = before.find((item) => item.k === a.k);
        return b && (Math.abs(a.x - b.x) > 20 || Math.abs(a.y - b.y) > 20);
      });
      // 整组一起走：动的应当不止一个，且它们的位移一致（真的是「一起」而不是各挪各的）。
      // 「一致」允许 2px 亚像素误差——非整数缩放下 getBoundingClientRect 会给出
      // 120,60 与 120,59 这种差一像素的读数，那是取整噪声不是「各挪各的」
      //（实测栽过一轮：整组确实一起动了，判据却因为差 1px 判红）。
      const deltas = moved.map((a) => {
        const b = before.find((item) => item.k === a.k);
        return { dx: a.x - b.x, dy: a.y - b.y };
      });
      const spread = deltas.length
        ? Math.max(
          Math.max(...deltas.map((d) => d.dx)) - Math.min(...deltas.map((d) => d.dx)),
          Math.max(...deltas.map((d) => d.dy)) - Math.min(...deltas.map((d) => d.dy)),
        )
        : Infinity;
      check('拖 Frame 头部能带着整组一起走', moved.length >= 2 && spread <= 2,
        `动了 ${moved.length} 个，位移 ${JSON.stringify(deltas.map((d) => `${d.dx},${d.dy}`))}，最大离散 ${spread}px`);
    } else {
      check('Frame 头部是可拖拽的抓手', false, '找不到 data-frame-handle');
    }

    // ---- 浅色主题：不做「好不好看」的主观判断，只判「读不读得清」
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.waitForTimeout(2500);
    const contrast = await page.evaluate(() => {
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const parse = (value) => {
        const m = String(value).match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const parts = m[1].split(',').map((n) => Number(n.trim()));
        if (parts.length >= 4 && parts[3] === 0) return null; // 全透明，继续往上找
        return parts.slice(0, 3);
      };
      // 往上找第一个不透明背景，这才是文字真正贴着的那块底色。
      const backdropOf = (el) => {
        let node = el;
        while (node && node !== document.documentElement) {
          const bg = parse(getComputedStyle(node).backgroundColor);
          if (bg) return bg;
          node = node.parentElement;
        }
        return parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255];
      };
      const target = [...document.querySelectorAll('div,span')]
        .find((el) => /覆盖\s*[\d.]+%/.test(el.textContent || '') && el.children.length === 0);
      if (!target) return { ok: false, reason: '浅色主题下找不到图层事实行' };
      const fg = parse(getComputedStyle(target).color) || [0, 0, 0];
      const bg = backdropOf(target);
      const l1 = lum(fg);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      return { ok: true, ratio: Math.round(ratio * 100) / 100, fg, bg };
    });
    check('浅色主题下图层面板的文字读得清（对比度 ≥ 3:1）',
      contrast.ok && contrast.ratio >= 3,
      contrast.ok ? `对比度 ${contrast.ratio}:1（字 ${contrast.fg} / 底 ${contrast.bg}）` : contrast.reason);
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    await esc(page);
    await page.waitForTimeout(800);

    // ---- Frame 基础功能：Cmd+G 编组 / Cmd+Shift+G 解组（对齐 Figma）
    await esc(page);
    const frameCount = () => page.evaluate(() => new Set([...document.querySelectorAll('[data-canvas-key]')]
      .map((el) => el.getAttribute('data-layer-group'))
      .filter(Boolean)).size);
    const framesBefore = await frameCount();
    // 全选 → 解组：两个 AI 分层组都应该被拆开
    // 键盘快捷键只在「鼠标悬在画布上或焦点在画布内」时生效，所以先把鼠标移到画布中间。
    await page.mouse.move(700, 500);
    await page.mouse.click(700, 500);
    await page.waitForTimeout(400);
    await page.mouse.move(700, 500);
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(800);
    const selectedCount = await page.evaluate(() => {
      const m = document.body.innerText.match(/已选 (\d+) 个/);
      return m ? Number(m[1]) : 0;
    });
    check('Cmd/Ctrl+A 能全选画布元素', selectedCount >= 2, `已选 ${selectedCount} 个`);
    await page.keyboard.press('Control+Shift+G');
    await page.waitForTimeout(1500);
    const framesAfterUngroup = await page.evaluate(() =>
      document.body.innerText.includes('已解组'));
    check('Cmd/Ctrl+Shift+G 能解组（Frame 被拆开）', framesAfterUngroup,
      `解组前有 ${framesBefore} 组`);
    await page.keyboard.press('Control+g');
    await page.waitForTimeout(1500);
    const grouped = await page.evaluate(() => document.body.innerText.includes('已编组'));
    check('Cmd/Ctrl+G 能把选中的元素编成一个 Frame', grouped);
    const multiBar = await page.evaluate(() => /已选 \d+ 个/.test(document.body.innerText));
    check('多选时出现浮条（编组/解组/导出不只藏在快捷键里）', multiBar);

    // ---- 编组要能扛住刷新（否则「编了组」只是这一屏的错觉）
    await page.waitForTimeout(9000); // 落盘是 debounce 的，给它写完
    const framedBefore = await page.evaluate(() => new Set([...document.querySelectorAll('[data-frame-id]')]
      .map((el) => el.getAttribute('data-frame-id'))).size);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(14000);
    await esc(page);
    const framedAfter = await page.evaluate(() => new Set([...document.querySelectorAll('[data-frame-id]')]
      .map((el) => el.getAttribute('data-frame-id'))).size);
    check('刷新后编组还在（frameId 真的落盘了）',
      framedBefore > 0 && framedAfter === framedBefore,
      `刷新前 ${framedBefore} 组 / 刷新后 ${framedAfter} 组`);

    // ---- 多选导出：PSD 与 ZIP（Frame 头部的导出走同一个 exportElementsAsPsd）
    await page.mouse.move(700, 500);
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(800);
    const psdBtn = page.locator('button:has-text("PSD")').last();
    if (await psdBtn.count()) {
      const wait = page.waitForEvent('download', { timeout: 300000 });
      await psdBtn.click({ force: true });
      try {
        const file = path.join(OUT, 'frame.psd');
        await (await wait).saveAs(file);
        const { readPsd } = await import(path.join(REPO, 'prd-admin/node_modules/ag-psd/dist/index.js'));
        // 在 Node 里解像素需要 canvas；包围盒在图层记录里，跳过像素照样判得了。
        const parsed = readPsd(fs.readFileSync(file), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
        const group = (parsed?.children ?? []).find((child) => Array.isArray(child.children));
        const kids = group?.children ?? [];
        // 每个元素一层，且各自带自己的包围盒——不是每层都铺满整张画布。
        // 同上：留 2% 容差，别让 1022/1024 这种「其实就是满幅」的读数冒充「有界」。
        const smallerThan = (span, full) => full > 0 && span < full * 0.98;
        const bounded = kids.filter((l) => (l.right ?? 0) - (l.left ?? 0) > 0
          && (smallerThan(l.right - l.left, parsed.width ?? 0) || smallerThan(l.bottom - l.top, parsed.height ?? 0)));
        check('多选导出的 PSD 能反读且是真分层', kids.length >= 2, `层数 ${kids.length}`);
        check('多选 PSD 每层各自带包围盒（不是层层满幅）',
          bounded.length >= Math.max(1, kids.length - 1),
          `有界 ${bounded.length}/${kids.length}，画布 ${parsed.width}x${parsed.height}`);
      } catch (error) {
        check('多选导出的 PSD 能反读且是真分层', false, String(error).slice(0, 140));
      }
    } else {
      check('多选浮条里能找到「PSD」', false, '按钮不存在');
    }

    const zipBtn = page.locator('button:has-text("ZIP")').last();
    if (await zipBtn.count()) {
      const wait = page.waitForEvent('download', { timeout: 300000 });
      await zipBtn.click({ force: true });
      try {
        const file = path.join(OUT, 'frame.zip');
        await (await wait).saveAs(file);
        const buf = fs.readFileSync(file);
        // ZIP 每个条目以 PK\x03\x04 开头，数一数就知道打了几张，不用引库。
        let entries = 0;
        for (let i = 0; i + 3 < buf.length; i += 1) {
          if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) entries += 1;
        }
        check('多选 ZIP 能下载且里面不止一张图',
          buf.subarray(0, 2).toString('ascii') === 'PK' && entries >= 2,
          `${buf.length} bytes / ${entries} 个条目`);
      } catch (error) {
        check('多选 ZIP 能下载且里面不止一张图', false, String(error).slice(0, 140));
      }
    } else {
      check('多选浮条里能找到「ZIP」', false, '按钮不存在');
    }

    // ---- 解组也要扛住刷新：解完再刷新，Frame 不许复活
    await page.mouse.move(700, 500);
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(600);
    await page.keyboard.press('Control+Shift+G');
    await page.waitForTimeout(9000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(14000);
    await esc(page);
    const framedAfterUngroup = await page.evaluate(() => new Set([...document.querySelectorAll('[data-frame-id]')]
      .map((el) => el.getAttribute('data-frame-id'))).size);
    check('解组后刷新，Frame 不会复活（解组是真落盘了）',
      framedAfterUngroup === 0,
      `刷新后仍有 ${framedAfterUngroup} 组`);



    check('运行期间没有 401/403（读图与接口的凭据都带上了）',
      !consoleErrors.some((t) => /401|403|Unauthorized|Forbidden/.test(t)),
      consoleErrors.filter((t) => /401|403/.test(t)).slice(0, 2).join(' | '));

    await browser.close();
  } catch (error) {
    await shot(page, 'failure').catch(() => {});
    console.error(`\n[中断] ${String(error).slice(0, 300)}`);
    // 中断必须**记一条失败**，不能只打印。
    // 否则异常发生在任何断言变红之前时 failed.length 是 0，脚本以 0 退出，
    // 调用方把「整条链路压根没跑」读成「全过」。实测发生过：某轮登录超时，
    // 打印了「[中断] TimeoutError」和「0/0 通过」，退出码仍是 0（Codex PR #1363 P1）。
    // 与本 PR 里那条「满幅」窄判据、以及我把空 tsc 输出当成绿灯是同一个错误：
    // 没有红信号不等于有绿信号。
    check('冒烟完整跑完（没有中途中断）', false, String(error).slice(0, 200));
    await browser.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('未通过：');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`[环境] ${String(error).slice(0, 300)}`);
  process.exit(2);
});
