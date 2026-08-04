import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SUPERVISOR_SECTIONS = [
  /^主管先看$/,
  /^主管验收总览$/,
  /^需干预事项$/,
  /^视觉证据预算$/,
  /^业务功能线与面包屑$/,
  /^执行覆盖账本$/,
  /^关联测试方法$/,
  /^需求一一对应表$/,
  /^验收用例$/,
  /^覆盖缺口$/,
  /^移动端验收$/,
  /^缺陷清单$/,
  /^验收地址$/,
  /^步骤\s+\d+/,
];

function readArg(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function parseSections(markdown) {
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  const leadEnd = matches[0]?.index ?? markdown.length;
  const lead = markdown.slice(0, leadEnd).trim();
  const sections = matches.map((match, index) => {
    const start = match.index;
    const end = matches[index + 1]?.index ?? markdown.length;
    return { title: match[1].trim(), content: markdown.slice(start, end).trim() };
  });
  return { lead, sections };
}

function isSupervisorSection(title) {
  return SUPERVISOR_SECTIONS.some((pattern) => pattern.test(title));
}

export function splitStableSmokeReport(markdown, options = {}) {
  const { lead, sections } = parseSections(markdown);
  const supervisorSections = sections.filter((section) => isSupervisorSection(section.title));
  const technicalSections = sections.filter((section) => !isSupervisorSection(section.title));
  const technicalUrl = options.technicalUrl || '{{TECHNICAL_REPORT_URL}}';
  const normalizedLead = lead.replace(/^#\s+.+$/m, '').trim();
  const supervisor = [
    '# 核心业务稳定验收主管报告',
    '',
    normalizedLead,
    '',
    `技术人员如需查看命令、接口、日志和源代码入口，可打开[独立技术附录](${technicalUrl})。`,
    '',
    ...supervisorSections.flatMap((section) => [section.content, '']),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const technical = [
    '# 核心业务稳定验收技术附录',
    '',
    '本附录供开发、测试和运维定位问题。主管结论以独立主管报告为准。',
    '',
    ...technicalSections.flatMap((section) => [section.content, '']),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { supervisor, technical, supervisorSectionTitles: supervisorSections.map((item) => item.title) };
}

export function supervisorReportErrors(markdown) {
  const errors = [];
  const forbidden = [
    /```/,
    /(?:^|[\s`])(?:node|python3|curl|pnpm|dotnet|git)\s+/im,
    /(?:prd-api|prd-admin|prd-desktop|e2e|scripts)\//,
  ];
  if (!markdown.includes('## 主管验收总览')) errors.push('缺少主管验收总览');
  if (!markdown.includes('## 业务功能线与面包屑')) errors.push('缺少业务功能线与面包屑');
  if (!markdown.includes('## 需干预事项')) errors.push('缺少需干预事项');
  if (!markdown.includes('## 关联测试方法')) errors.push('缺少关联测试方法');
  if (!markdown.includes('## 需求一一对应表')) errors.push('缺少需求一一对应表');
  if (!markdown.includes('## 验收地址')) errors.push('缺少验收地址');
  for (const pattern of forbidden) {
    if (pattern.test(markdown)) errors.push(`主管报告包含技术内容：${pattern}`);
  }
  return errors;
}

async function main() {
  const argv = process.argv.slice(2);
  const input = readArg(argv, '--input');
  const supervisorOutput = readArg(argv, '--supervisor-output');
  const technicalOutput = readArg(argv, '--technical-output');
  if (!input || !supervisorOutput || !technicalOutput) {
    throw new Error('必须提供 --input、--supervisor-output 和 --technical-output');
  }
  const result = splitStableSmokeReport(readFileSync(resolve(input), 'utf8'), {
    technicalUrl: readArg(argv, '--technical-url'),
  });
  const errors = supervisorReportErrors(result.supervisor);
  if (errors.length > 0) throw new Error(`主管报告门禁未通过：${errors.join('；')}`);
  writeFileSync(resolve(supervisorOutput), result.supervisor, 'utf8');
  writeFileSync(resolve(technicalOutput), result.technical, 'utf8');
  process.stdout.write(`${JSON.stringify({ supervisorSections: result.supervisorSectionTitles.length, technicalSections: parseSections(result.technical).sections.length })}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
