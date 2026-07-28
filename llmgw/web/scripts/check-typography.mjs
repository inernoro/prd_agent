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
      ...line.matchAll(/fontSize:\s*(\d+)\b/g),
      ...line.matchAll(/font:\s*(?:\d{3}\s+)?(\d+)px/g),
    ];
    for (const hit of hits) {
      const allowed = EXCEPTIONS.some((e) => rel.endsWith(e.file) && line.includes(e.match));
      if (allowed) continue;
      violations.push(`${rel}:${i + 1}  ${hit[0].trim()}  ← 请改用 var(--fs-*) 七档之一`);
    }
  });
}

if (violations.length) {
  console.error('字体阶梯守卫未通过，发现硬编码字号：\n');
  for (const v of violations) console.error('  ' + v);
  console.error('\n档位：--fs-title 20 / --fs-metric 17 / --fs-heading 15 / --fs-body 14 / --fs-secondary 13 / --fs-caption 12 / --fs-micro 11');
  console.error('确有平台级例外时，请在 scripts/check-typography.mjs 的 EXCEPTIONS 里登记并写明原因。');
  process.exit(1);
}

console.log('字体阶梯守卫通过：src/ 下没有阶梯外的硬编码字号。');
