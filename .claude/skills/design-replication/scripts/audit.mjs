#!/usr/bin/env node
/**
 * 机械核对：把设计稿那一屏与实现那一屏的**文案集合**和**档位表**逐条对，出一份
 * 「缺什么 / 多什么 / 覆盖率多少」的判据，替代「我看了觉得像」。
 *
 * 为什么要有这一步：复刻的检查环节最容易退化成自证——自己读稿子读出一份规格，
 * 再拿这份规格去验自己照着它写的代码，两边同源，永远自洽
 * （`.claude/rules/predicate-and-wiring-discipline.md` 形状 8：拿不成立的东西当证据）。
 * 文案覆盖率和档位差是**从两边各自渲染结果里量出来的**，不经过我的转述，能戳破这个闭环。
 *
 * 用法：
 *   node audit.mjs --design <设计稿 spec 目录> --impl <实现页 spec 目录> \
 *     [--min-count 2] [--ignore '^\\d+$' --ignore '天前'] [--out <目录>]
 *
 * 两个目录都是 extract-spec.mjs 的产物（各含 spec.json / text.txt）。
 *
 * 退出码 1 = 有缺失文案或缺失档位。**这不是警告，是「还没复刻完」的结论。**
 *
 * 一个必须知道的口径：设计稿里的样例数据（站点名、文件大小、时间）也是文案。实现页跑的是
 * 另一套数据时，这些会被算成「缺失」。所以要么让实现页跑设计稿那套样例数据（推荐，能让
 * 覆盖率变成一个真判据），要么用 --ignore 把明确属于数据的条目排掉——但**不要**因为
 * 「反正是数据」就整体无视这一段：结构文案（按钮、列头、空态引导、括号补充）混在里面，
 * 那些一条都不许缺。
 */
import fs from 'node:fs';
import path from 'node:path';

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : process.argv[i + 1];
}
function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === name) out.push(process.argv[i + 1]); });
  return out.filter(Boolean);
}
const designDir = arg('--design');
const implDir = arg('--impl');
const outDir = arg('--out', null);
const minCount = Number(arg('--min-count', '2'));
const ignores = argAll('--ignore').map((s) => new RegExp(s));
if (!designDir || !implDir) {
  console.error('必填：--design <spec 目录> --impl <spec 目录>');
  process.exit(2);
}

const load = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
const design = load(designDir);
const impl = load(implDir);

// —— 一、文案 ——
// 归一只做「空白折叠」，**不做同义词/去标点**：复刻里文案是逐字契约，
// 「已分享 1 条链接」与「已分享链接 1」不是同一句，放宽归一等于把这条检查废掉。
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const skip = (s) => !s || ignores.some((re) => re.test(s));
// 数字类文案天然随数据变，默认不当缺失（但仍列出来供人判断）
const VOLATILE = /^[\d\s.,:%+\-/]+$/;

const dSet = new Map();
for (const t of design.texts || []) {
  const n = norm(t);
  if (skip(n)) continue;
  dSet.set(n, (dSet.get(n) || 0) + 1);
}
const iSet = new Map();
for (const t of impl.texts || []) {
  const n = norm(t);
  if (skip(n)) continue;
  iSet.set(n, (iSet.get(n) || 0) + 1);
}

const missingText = [...dSet.keys()].filter((t) => !iSet.has(t));
const extraText = [...iSet.keys()].filter((t) => !dSet.has(t));
const missingHard = missingText.filter((t) => !VOLATILE.test(t));
const missingVolatile = missingText.filter((t) => VOLATILE.test(t));
const coverage = dSet.size ? Math.round(((dSet.size - missingText.length) / dSet.size) * 100) : 0;

// —— 二、档位 ——
const DIMS = ['radius', 'fontSize', 'fontWeight', 'fontFamily', 'letterSpacing', 'color', 'background', 'borderColor'];
const DIM_LABEL = {
  radius: '圆角', fontSize: '字号', fontWeight: '字重', fontFamily: '字族',
  letterSpacing: '字距', color: '文字色', background: '底色', borderColor: '描边色',
};
const scale = (spec, dim) => new Set((spec.counts?.[dim] || []).filter((r) => r.count >= minCount).map((r) => r.value));
const dimDiff = DIMS.map((dim) => {
  const d = scale(design, dim);
  const i = scale(impl, dim);
  return {
    dim,
    missing: [...d].filter((v) => !i.has(v)),
    extra: [...i].filter((v) => !d.has(v)),
    designCount: d.size,
    implCount: i.size,
  };
});

// —— 三、报告 ——
const L = [];
L.push('# 机械核对：设计稿 vs 实现', '',
  `设计稿：${design.url}（范围 ${design.scope || `y ${design.yFrom}~${design.yTo}`}，主题 ${design.theme}）`,
  `实现页：${impl.url}（范围 ${impl.scope || `y ${impl.yFrom}~${impl.yTo}`}，主题 ${impl.theme}）`, '');

L.push(`## 文案覆盖率 ${coverage}%（设计稿 ${dSet.size} 条独立文案，实现命中 ${dSet.size - missingText.length} 条）`, '');
if (missingHard.length) {
  L.push(`### 设计稿有、实现没有 —— ${missingHard.length} 条（这些是硬缺失）`, '');
  for (const t of missingHard) L.push(`- \`${t}\``);
  L.push('');
}
if (missingVolatile.length) {
  L.push(`### 只差在数字上 —— ${missingVolatile.length} 条（数据不同属正常，但**位置是否存在**要人工确认一眼）`, '',
    `- ${missingVolatile.slice(0, 20).map((t) => `\`${t}\``).join(' ')}`, '');
}
if (extraText.length) {
  L.push(`### 实现有、设计稿没有 —— ${extraText.length} 条（自作主张加的元素，或数据不同）`, '');
  for (const t of extraText.slice(0, 60)) L.push(`- \`${t}\``);
  if (extraText.length > 60) L.push(`- …还有 ${extraText.length - 60} 条`);
  L.push('');
}

L.push('## 档位差', '', '| 维度 | 设计档数 | 实现档数 | 设计有实现没有 | 实现有设计没有 |', '|---|---|---|---|---|');
for (const r of dimDiff) {
  if (!r.designCount && !r.implCount) continue;
  L.push(`| ${DIM_LABEL[r.dim]} | ${r.designCount} | ${r.implCount} | ${r.missing.map((v) => `\`${v}\``).join(' ') || '—'} | ${r.extra.slice(0, 8).map((v) => `\`${v}\``).join(' ') || '—'} |`);
}
L.push('');

const styleMissing = dimDiff.reduce((n, r) => n + r.missing.length, 0);
L.push('## 结论', '',
  `- 文案覆盖率 **${coverage}%**，硬缺失 **${missingHard.length}** 条`,
  `- 档位缺失 **${styleMissing}** 档`,
  '',
  '这两项都归零，才轮到看并排图判「像不像」。**任一不为零时不许说「已贴稿」**——',
  '文案缺失是逐字契约没守住，档位缺失是设计系统没落全，两者都不是审美问题，是事实问题。', '');

const report = `${L.join('\n')}\n`;
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'audit.md'), report);
  console.log(`报告：${path.join(outDir, 'audit.md')}`);
} else {
  process.stdout.write(report);
}

console.log(`\n文案覆盖率 ${coverage}% · 硬缺失 ${missingHard.length} 条 · 多出 ${extraText.length} 条 · 档位缺失 ${styleMissing} 档`);
if (missingHard.length || styleMissing) process.exitCode = 1;
