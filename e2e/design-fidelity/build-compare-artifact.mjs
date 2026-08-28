/**
 * 把「设计稿基准图 + 真实页面截图」拼成一张可交互的对照画板（自包含 HTML）。
 *
 * 为什么要它：分数是结论，对照图才是证据。用户要能自己一眼看出「稿面画的这块，
 * 真实页面上是不是同一个东西」——而不是只读一行 99 分。
 *
 * Artifact 的 CSP 禁止任何外链资源，所以每张图都要内联成 data URI。
 * 沙箱里没有 ImageMagick / PIL，就用 Chromium 自己当图片处理器：
 * 画进 canvas 缩到目标宽度再导出 JPEG，40 对图能压到几 MB。
 *
 * 跑法：node e2e/design-fidelity/build-compare-artifact.mjs
 * 输出：<scratchpad>/compare/index.html
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SCRATCH = process.env.SCRATCH
  || '/tmp/claude-0/-home-user-prd-agent/e94f0ca4-fb88-51cb-95f1-831ce61d00ee/scratchpad';
const SHOTS = process.env.SHOTS || `${SCRATCH}/full`;
const BOARDS = `${SCRATCH}/design-boards`;
const OUT_DIR = process.env.OUT_DIR || `${SCRATCH}/compare`;
const DATA = JSON.parse(fs.readFileSync(
  path.resolve(process.cwd(), 'e2e/design-fidelity/compare-data.json'), 'utf8',
));

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await (await browser.newContext()).newPage();

/** 缩到目标宽度再压成 JPEG。宽屏画板给宽一点，手机屏与状态卡给窄一点。 */
async function encode(file, maxWidth, quality = 0.72) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file).toString('base64');
  return await page.evaluate(async ({ raw, maxWidth, quality }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${raw}`;
    await img.decode();
    const scale = Math.min(1, maxWidth / img.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    // 底色铺白：状态卡的 PNG 带透明边，直接压 JPEG 会变黑块
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  }, { raw, maxWidth, quality });
}

const missing = [];
const cards = [];
for (const item of DATA.boards) {
  const wide = item.wide === true;
  const design = await encode(`${BOARDS}/${item.board}.png`, wide ? 1000 : 620);
  const impl = await encode(`${SHOTS}/${item.shot}.png`, wide ? 1000 : 620);
  if (!design) missing.push(`${item.board}: 找不到设计稿基准图`);
  if (!impl) missing.push(`${item.board}: 找不到实现截图 ${item.shot}.png`);
  cards.push({ ...item, design, impl });
  console.log(`${item.board} ${design ? 'D' : '-'}${impl ? 'I' : '-'}`);
}

const bytes = cards.reduce((sum, c) => sum + (c.design?.length ?? 0) + (c.impl?.length ?? 0), 0);
console.log(`\n内联图片约 ${(bytes / 1024 / 1024).toFixed(1)} MB`);

const html = renderPage(cards, DATA, missing);
fs.writeFileSync(`${OUT_DIR}/index.html`, html);
console.log(`\n写出 ${OUT_DIR}/index.html （${(html.length / 1024 / 1024).toFixed(1)} MB）`);
await browser.close();
/*
 * 缺图必须让这条命令**变红**。此前缺了一侧也照样写出画板、照样 exit 0：
 * 自动跑的还原度流水线于是会把一份半截证据当成完整证据收下，判官照着它打分
 * （closed-loop-acceptance：不会红的证据比没有证据更糟；Codex 第三十六轮 P1）。
 * 文件仍然写出来——迭代时要看哪块缺了——但退出码非零，并且画板顶部把缺的那几块点名，
 * 这样命令行和产物两头都不会被误当成完整取证。
 */
if (missing.length) {
  console.error(`\n缺 ${missing.length} 张图，这份对照画板不完整，不能当作取证结果：`);
  console.error(missing.map(m => '  ! ' + m).join('\n'));
  process.exitCode = 1;
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function renderPage(cards, data, missing = []) {
  const canvases = [...new Set(cards.map(c => c.canvas))];
  const passed = cards.filter(c => c.score >= 99).length;
  const scored = cards.filter(c => typeof c.score === 'number').length;
  const body = cards.map((c, index) => `
    <article class="card" data-canvas="${esc(c.canvas)}" data-state="${c.score >= 99 ? 'pass' : 'open'}">
      <header class="card-head">
        <span class="board-id">${esc(c.board)}</span>
        <span class="board-label">${esc(c.label)}</span>
        <span class="canvas-tag">${esc(c.canvas)}</span>
        <span class="score ${c.score >= 99 ? 'ok' : 'wip'}">${typeof c.score === 'number' ? c.score : '未判'}</span>
      </header>
      <div class="pair">
        <figure>
          <figcaption>设计稿</figcaption>
          ${c.design
            ? `<img loading="lazy" src="${c.design}" alt="${esc(c.board)} 设计稿" data-full="${index}-d">`
            : '<div class="miss">没有基准图</div>'}
        </figure>
        <figure>
          <figcaption>真实页面</figcaption>
          ${c.impl
            ? `<img loading="lazy" src="${c.impl}" alt="${esc(c.board)} 实现" data-full="${index}-i">`
            : '<div class="miss">未取证</div>'}
        </figure>
      </div>
      <p class="note">${esc(c.note)}</p>
      <p class="evidence">证据：<code>${esc(c.shot)}.png</code>${c.driven ? ` · 驱动：${esc(c.driven)}` : ''}</p>
    </article>`).join('\n');

  return `<title>录音链路对照画板</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700;900&family=JetBrains+Mono:wght@400;700&display=swap">
<style>
  /* 浅色档是稿面「05 开发标注 · 颜色」那一格的原值；中性色带一点冷偏，跟蓝色强调同族 */
  :root{
    --bg:#F2F2EF; --card:#FFFFFF; --sunk:#F7F7F4;
    --ink:#16181A; --ink2:#4B5058; --muted:#767B83;
    --line:#E4E3DE; --line2:#D5D4CF;
    --accent:#1F5EFF; --ok:#12885E; --wip:#B26A00;
    --ok-soft:#E4F3EA; --wip-soft:#FBF1E0;
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --bg:#0A0C0E; --card:#15181B; --sunk:#101315;
      --ink:#EDEEEF; --ink2:#B6BCC2; --muted:#8D949B;
      --line:#242830; --line2:#333941;
      --accent:#6E9BFF; --ok:#3DD68C; --wip:#E9A23B;
      --ok-soft:rgba(61,214,140,.13); --wip-soft:rgba(233,162,59,.13);
    }
  }
  :root[data-theme="dark"]{
    --bg:#0A0C0E; --card:#15181B; --sunk:#101315;
    --ink:#EDEEEF; --ink2:#B6BCC2; --muted:#8D949B;
    --line:#242830; --line2:#333941;
    --accent:#6E9BFF; --ok:#3DD68C; --wip:#E9A23B;
    --ok-soft:rgba(61,214,140,.13); --wip-soft:rgba(233,162,59,.13);
  }
  *{box-sizing:border-box;}
  body{
    margin:0;background:var(--bg);color:var(--ink);
    font-family:'Noto Sans SC',-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',system-ui,sans-serif;
    line-height:1.65;-webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:1200px;margin:0 auto;padding:40px 22px 72px;}
  .eyebrow{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11.5px;letter-spacing:.14em;
           text-transform:uppercase;color:var(--muted);margin:0 0 10px;}
  h1{font-size:clamp(26px,4vw,36px);font-weight:900;letter-spacing:-.02em;margin:0 0 10px;text-wrap:balance;}
  .lede{color:var(--ink2);font-size:15.5px;margin:0 0 22px;max-width:64ch;}
  .tally{display:flex;flex-wrap:wrap;gap:0;border:1px solid var(--line);border-radius:14px;
         background:var(--card);overflow:hidden;margin-bottom:26px;}
  .tally div{flex:1 1 150px;padding:14px 18px;border-right:1px solid var(--line);}
  .tally div:last-child{border-right:none;}
  .tally dt{font-size:12px;color:var(--muted);margin:0 0 2px;}
  .tally dd{margin:0;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:22px;font-weight:700;
            font-variant-numeric:tabular-nums;letter-spacing:-.02em;}
  .bar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px;align-items:center;
       padding:12px 0 14px;margin-bottom:22px;background:var(--bg);border-bottom:1px solid var(--line);}
  .chip{cursor:pointer;border:1px solid var(--line2);background:var(--card);color:var(--ink2);
        border-radius:999px;padding:7px 15px;font-size:13px;font-weight:500;font-family:inherit;
        transition:background .12s ease,color .12s ease;}
  .chip:hover{border-color:var(--ink2);}
  .chip:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
  .chip[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink);font-weight:700;}
  .grid{display:flex;flex-direction:column;gap:20px;}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;
        padding:18px 18px 16px 20px;position:relative;overflow:hidden;}
  /* 状态编进形态，不只编进数字：左侧一道细色带，扫一眼就知道哪几块还没到线 */
  .card::before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--wip);}
  .card[data-state="pass"]::before{background:var(--ok);}
  .card-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:14px;}
  .board-id{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12.5px;font-weight:700;
            color:var(--accent);letter-spacing:.02em;}
  .board-label{font-size:15.5px;font-weight:700;flex:1;min-width:0;letter-spacing:-.01em;}
  .canvas-tag{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;letter-spacing:.08em;
              color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 8px;}
  .score{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;font-weight:700;
         font-variant-numeric:tabular-nums;border-radius:999px;padding:3px 12px;}
  .score.ok{background:var(--ok-soft);color:var(--ok);}
  .score.wip{background:var(--wip-soft);color:var(--wip);}
  .pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
  figure{margin:0;min-width:0;}
  figcaption{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;letter-spacing:.1em;
             text-transform:uppercase;color:var(--muted);margin-bottom:7px;}
  .pair img{width:100%;height:auto;display:block;border-radius:10px;border:1px solid var(--line);
            cursor:zoom-in;background:#fff;}
  .pair img:focus-visible{outline:2px solid var(--accent);outline-offset:3px;}
  .miss{border:1px dashed var(--line2);border-radius:10px;padding:32px 12px;text-align:center;
        color:var(--muted);font-size:13px;background:var(--sunk);}
  .note{font-size:13.5px;color:var(--ink2);margin:14px 0 5px;max-width:78ch;}
  .evidence{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;color:var(--muted);margin:0;
            overflow-x:auto;white-space:nowrap;}
  dialog{border:none;background:transparent;max-width:96vw;max-height:96vh;padding:0;}
  dialog::backdrop{background:rgba(0,0,0,.86);}
  .incomplete{margin:0 0 22px;padding:14px 16px;border-radius:12px;background:var(--wip-soft);
    border:1px solid var(--wip);color:var(--ink2);font-size:14px;line-height:1.7;}
  .incomplete strong{color:var(--wip);}
  dialog img{max-width:96vw;max-height:96vh;border-radius:10px;display:block;}
  @media (max-width:760px){ .pair{grid-template-columns:1fr;} .wrap{padding:28px 16px 56px;} }
</style>
<div class="wrap">
  <p class="eyebrow">MAP 录音转录 · 设计稿还原度</p>
  <h1>四十块画板，逐块对照</h1>
  <p class="lede">左边是设计稿画板，右边是同一时刻真实应用里的那一屏——走真实路由、真实组件、真实判据，只有网络是桩。分数由审查智能体按内容完整性、结构层级、状态表达、交互可达、视觉样式、版式留白六维加权给出，99 分为达标线。</p>
  ${missing.length ? `<p class="incomplete" role="status"><strong>这份对照不完整：缺 ${missing.length} 张图。</strong>缺图的画板下面标着「没有基准图」或「未取证」，不能拿来判分。<br>${missing.map(esc).join('<br>')}</p>` : ''}
  <dl class="tally">
    <div><dt>画板总数</dt><dd>${cards.length}</dd></div>
    <div><dt>已判分</dt><dd>${scored}</dd></div>
    <div><dt>已达标</dt><dd>${passed}</dd></div>
    <div><dt>取证截图</dt><dd>${cards.filter(c => c.impl).length}</dd></div>
    <div><dt>更新于</dt><dd style="font-size:15px">${esc(data.updatedAt)}</dd></div>
  </dl>
  <div class="bar">
    <button class="chip" aria-pressed="true" data-filter="all">全部</button>
    <button class="chip" aria-pressed="false" data-filter="pass">已达标</button>
    <button class="chip" aria-pressed="false" data-filter="open">未达标 / 未判</button>
    ${canvases.map(c => `<button class="chip" aria-pressed="false" data-filter="canvas:${esc(c)}">${esc(c)}</button>`).join('')}
  </div>
  <div class="grid">${body}</div>
</div>
<dialog id="zoom"><img alt="放大查看"></dialog>
<script>
  const cards = [...document.querySelectorAll('.card')];
  document.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(c === chip)));
    const f = chip.dataset.filter;
    cards.forEach(card => {
      const show = f === 'all'
        || (f === 'pass' && card.dataset.state === 'pass')
        || (f === 'open' && card.dataset.state === 'open')
        || (f.startsWith('canvas:') && card.dataset.canvas === f.slice(7));
      card.style.display = show ? '' : 'none';
    });
  }));
  const zoom = document.getElementById('zoom');
  document.querySelectorAll('.pair img').forEach(img => {
    img.tabIndex = 0;
    const open = () => { zoom.querySelector('img').src = img.src; zoom.showModal(); };
    img.addEventListener('click', open);
    img.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  zoom.addEventListener('click', () => zoom.close());
</script>`;

}
