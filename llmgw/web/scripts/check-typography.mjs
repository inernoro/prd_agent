#!/usr/bin/env node
// 字体阶梯守卫：控制台只允许使用 theme.css :root 里定义的七档字号
// （--fs-title / --fs-metric / --fs-heading / --fs-body / --fs-secondary / --fs-caption / --fs-micro）。
// 任何新写的 `font-size: 18px` 或 `fontSize: 11` 都会在这里被拦住，
// 避免再次出现「其他页面忽大忽小、只有请求记录页排过版」的状态。
//
// 用法：pnpm check:typography
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

// 允许的例外：写清楚原因，不写原因不许加。
const EXCEPTIONS = [
  // iOS Safari 聚焦输入框时 <16px 会自动放大页面，属平台约束而非排版档位。
  { file: 'theme.css', match: 'font-size: 16px', reason: 'iOS 输入框防缩放下限' },
];

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full) : [full];
});

const violations = [];

for (const full of walk(SRC)) {
  const rel = path.relative(SRC, full);
  if (!/\.(css|tsx|ts)$/.test(rel)) continue;
  const lines = fs.readFileSync(full, 'utf8').split('\n');

  lines.forEach((line, i) => {
    // :root 的档位定义本身是 SSOT，跳过。
    if (/--fs-[a-z]+:/.test(line)) return;

    const hits = [
      ...line.matchAll(/font-size:\s*(\d+)px/g),
      // React 内联样式两种写法都要抓：数值 fontSize: 18 与更常见的字符串 fontSize: '18px'。
      // 只认数值形式会让 fontSize: '18px' 从守卫底下溜过去。
      ...line.matchAll(/fontSize:\s*['"`]?(\d+(?:\.\d+)?)(?:px|rem|em)?['"`]?(?=\s*[,}\n]|$)/g),
      ...line.matchAll(/font:\s*(?:\d{3}\s+)?(\d+)px/g),
    ];
    for (const hit of hits) {
      const allowed = EXCEPTIONS.some((e) => rel.endsWith(e.file) && line.includes(e.match));
      if (allowed) continue;
      violations.push(`${rel}:${i + 1}  ${hit[0].trim()}  ← 请改用 var(--fs-*) 七档之一`);
    }
  });
}

// 规则二：角色档位。表格、表单、控件这些「要读的内容」不许降到 12/11px
// ——档位对但角色错，页面照样会比请求记录页糊一档。统一从 lib/typography.ts 取。
const ROLE_DECLS = /(?:const|let)\s+(th|td|labelStyle|inputStyle|selectStyle|formInputStyle|fieldStyle)\b[^=]*=/;
const TOO_SMALL = /--fs-(caption|micro)/;

/**
 * 从声明行起按花括号配平取出整个声明块。
 * 只比对声明行本身会漏掉最常见的写法——
 *   const th = {
 *     fontSize: 'var(--fs-caption)',   // 在后面几行，单行比对永远匹配不上
 *   };
 * 未出现 `{` 的单行声明（如 const td = TABLE_CELL_MUTED;）就只返回那一行。
 */
function declarationBlock(lines, start) {
  const first = lines[start];
  const open = first.indexOf('{');
  if (open === -1) return first;
  let depth = 0;
  const chunk = [];
  for (let i = start; i < lines.length; i += 1) {
    chunk.push(lines[i]);
    for (const ch of i === start ? first.slice(open) : lines[i]) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth <= 0) break;
  }
  return chunk.join('\n');
}

for (const full of walk(SRC)) {
  const rel = path.relative(SRC, full);
  if (!/\.tsx?$/.test(rel) || rel === 'lib/typography.ts') continue;
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!ROLE_DECLS.test(line)) return;
    if (!TOO_SMALL.test(declarationBlock(lines, i))) return;
    violations.push(`${rel}:${i + 1}  表格/表单角色用了 caption/micro 档  ← 请 spread lib/typography.ts 的 TABLE_CELL / FIELD_LABEL 等角色常量`);
  });
}

// 规则三：小字号不许承载成句解释。
// 判据是「caption/micro 档 + 正文行高」同时出现在同一个声明块里——
// 角标、chip、指标 caption 从不设正文行高，成段的解释一定会设。
// 组织页改版前有 10 处用 11px 排整句话（roleCardStyle 1.45 / boundaryNoteStyle 1.55 /
// GovernanceLink 的 detail 1.55 / errorHintStyle 1.5），Exchange 则是在 CSS 里
// 把分区段落钉成 12px —— 这一条精准命中它们，同时几乎不会误伤真正的角标。
// 存量很大（2026-07-29 首次扫出 38 处），一次性清完会把无关工作全挡住，
// 所以按**棘轮**执行：记录每个文件的当前处数，只许减不许增；未登记的文件默认 0。
// 迁移完一个文件就把它的条目删掉（降到 0）。与 prd-admin 的 themeHardcodeRatchet 同一套路。
// 组织页已按 v1.2 迁移完毕，故不在表内——它再出现一处就会红。
const SMALL_PROSE_BASELINE = {
  'theme.css': 27,
  'components/EntityPreviewDrawer.tsx': 4,
  'pages/ChangePasswordPage.tsx': 1,
};

const SMALL_STEP = /--fs-(caption|micro)/;
const BODY_LINE_HEIGHT = /line-?[hH]eight:\s*['"`]?(\d+(?:\.\d+)?)/;

/** 从任意位置向前找最近的 `{`，再按花括号配平取出整块。 */
function enclosingBlock(lines, index) {
  let start = index;
  while (start >= 0 && !lines[start].includes('{')) start -= 1;
  if (start < 0) return lines[index];
  return declarationBlock(lines, start);
}

const smallProseHits = {};

for (const full of walk(SRC)) {
  const rel = path.relative(SRC, full);
  if (!/\.(tsx?|css)$/.test(rel) || rel === 'lib/typography.ts') continue;
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  const flagged = new Set();

  lines.forEach((line, i) => {
    if (!SMALL_STEP.test(line)) return;
    const block = enclosingBlock(lines, i);
    const lh = BODY_LINE_HEIGHT.exec(block);
    if (!lh || Number(lh[1]) < 1.45) return;
    // 同一个块只报一次，避免一个块里两条声明刷出两行。
    const key = block.slice(0, 60);
    if (flagged.has(key)) return;
    flagged.add(key);
    if (EXCEPTIONS.some((e) => rel.endsWith(e.file) && block.includes(e.match))) return;
    (smallProseHits[rel] ??= []).push(`${rel}:${i + 1}  ${SMALL_STEP.exec(line)[0]} 档配了正文行高 ${lh[1]}`);
  });
}

for (const [rel, hits] of Object.entries(smallProseHits)) {
  const allowed = SMALL_PROSE_BASELINE[rel] ?? 0;
  if (hits.length <= allowed) continue;
  violations.push(
    `${rel}  小字号承载正文 ${hits.length} 处，超出棘轮基线 ${allowed} 处\n`
    + hits.slice(0, 5).map((hit) => `      · ${hit}`).join('\n')
    + '\n      ← 成句解释一律 --fs-body；要么改档位，要么把这段话收进 HelpPopover / DetailsBlock',
  );
}

// 棘轮只减不增：清干净了就要求把基线一起降下来，否则欠账表会越留越假。
for (const [rel, allowed] of Object.entries(SMALL_PROSE_BASELINE)) {
  const actual = smallProseHits[rel]?.length ?? 0;
  if (actual < allowed) {
    violations.push(`${rel}  小字号承载正文已降到 ${actual} 处  ← 请把 check-typography.mjs 的 SMALL_PROSE_BASELINE 从 ${allowed} 改为 ${actual}（清零则删除该条目）`);
  }
}

if (violations.length) {
  console.error('字体阶梯守卫未通过：\n');
  for (const v of violations) console.error('  ' + v);
  console.error('\n档位：--fs-title 20 / --fs-metric 17 / --fs-heading 15 / --fs-body 14 / --fs-secondary 13 / --fs-caption 12 / --fs-micro 11');
  console.error('确有平台级例外时，请在 scripts/check-typography.mjs 的 EXCEPTIONS 里登记并写明原因。');
  process.exit(1);
}

console.log('字体阶梯守卫通过：src/ 下没有阶梯外的硬编码字号。');
