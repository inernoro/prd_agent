/**
 * 生成接入台（mcp-console）的百宝箱卡片插画。
 *
 * 为什么要有这个脚本：卡片插画是 960x600 的 webp，这台机器上没有任何图片编码器
 * （无 PIL / cwebp / imagemagick），只有 Chromium。所以用画布画完再 toDataURL 出 webp。
 * 留着它是为了让这两张图有来处 —— 谁要换成手绘版，先看这里画的是什么，再替换同名文件。
 *
 * 用法：node prd-admin/scripts/gen-mcp-console-art.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'agent-card-art');
const W = 960;
const H = 600;

/** 画面：左边一块「平台」底板，右边三张「智能体」卡片，之间用带钥匙的连线接起来。全灰阶，渲染时再上色。 */
const DRAW = `(ctx, p) => {
  const W = ${W}, H = ${H};
  ctx.fillStyle = p.bg; ctx.fillRect(0, 0, W, H);

  // 背景：一层极淡的斜向渐变 + 点阵，避免整块死板
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, p.washA); g.addColorStop(1, p.washB);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = p.dot;
  for (let y = 40; y < H; y += 40) for (let x = 40; x < W; x += 40) {
    ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill();
  }

  const round = (x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  // 左：平台底板（系统本体）
  ctx.save();
  ctx.shadowColor = p.shadow; ctx.shadowBlur = 34; ctx.shadowOffsetY = 14;
  ctx.fillStyle = p.slab; round(96, 168, 268, 264, 26); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = p.slabEdge; ctx.lineWidth = 2; round(96, 168, 268, 264, 26); ctx.stroke();

  // 底板上的五条能力条（视觉/文学/知识库/网页/市场）
  ctx.fillStyle = p.bar;
  for (let i = 0; i < 5; i++) round(132, 206 + i * 44, 196 - i * 14, 20, 10), ctx.fill();

  // 右：三张智能体卡片
  const cards = [[612, 128], [660, 268], [612, 408]];
  cards.forEach(([x, y], i) => {
    ctx.save();
    ctx.shadowColor = p.shadow; ctx.shadowBlur = 22; ctx.shadowOffsetY = 10;
    ctx.fillStyle = p.card; round(x, y, 210, 108, 18); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = p.cardEdge; ctx.lineWidth = 1.6; round(x, y, 210, 108, 18); ctx.stroke();
    ctx.fillStyle = p.cardLine;
    round(x + 22, y + 28, 118 - i * 10, 12, 6); ctx.fill();
    round(x + 22, y + 56, 92 + i * 12, 10, 5); ctx.fill();
  });

  // 连线：平台 → 每张卡片
  ctx.strokeStyle = p.link; ctx.lineWidth = 3; ctx.lineCap = 'round';
  cards.forEach(([x, y]) => {
    ctx.beginPath();
    ctx.moveTo(364, 300);
    ctx.bezierCurveTo(470, 300, 500, y + 54, x, y + 54);
    ctx.stroke();
  });

  // 连线中段的钥匙（授权才通得过）
  ctx.save();
  ctx.translate(478, 300);
  ctx.fillStyle = p.key;
  ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = p.keyHole;
  ctx.beginPath(); ctx.arc(0, -5, 8, 0, Math.PI * 2); ctx.fill();
  round(-4, -3, 8, 18, 4); ctx.fill();
  ctx.restore();

  // 底部一道柔光，和其他卡片插画的收边一致
  const v = ctx.createLinearGradient(0, H - 180, 0, H);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, p.vignette);
  ctx.fillStyle = v; ctx.fillRect(0, H - 180, W, 180);
}`;

const PALETTES = {
  'mcp-console-light': {
    bg: '#eceef1', washA: '#f6f7f9', washB: '#dfe3e8', dot: 'rgba(90,100,115,0.10)',
    slab: '#ffffff', slabEdge: 'rgba(70,80,95,0.16)', bar: 'rgba(80,92,110,0.22)',
    card: '#fbfcfd', cardEdge: 'rgba(70,80,95,0.18)', cardLine: 'rgba(80,92,110,0.26)',
    link: 'rgba(70,82,100,0.34)', key: '#8d97a6', keyHole: '#f4f6f8',
    shadow: 'rgba(40,50,65,0.16)', vignette: 'rgba(120,130,145,0.16)',
  },
  'mcp-console': {
    bg: '#22262c', washA: '#2b3037', washB: '#1a1e23', dot: 'rgba(220,230,245,0.07)',
    slab: '#333941', slabEdge: 'rgba(225,235,250,0.14)', bar: 'rgba(225,235,250,0.20)',
    card: '#3a414a', cardEdge: 'rgba(225,235,250,0.16)', cardLine: 'rgba(225,235,250,0.24)',
    link: 'rgba(225,235,250,0.30)', key: '#aab3c0', keyHole: '#2a2f36',
    shadow: 'rgba(0,0,0,0.42)', vignette: 'rgba(0,0,0,0.34)',
  },
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas id="c" width="' + W + '" height="' + H + '"></canvas>');

for (const [name, palette] of Object.entries(PALETTES)) {
  const dataUrl = await page.evaluate(
    ([draw, p, w, h]) => {
      const c = document.getElementById('c');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      (0, eval)('(' + draw + ')')(ctx, p);
      return c.toDataURL('image/webp', 0.92);
    },
    [DRAW, palette, W, H],
  );
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  const file = join(OUT_DIR, name + '.webp');
  writeFileSync(file, bytes);
  console.log(file, bytes.length, 'bytes');
}

await browser.close();
