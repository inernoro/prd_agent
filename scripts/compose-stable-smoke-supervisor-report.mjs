import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readArg(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

export function parseReportSections(markdown) {
  const matches = [...String(markdown || '').matchAll(/^##\s+(.+)$/gm)];
  const lead = markdown.slice(0, matches[0]?.index ?? markdown.length).trim();
  const sections = matches.map((match, index) => ({
    title: match[1].trim(),
    content: markdown.slice(match.index, matches[index + 1]?.index ?? markdown.length).trim(),
  }));
  return { lead, sections };
}

const visualBeforeLedger = new Set([
  '视觉证据预算',
  '改动断言表',
  '影响面矩阵',
  '融合测试设计',
  '证明力矩阵',
  '页面优先证据分层',
  '改动断言到证据表',
  '验收用例',
  '覆盖缺口',
  '移动端验收',
  '缺陷清单',
]);

export function composeSupervisorReport(functionalMarkdown, visualMarkdown) {
  const functional = parseReportSections(functionalMarkdown);
  const visual = parseReportSections(visualMarkdown);
  const visualSummary = visual.sections.filter((section) => visualBeforeLedger.has(section.title));
  const visualSteps = visual.sections.filter((section) => /^步骤\s+\d+/.test(section.title));
  const visualOverview = visual.sections.find((section) => section.title === '主管验收总览');
  const inferredVerdict = /不通过/.test(functional.lead)
    ? 'fail'
    : /部分通过/.test(functional.lead)
      ? 'conditional'
      : 'pass';
  const output = [functional.lead, '', `Verdict: ${inferredVerdict}`, ''];
  let visualInserted = false;
  for (const section of functional.sections) {
    if (section.title === '主管验收总览') {
      output.push(section.content.replace(/^## 主管验收总览/m, '## 主管先看'), '');
      if (visualOverview) output.push(visualOverview.content, '');
      continue;
    }
    if (!visualInserted && section.title === '未通过与未执行逐项清单') {
      output.push(...visualSummary.flatMap((item) => [item.content, '']));
      visualInserted = true;
    }
    output.push(section.content, '');
  }
  if (!visualInserted) output.push(...visualSummary.flatMap((item) => [item.content, '']));
  output.push(...visualSteps.flatMap((item) => [item.content, '']));
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

async function main() {
  const argv = process.argv.slice(2);
  const functional = readArg(argv, '--functional');
  const visual = readArg(argv, '--visual');
  const output = readArg(argv, '--output');
  if (!functional || !visual || !output) {
    throw new Error('必须提供 --functional、--visual 和 --output');
  }
  writeFileSync(resolve(output), composeSupervisorReport(
    readFileSync(resolve(functional), 'utf8'),
    readFileSync(resolve(visual), 'utf8'),
  ), 'utf8');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
