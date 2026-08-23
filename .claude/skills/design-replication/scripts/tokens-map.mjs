#!/usr/bin/env node
/**
 * 把量出来的设计规格（extract-spec 的 spec.json）逐档对到项目的 token 文件，
 * 分成三类：**已有 token** / **接近但不等（多半是被写歪的那一档）** / **缺 token**。
 *
 * 为什么这一步必须在写组件之前：设计稿有 40 多档值，token 文件里只有一半；
 * 缺的那一半如果不先补进 token 层，写组件时就只能一处处硬编码，
 * 既撞双皮肤棘轮（`.claude/rules/admin-dual-theme.md`），又让「这一档到底是多少」
 * 散落在几十个文件里，第二屏必然漂移。
 *
 * 用法：
 *   node tokens-map.mjs --spec <spec.json> --tokens <tokens.css> \
 *     [--dims color,background,borderColor,radius,fontSize,fontFamily] \
 *     [--min-count 2] [--out <目录>]
 *
 * --min-count 过滤只出现一两次的偶发值（浏览器默认值、一次性微调），默认 2。
 * 退出码 1 = 存在缺 token 的档位。这是**闸门**：先补 token，再写组件。
 */
import fs from 'node:fs';
import path from 'node:path';

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : process.argv[i + 1];
}
const specPath = arg('--spec');
const tokensPath = arg('--tokens');
const outDir = arg('--out', null);
const minCount = Number(arg('--min-count', '2'));
const dims = arg('--dims', 'color,background,borderColor,radius,fontSize,fontFamily')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (!specPath || !tokensPath) {
  console.error('必填：--spec <spec.json> --tokens <tokens.css>');
  process.exit(2);
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const css = fs.readFileSync(tokensPath, 'utf8');

/** 解析 `--name: value;` 声明。同名 token 在多个主题块里会各有一条，全都收下 ——
 *  设计稿量到的浅色值本来就该对上 `[data-theme="light"]` 那一份。 */
const tokens = [];
for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
  tokens.push({ name: m[1], raw: m[2].trim() });
}

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
/** 颜色归一成 [r,g,b,a]；认不出来返回 null（渐变、var() 引用、关键字等） */
function toRgba(v) {
  const s = String(v).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    if (h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return [clamp255(parts[0]), clamp255(parts[1]), clamp255(parts[2]), parts.length > 3 ? parts[3] : 1];
  }
  return null;
}
const sameColor = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && Math.abs(a[3] - b[3]) < 0.02;
/** 感知距离够近 = 多半是同一档被写歪，值得点名而不是当成新档 */
function nearColor(a, b) {
  if (!a || !b) return false;
  if (Math.abs(a[3] - b[3]) > 0.08) return false;
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= 18;
}

const px = (v) => {
  const m = String(v).trim().match(/^(-?[\d.]+(?:e[+-]?\d+)?)px$/i);
  return m ? Number(m[1]) : null;
};
const firstFamily = (v) => String(v).split(',')[0].replace(/["']/g, '').trim().toLowerCase();

function classify(dim, value) {
  const isColor = ['color', 'background', 'borderColor'].includes(dim);
  const isPx = ['radius', 'fontSize', 'borderWidth', 'letterSpacing'].includes(dim);

  if (isColor) {
    const want = toRgba(value);
    if (!want) return { kind: 'skip' };
    const exact = tokens.filter((t) => sameColor(toRgba(t.raw), want));
    if (exact.length) return { kind: 'have', tokens: exact.map((t) => t.name) };
    const near = tokens.filter((t) => nearColor(toRgba(t.raw), want));
    if (near.length) return { kind: 'near', tokens: near.map((t) => `${t.name}=${t.raw}`) };
    return { kind: 'missing' };
  }
  if (isPx) {
    // 圆角是四角写法（"10px 10px 10px 10px" 或 "10px"），取第一角比
    const want = px(String(value).split(' ')[0]);
    if (want === null) return { kind: 'skip' };
    const exact = tokens.filter((t) => px(t.raw) === want);
    if (exact.length) return { kind: 'have', tokens: exact.map((t) => t.name) };
    const near = tokens.filter((t) => px(t.raw) !== null && Math.abs(px(t.raw) - want) <= 1);
    if (near.length) return { kind: 'near', tokens: near.map((t) => `${t.name}=${t.raw}`) };
    return { kind: 'missing' };
  }
  if (dim === 'fontFamily') {
    const want = firstFamily(value);
    // 系统兜底字族不算设计决策
    if (!want || ['ui-sans-serif', 'system-ui', 'sans-serif', 'serif', '-apple-system'].includes(want)) return { kind: 'skip' };
    const exact = tokens.filter((t) => firstFamily(t.raw) === want);
    return exact.length ? { kind: 'have', tokens: exact.map((t) => t.name) } : { kind: 'missing' };
  }
  return { kind: 'skip' };
}

const DIM_LABEL = {
  color: '文字色', background: '底色', borderColor: '描边色', borderWidth: '描边粗细',
  radius: '圆角', fontSize: '字号', fontFamily: '字族', letterSpacing: '字距',
};

const lines = ['# 设计规格 → token 对照', '',
  `规格：${path.resolve(specPath)}`, `token：${path.resolve(tokensPath)}（解析到 ${tokens.length} 条声明）`,
  `口径：只看出现 ≥${minCount} 次的档位（更低的多半是偶发值，不是设计档）`, ''];
let missingTotal = 0;
let nearTotal = 0;

for (const dim of dims) {
  const rows = (spec.counts?.[dim] || []).filter((r) => r.count >= minCount);
  if (!rows.length) continue;
  const graded = rows.map((r) => ({ ...r, ...classify(dim, r.value) })).filter((r) => r.kind !== 'skip');
  if (!graded.length) continue;
  const miss = graded.filter((r) => r.kind === 'missing');
  const near = graded.filter((r) => r.kind === 'near');
  missingTotal += miss.length;
  nearTotal += near.length;

  lines.push(`## ${DIM_LABEL[dim] || dim} — 共 ${graded.length} 档：已有 ${graded.length - miss.length - near.length} · 接近 ${near.length} · 缺 ${miss.length}`, '',
    '| 设计值 | 次数 | 结论 | token |', '|---|---|---|---|');
  for (const r of graded) {
    const verdict = r.kind === 'have' ? '已有' : r.kind === 'near' ? '接近但不等' : '**缺**';
    lines.push(`| \`${r.value}\` | ${r.count} | ${verdict} | ${(r.tokens || []).slice(0, 3).join(' / ') || '—'} |`);
  }
  lines.push('');
}

lines.push('## 怎么用这张表', '',
  '- **已有**：直接 `var(--x)`，不要再写字面量。',
  '- **接近但不等**：先判是不是同一档被写歪了。是 → 用已有 token，把差异记进偏差台账；',
  '  不是（设计稿真的多了一档）→ 当成「缺」补新 token，别硬套最近的那个。',
  '- **缺**：在 token 文件里补一条**有语义名字**的（`--bg-rail` 不是 `--gray-7`），',
  '  暗浅两套都要写；写完再回来重跑这个脚本，直到缺项为 0 再开始写组件。', '');

const report = `${lines.join('\n')}\n`;
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'tokens-map.md'), report);
  console.log(`对照表：${path.join(outDir, 'tokens-map.md')}`);
} else {
  process.stdout.write(report);
}

console.log(`\n缺 token ${missingTotal} 档 · 接近但不等 ${nearTotal} 档`);
if (missingTotal > 0) {
  console.log('闸门：先把缺的档位补进 token 层（暗浅双写）再写组件，否则这些值会以硬编码散进几十个文件。');
  process.exitCode = 1;
}
