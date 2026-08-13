import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readArg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || '' : '';
}

function groupByModule(manifest) {
  const modules = new Map();
  for (const item of manifest) {
    const module = String(item.module || '未归属模块');
    if (!modules.has(module)) modules.set(module, []);
    modules.get(module).push(item);
  }
  return [...modules.entries()];
}

function evidenceReference(item) {
  const number = String(item.name || '').match(/^(\d{1,3})/)?.[1];
  return number ? `[图${number}](#fig-${number.padStart(3, '0')})` : '查看对应步骤证据';
}

function renderAcceptanceCases(manifest) {
  const commits = [...new Set(manifest.map((item) => String(item.commit || '').trim()).filter(Boolean))];
  const commitLine = commits.length === 1
    ? `固定测试版本：\`${commits[0]}\`。`
    : '固定测试版本：证据清单未提供唯一提交，请按需人工核对。';
  const lines = [
    '## 验收用例',
    '',
    `本表供审核人员先判断每个模块是否通过、是否需要干预；点击证据后可继续按完整面包屑逐图核对。${commitLine}`,
    '',
    '| 用例 | 模块 | 类型 | 完整测试路径 | 结论 | 是否需干预 | 证据 |',
    '|---:|---|---|---|---|---|---|',
  ];
  for (const [index, [module, rows]] of groupByModule(manifest).entries()) {
    const allPassed = rows.length > 0 && rows.every((item) => item.status === '通过');
    const hasFailure = rows.some((item) => item.status === '不通过');
    const result = allPassed ? '通过' : hasFailure ? '不通过' : '需干预';
    const breadcrumb = rows[0]?.breadcrumb || '路径未记录';
    lines.push(`| ${index + 1} | ${module} | 冒烟、功能与视觉 | ${breadcrumb} | ${result} | ${allPassed ? '否' : '是'} | ${evidenceReference(rows[0] || {})} |`);
  }
  return lines.join('\n');
}

export function prepareArchiveReport(report, manifest) {
  const normalizedReport = String(report).replace(/#fig-(\d{3})-[^)\s]+(?=\))/g, '#fig-$1');
  const start = normalizedReport.indexOf('## 视觉证据图片');
  const end = normalizedReport.indexOf('## 视觉测试方法', start);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('主管报告缺少“视觉证据图片”或“视觉测试方法”章节');
  }
  const steps = groupByModule(manifest).flatMap(([module, rows], moduleIndex) => [
    `## 步骤 ${moduleIndex + 1} ${module}`,
    '',
    `按完整面包屑逐项核对 ${rows.length} 个唯一验收状态；每张图只核销一个主状态。`,
    '',
    ...rows.flatMap((item) => [
      `### ${item.primaryState || '未命名状态'} · ${item.status || '未记录'}`,
      '',
      `${item.breadcrumb || '路径未记录'}。${item.caption || '按当前状态核对页面完整性与可操作性。'}`,
      '',
      `{{IMG:${item.name}}}`,
      '',
    ]),
  ]).join('\n');
  const cases = /(?:^|\n)##\s+[^\n]*验收用例/m.test(normalizedReport)
    ? ''
    : `${renderAcceptanceCases(manifest)}\n\n`;
  return `${normalizedReport.slice(0, start)}${cases}${steps}\n\n${normalizedReport.slice(end)}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const reportPath = readArg(argv, '--report');
  const manifestPath = readArg(argv, '--manifest');
  const outputPath = readArg(argv, '--output');
  if (!reportPath || !manifestPath || !outputPath) {
    throw new Error('必须提供 --report、--manifest 和 --output');
  }
  const report = readFileSync(resolve(reportPath), 'utf8');
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
  writeFileSync(resolve(outputPath), prepareArchiveReport(report, manifest), 'utf8');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
