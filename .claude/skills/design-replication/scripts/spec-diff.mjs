#!/usr/bin/env node
/**
 * 比两份导出规格：设计稿改版之后，到底哪几档变了。
 *
 * 没有它的话，「稿子改了什么」只能靠人对着两版截图找，找出来的是印象；有了它，
 * 「圆角新增一档 14px、字号砍掉 10.5px、浅色底色换了」是可以打印出来的事实，
 * 直接决定要动哪几个 token。
 *
 * 只比档位集合与出现次数量级，不比 sample、不比时间戳——那些每次导出都不同，
 * 混进来会让 diff 全是噪音，人就不看了。
 *
 * 用法：
 *   node spec-diff.mjs --a <旧 design-spec.json> --b <新 design-spec.json> [--dims radius,fontSize]
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * 比两份规格，返回逐条变化。抽成纯函数是为了它**能被测**：
 * 留在 CLI 里就只能靠肉眼看输出，而「漏报一类变化」恰恰是不会有人发现的那种错。
 */
export function diffSpecs(a, b, only = []) {
  const lines = [];
  const boardsA = new Map((a.boards || []).map((x) => [x.id, x]));
  const boardsB = new Map((b.boards || []).map((x) => [x.id, x]));

  for (const id of new Set([...boardsA.keys(), ...boardsB.keys()])) {
    const x = boardsA.get(id);
    const y = boardsB.get(id);
    if (!x) { lines.push(`[新增屏] ${id} · ${y.label}`); continue; }
    if (!y) { lines.push(`[删除屏] ${id} · ${x.label}（旧版有、新版没有——先确认是真删了还是这次没量）`); continue; }
    if (x.label !== y.label) lines.push(`[改名] ${id}：${x.label} → ${y.label}`);

    for (const theme of new Set([...Object.keys(x.scales || {}), ...Object.keys(y.scales || {})])) {
      const sx = x.scales?.[theme];
      const sy = y.scales?.[theme];
      if (!sx) { lines.push(`[新增主题] ${id} ${theme}`); continue; }
      if (!sy) { lines.push(`[缺主题] ${id} ${theme}（旧版量过、新版没有）`); continue; }

      for (const dim of new Set([...Object.keys(sx), ...Object.keys(sy)])) {
        if (only.length && !only.includes(dim)) continue;
        const setX = new Map((sx[dim] || []).map((r) => [r.value, r.count]));
        const setY = new Map((sy[dim] || []).map((r) => [r.value, r.count]));
        const added = [...setY.keys()].filter((v) => !setX.has(v));
        const removed = [...setX.keys()].filter((v) => !setY.has(v));
        if (added.length) lines.push(`[+] ${id} ${theme} ${dim} 新增：${added.join(', ')}`);
        if (removed.length) lines.push(`[-] ${id} ${theme} ${dim} 不再出现：${removed.join(', ')}`);
      }
    }
  }
  return lines;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isCli) {
  // 被 import 进来只为拿 diffSpecs，不该顺带把 CLI 的参数校验与 process.exit 跑一遍
} else {

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? d : process.argv[i + 1];
};
const aPath = arg('--a');
const bPath = arg('--b');
const only = (arg('--dims', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!aPath || !bPath) {
  console.error('必填：--a <旧 design-spec.json> --b <新 design-spec.json>');
  process.exit(2);
}
const a = JSON.parse(fs.readFileSync(aPath, 'utf8'));
const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));

if (a.source?.sha256 === b.source?.sha256) {
  console.log('两份规格来自同一个画布文件（sha256 相同）——差异只可能来自取证方式，不是稿子改了。');
}

const lines = diffSpecs(a, b, only);

if (lines.length === 0) {
  console.log('两份规格的档位集合完全一致。');
} else {
  console.log(lines.join('\n'));
  console.log(`\n共 ${lines.length} 处变化。每一处都要落到 token 层：新增的档位补 token，`
    + '不再出现的档位查一下是稿子删了还是这次漏量了。');
}
}
