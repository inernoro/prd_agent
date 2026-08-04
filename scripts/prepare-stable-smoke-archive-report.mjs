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
  return `${normalizedReport.slice(0, start)}${steps}\n\n${normalizedReport.slice(end)}`;
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
