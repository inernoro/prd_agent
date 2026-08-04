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

function visualCoverageRows(sectionContent) {
  const table = parseMarkdownTable(sectionContent);
  if (!table) return [];
  return table.rows.map((row) => Object.fromEntries(table.headers.map((header, index) => [header, row[index] || ''])));
}

function synchronizeExecutiveSummary(executiveContent, visualGateLeadContent) {
  const gateTable = parseMarkdownTable(visualGateLeadContent);
  if (!gateTable) return executiveContent;
  const projectIndex = gateTable.headers.indexOf('项目');
  const resultIndex = gateTable.headers.indexOf('结果');
  const evidenceRow = gateTable.rows.find((row) => ['可审核证据', '合格证据'].includes(row[projectIndex]));
  const moduleRow = gateTable.rows.find((row) => row[projectIndex] === '模块通过');
  if (!evidenceRow || !moduleRow) return executiveContent;
  const replacement = `| 视觉验收 | ${evidenceRow[resultIndex]} 张可审核证据，${moduleRow[resultIndex]} 个模块通过 | 可审核不等于通过；从模块总览进入异常状态或证据 |`;
  if (/^\|\s*视觉证据\s*\|.*$/m.test(executiveContent)) {
    return executiveContent.replace(/^\|\s*视觉证据\s*\|.*$/m, replacement);
  }
  return executiveContent;
}

function synchronizeMethodSummary(methodContent, visualGateLeadContent) {
  const gateTable = parseMarkdownTable(visualGateLeadContent);
  if (!gateTable) return methodContent;
  const projectIndex = gateTable.headers.indexOf('项目');
  const resultIndex = gateTable.headers.indexOf('结果');
  const evidenceRow = gateTable.rows.find((row) => ['可审核证据', '合格证据'].includes(row[projectIndex]));
  if (!evidenceRow) return methodContent;
  const replacement = `| 视觉测试 | 每个关键页面状态是否完整、可操作、可理解 | ${evidenceRow[resultIndex]} 张可审核证据，异常状态单独核销 | [查看逐项视觉方法](#视觉测试方法) |`;
  if (/^\|\s*视觉测试\s*\|.*$/m.test(methodContent)) {
    return methodContent.replace(/^\|\s*视觉测试\s*\|.*$/m, replacement);
  }
  return methodContent;
}

export function renderHumanReadableAcceptanceDesign(gateModuleContent) {
  const rows = visualCoverageRows(gateModuleContent).map((row) => ({
    ...row,
    '视觉结论': row['视觉结论'] || '未执行',
    '采集文件': row['采集文件'] || '0',
    '可审核证据': row['可审核证据'] || row['合格证据'] || '0/待定',
    '缺口': row['缺口'] || '待补齐逐项证据',
    '查看全部截图': row['查看全部截图'] || '',
  }));
  if (rows.length === 0) return '';
  const lines = [
    '## 改动断言表',
    '',
    '| 改动断言 | 必要证明 | 当前结果 |',
    '|---|---|---|',
    ...rows.map((row) => `| ${row['模块']}的关键用户旅程可用 | 冒烟或功能结果，加 ${String(row['可审核证据']).split('/')[1] || row['可审核证据']} 张逐项视觉证据，且关键状态无缺口 | ${row['视觉结论']}；视觉部分按未完成处理 |`),
    '',
    '## 影响面矩阵',
    '',
    '| 模块 | 用户可见范围 | 完整用户路径 | 当前风险 |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row['模块']} | 入口、操作、等待、结果、失败恢复和适用设备 | ${row['真实面包屑']} | ${row['缺口']} |`),
    '',
    '## 融合测试设计',
    '',
    '| 用户旅程 | 融合范围 | 关键断点 | 当前判定 |',
    '|---|---|---|---|',
    '| 登录后修改本人头像 | 登录、权限、头像、图片上传、生成进度、保存与移动端 | 入口、权限、上传、生成、持久化 | 视觉未执行，必须按逐项清单补跑 |',
    '| 使用单图或多图完成视觉创作 | 上传、引用、模型路由、生成进度、结果和失败恢复 | 图片顺序、请求提交、动态进度、结果 | 功能账本与视觉账本分别判定，不能互相替代 |',
    '| 内容上传后得到可读结果 | 文件、音频、短视频、解析进度、结果与恢复 | 类型识别、上传、解析、转录、持久化 | 录音存在失败，其余未执行项必须补齐 |',
    '| 从文稿到视频终态 | 文学创作、脚本、分镜、关键帧、成片与长任务反馈 | 流式生成、阶段进度、失败恢复、刷新回读 | 视觉未执行，正式环境功能未执行 |',
    '',
    '## 证明力矩阵',
    '',
    '| 结论 | 用户可见页面 | 交互动作 | 内部佐证 | 失败条件 | 证明力 |',
    '|---|---|---|---|---|---|',
    '| 功能通过 | 真实入口、输入、进度和结果页 | 按面包屑完成点击、输入、上传与回读 | 接口结果和持久化只作补充 | 任一步未执行、失败或无法回读 | 仅对已执行功能项有效 |',
    '| 视觉通过 | 每个计划状态各有唯一截图 | 使用真实鼠标或触控完成用户操作 | 截图元数据和运行记录只作补充 | 数量不足、状态缺失、重复图或无方法链接 | 当前不成立，0/148 合格 |',
    '| 全面通过 | CDS 与正式环境同一套关键旅程均通过 | 两环境独立登录并完成全套 | 版本、回滚和报告记录 | 任一失败或未执行 | 当前不成立 |',
    '',
    '## 页面优先证据分层',
    '',
    '| 层级 | 用户可见页面 | 页面证据 | 内部佐证 | 使用原则 |',
    '|---|---|---|---|---|',
    '| 第一层 | 用户实际看到的入口、操作、进度、结果与错误 | 唯一截图和完整面包屑 | 无 | 先回答用户能否完成任务 |',
    '| 第二层 | 同一页面刷新后的持久化结果 | 前后状态截图 | 数据回读 | 证明结果不是临时假象 |',
    '| 第三层 | 页面无法解释的失败原因 | 用户可读错误截图 | 脱敏运行记录 | 只用于定位，不替代页面证据 |',
    '',
    '## 改动断言到证据表',
    '',
    '| 改动断言 | 必要证明 | 实际证据 | 关联性 |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row['模块']}关键旅程可用 | ${row['可审核证据']} 张唯一证据、关键状态完整、结果无失败 | 已采集 ${row['采集文件']} 张旧文件，但可审核证据为 ${row['可审核证据']}；[查看逐项任务](#visual-plan-${String(row['查看全部截图'] || '').match(/visual-ledger-([^)]+)/)?.[1] || ''}) | 旧文件缺逐项元数据，不能证明该断言 |`),
    '',
    '## 覆盖缺口',
    '',
    '| 模块 | 覆盖缺口 | 影响 | 补跑路径 | 当前状态 | 是否需干预 |',
    '|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row['模块']} | ${row['缺口']} | 不得判定全面视觉通过 | ${row['真实面包屑']} | ${row['视觉结论']} | 是 |`),
    '',
    '## 移动端验收',
    '',
    '- 视口：计划使用真实触控移动端视口逐模块执行，桌面浏览器仅改变宽度不能代替移动端证据。',
    '- 触控与入口路径：从登录或首页开始，以触控方式打开导航并沿每项完整面包屑进入目标状态。',
    '- 结果状态：入口、操作、等待、成功、失败恢复和持久化必须分别记录；当前新口径证据未执行。',
    '- 滚动：逐页检查纵向滚动是否可达全部操作，弹窗和长内容不得形成滚动死区。',
    '- 横向溢出：检查页面、画布、进度条和弹窗，不允许内容超出视口后无法操作。',
    '- 遮挡裁切：检查底部按钮、输入框、进度信息和结果区域，任何遮挡或裁切均标记不通过。',
    '- 当前结论：旧移动端截图属于已采集文件，但缺少新口径逐项元数据，不能作为合格视觉证据。',
    '',
  ];
  return lines.join('\n');
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
  const visualGateLead = visualGate.sections.find((section) => section.title === '主管先看');
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
    if (section.title === '视觉证据预算' || section.title === '业务功能线与面包屑' || /^步骤\s+\d+/.test(section.title)) {
      continue;
    }
    if (section.title === '主管先看') {
      output.push(synchronizeExecutiveSummary(section.content, visualGateLead?.content || ''), '');
      continue;
    }
    if (section.title === '主管验收总览') {
      if (visualOverview) {
        output.push(synchronizeVisualOverview(visualOverview.content, visualGateModules?.content), '');
      } else {
        output.push(section.content, '');
      }
      continue;
    }
    if (section.title === '关联测试方法') {
      output.push(synchronizeMethodSummary(section.content, visualGateLead?.content || ''), '');
      continue;
    }
    output.push(section.content, '');
    if (!visualSummaryInserted && section.title === '需干预事项') {
      output.push(...visualGateSummary.flatMap((item) => [item.content, '']));
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
  output.push(...visualPlanSections.flatMap((item) => [item.content, '']));
  if (!visualLedgerInserted) output.push(...visualGateLedger.flatMap((item) => [item.content, '']));
  output.push(...visualSteps.flatMap((item) => [item.content, '']));
  return output.join('\n')
    .replace(/\bcaseId\b/g, '验收项')
    .replace(/\b(?:CORE|COMMON|REC|FILE|PARSE|VIDEO|LIT|VIS|MVIS|GW)-\d+\b/g, '对应验收项')
    .replace(/\bflaky\b/gi, '重试后通过')
    .replace(/\b5xx\b/gi, '服务异常')
    .replace(/Keychain/g, '本机安全凭据库')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
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
