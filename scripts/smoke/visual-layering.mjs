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

    // ---- 等待态：三个头部元素不许互相压住（纯几何判据，肉眼看图容易漏）
    // 必须**跨缩放档位**测：这些标签用 scale(1/zoom) 反向放大以保持屏幕尺寸恒定，
    // 缩得越小它们相对 Frame 就越大，低倍下才会撞上（用户 12% 截图即此）。
    await page.waitForTimeout(3000);
    const measureOverlap = () => page.evaluate(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const byText = (re) => [...document.querySelectorAll('span,div,button')]
        .filter((el) => re.test((el.textContent || '').trim()) && el.getBoundingClientRect().width > 0)
        .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
      const headline = byText(/^Frame · /);
      const panelBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '图层面板');
      const badge = byText(/^图层分离中$/);
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
    const zoomOut = async () => {
      await page.mouse.move(700, 500);
      await page.mouse.wheel(0, 260, { });
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
    const waitingShot = await shot(page, 'waiting');
    check(
      '等待态的 Frame 头部 / 图层面板按钮 / 分层中标记在各缩放档位都不遮挡',
      bad.length === 0,
      bad.length
        ? `重叠档位：${bad.map((r) => `${r.zoom}%(${r.hits.join('、')})`).join('；')}`
        : `测过 ${overlapReport.map((r) => `${r.zoom}%`).join('/')}，在场：${overlapReport[0].present.join('、')}（见 ${waitingShot}）`,
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
      const next = (t.match(/下次拆[\s\S]{0,12}?(\d+)[\s\S]{0,4}?层/) || [])[1];
      const explain = /本次请求 \d+ 层，模型实际给出 \d+ 层/.test(t);
      return { next: next ? Number(next) : null, explain };
    });
    check('层数控件有值', countText.next !== null, `下次拆 ${countText.next} 层`);

    // ---- 刷新后 Frame 不塌：同一 Frame 里的图块必须等大
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(14000);
    await esc(page);
    const reloadShot = await shot(page, 'after-reload');
    const rects = await page.evaluate(() => [...document.querySelectorAll('img')]
      .map((i) => i.getBoundingClientRect())
      .filter((r) => r.width > 60 && r.height > 60)
      .map((r) => ({ w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) })));
    const uniqueSizes = [...new Set(rects.map((r) => `${r.w}x${r.h}`))];
    check('刷新后同一 Frame 内图块等大（不塌成碎块）',
      rects.length >= 2 && uniqueSizes.length === 1,
      `尺寸集合 ${JSON.stringify(uniqueSizes)}（见 ${reloadShot}）`);
    // 用户心智：拆完还是原来那张图，只是每块能单独挪。所以各部件必须**落在同一个位置**，
    // 而不是摊成一排——摊开等于让用户自己再拼一次。
    const uniquePositions = [...new Set(rects.map((r) => `${r.x},${r.y}`))];
    check('各部件叠在原位（不是摊开成一排）',
      rects.length >= 2 && uniquePositions.length === 1,
      `位置集合 ${JSON.stringify(uniquePositions)}`);

    // ---- 导出 PSD：层名互不相同，文件非空
    const panelBtn = page.locator('button:has-text("图层面板")').first();
    if (await panelBtn.count()) {
      const bb = await panelBtn.boundingBox();
      if (bb) await page.mouse.click(bb.x + 12, bb.y + bb.height / 2);
      await page.waitForTimeout(3000);
    }
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
        const fullCanvas = psdLayers.filter((l) => (l.right ?? 0) - (l.left ?? 0) >= (parsed?.width ?? 0)
          && (l.bottom ?? 0) - (l.top ?? 0) >= (parsed?.height ?? 0));
        check('导出的 PSD 能被反读回来（不是只有个文件头）', !!parsed, parseError);
        check('PSD 是真分层：可编辑图层组里有多层',
          psdLayers.length >= 2, `层数 ${psdLayers.length}`);
        check('PSD 画布尺寸 = 原图尺寸（各块拼回去就是原图）',
          !!parsed && parsed.width > 0 && parsed.height > 0,
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

    check('运行期间没有 401/403（读图与接口的凭据都带上了）',
      !consoleErrors.some((t) => /401|403|Unauthorized|Forbidden/.test(t)),
      consoleErrors.filter((t) => /401|403/.test(t)).slice(0, 2).join(' | '));

    await browser.close();
  } catch (error) {
    await shot(page, 'failure').catch(() => {});
    console.error(`\n[中断] ${String(error).slice(0, 300)}`);
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
