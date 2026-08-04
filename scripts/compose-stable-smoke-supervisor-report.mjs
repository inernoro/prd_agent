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

const visualGateSummarySections = new Set(['模块覆盖', '需处理事项']);
const visualGateLedgerSections = new Set(['逐张视觉证据账本', '视觉测试方法']);
const conciseVisualSections = new Set(['缺陷清单']);

function parseMarkdownTable(sectionContent) {
  const lines = String(sectionContent || '').split('\n');
  const tableLines = lines.filter((line) => /^\|.*\|$/.test(line.trim()));
  if (tableLines.length < 3) return null;
  const cells = (line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
  return {
    headers: cells(tableLines[0]),
    rows: tableLines.slice(2).map(cells),
  };
}

export function synchronizeVisualOverview(overviewContent, gateModuleContent) {
  const overviewTable = parseMarkdownTable(overviewContent);
  const gateTable = parseMarkdownTable(gateModuleContent);
  if (!overviewTable || !gateTable) return overviewContent;

  const gateModuleIndex = gateTable.headers.indexOf('模块');
  const gateStatusIndex = gateTable.headers.indexOf('视觉结论');
  const overviewModuleIndex = overviewTable.headers.indexOf('模块');
  const overviewStatusIndex = overviewTable.headers.indexOf('视觉');
  const overviewSeverityIndex = overviewTable.headers.indexOf('最高问题');
  const overviewInterventionIndex = overviewTable.headers.indexOf('是否需干预');
  if ([gateModuleIndex, gateStatusIndex, overviewModuleIndex, overviewStatusIndex].some((index) => index < 0)) {
    return overviewContent;
  }

  const gateStatusByModule = new Map(gateTable.rows.map((row) => [row[gateModuleIndex], row[gateStatusIndex]]));
  const rewrittenRows = overviewTable.rows.map((row) => {
    const status = gateStatusByModule.get(row[overviewModuleIndex]);
    if (!status) return row;
    const next = [...row];
    next[overviewStatusIndex] = status;
    if (status !== '通过') {
      if (overviewSeverityIndex >= 0 && (!next[overviewSeverityIndex] || next[overviewSeverityIndex] === '无')) {
        next[overviewSeverityIndex] = 'P2';
      }
      if (overviewInterventionIndex >= 0) next[overviewInterventionIndex] = '是';
    }
    return next;
  });
  const tableLines = [
    `| ${overviewTable.headers.join(' | ')} |`,
    `|${overviewTable.headers.map(() => '---').join('|')}|`,
    ...rewrittenRows.map((row) => `| ${row.join(' | ')} |`),
  ];
  return String(overviewContent).replace(/(?:^\|.*\|$\n?){3,}/m, `${tableLines.join('\n')}\n`);
}

export function composeSupervisorReport(functionalMarkdown, visualMarkdown, visualGateMarkdown = '', visualPlanMarkdown = '') {
  const functional = parseReportSections(functionalMarkdown);
  const visual = parseReportSections(visualMarkdown);
  const visualGate = parseReportSections(visualGateMarkdown);
  const visualPlan = parseReportSections(visualPlanMarkdown);
  const visualSummary = visual.sections.filter((section) => (
    visualGateMarkdown ? conciseVisualSections.has(section.title) : visualBeforeLedger.has(section.title)
  ));
  const visualGateSummary = visualGate.sections.filter((section) => visualGateSummarySections.has(section.title));
  const visualGateLedger = visualGate.sections.filter((section) => visualGateLedgerSections.has(section.title));
  const visualSteps = visual.sections.filter((section) => /^步骤\s+\d+/.test(section.title));
  const visualPlanSections = visualPlan.sections.filter((section) => section.title === '逐模块视觉取证任务');
  const visualOverview = visual.sections.find((section) => section.title === '主管验收总览');
  const visualGateModules = visualGate.sections.find((section) => section.title === '模块覆盖');
  const inferredVerdict = /不通过/.test(functional.lead)
    ? 'fail'
    : /部分通过/.test(functional.lead)
      ? 'conditional'
      : 'pass';
  const output = [functional.lead, '', `Verdict: ${inferredVerdict}`, ''];
  let visualSummaryInserted = false;
  let visualLedgerInserted = false;
  for (const section of functional.sections) {
    if (section.title === '主管验收总览') {
      output.push(section.content.replace(/^## 主管验收总览/m, '## 主管先看'), '');
      if (visualOverview) {
        output.push(synchronizeVisualOverview(visualOverview.content, visualGateModules?.content), '');
      }
      continue;
    }
    output.push(section.content, '');
    if (!visualSummaryInserted && section.title === '需干预事项') {
      output.push(...visualGateSummary.flatMap((item) => [item.content, '']));
      output.push(...visualPlanSections.flatMap((item) => [item.content, '']));
      visualSummaryInserted = true;
    }
    if (section.title === '未通过与未执行逐项清单') {
      output.push(...visualSummary.flatMap((item) => [item.content, '']));
    }
    if (!visualLedgerInserted && section.title === '逐项验收账本') {
      output.push(...visualGateLedger.flatMap((item) => [item.content, '']));
      visualLedgerInserted = true;
    }
  }
  if (!visualSummaryInserted) {
    output.push(...visualGateSummary.flatMap((item) => [item.content, '']));
  }
  if (!visualLedgerInserted) output.push(...visualGateLedger.flatMap((item) => [item.content, '']));
  output.push(...visualSteps.flatMap((item) => [item.content, '']));
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

async function main() {
  const argv = process.argv.slice(2);
  const functional = readArg(argv, '--functional');
  const visual = readArg(argv, '--visual');
  const visualGate = readArg(argv, '--visual-gate');
  const visualPlan = readArg(argv, '--visual-plan');
  const output = readArg(argv, '--output');
  if (!functional || !visual || !output) {
    throw new Error('必须提供 --functional、--visual 和 --output');
  }
  writeFileSync(resolve(output), composeSupervisorReport(
    readFileSync(resolve(functional), 'utf8'),
    readFileSync(resolve(visual), 'utf8'),
    visualGate ? readFileSync(resolve(visualGate), 'utf8') : '',
    visualPlan ? readFileSync(resolve(visualPlan), 'utf8') : '',
  ), 'utf8');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
