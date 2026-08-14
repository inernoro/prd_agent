import { readFileSync, writeFileSync } from 'node:fs';
import {
  buildNotRunLedger,
  collectPlaywrightCases,
  environmentResultLabel,
  reconcileCaseCoverage,
  selectRequiredCaseIds,
  summarizeCoverage,
  userReadableError,
} from './stable-smoke-results.mjs';
import { renderSupervisorReport } from './stable-smoke-supervisor-report.mjs';
import { dirname, resolve } from 'node:path';

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const input = readArg('--input', 'e2e/results.json');
const cdsInput = readArg('--cds-input', input);
const productionInput = readArg('--production-input', '');
const planInput = readArg('--plan', 'stable-smoke-plan/plan.json');
const output = readArg('--output', 'e2e/stable-smoke-report.md');
const supervisorOutput = readArg('--supervisor-output', resolve(dirname(output), 'supervisor-report.md'));
const technicalUrl = readArg('--technical-url', './report.md');
const cdsUrl = readArg('--cds-url');
const productionUrl = readArg('--production-url', 'https://map.ebcone.net');
const matrixInput = readArg('--matrix', '.claude/skills/stable-smoke/reference/test-matrix.md');
const environment = readArg('--environment', 'unknown');
const grepExpression = readArg('--grep');
const selectedEnvironments = readArg('--environments', 'cds,production')
  .split(',')
  .map((item) => item.trim())
  .filter((item) => item === 'cds' || item === 'production');
const environmentDescription = environment !== 'unknown'
  ? environment
  : selectedEnvironments.map((item) => item === 'cds' ? 'CDS 环境' : '正式环境').join('、');
const runId = readArg('--run-id', `stsmk-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12)}`);
const baseUrlConfigured = readArg('--base-url-configured', 'false') === 'true';
const executionSummaryInput = readArg('--execution-summary');

function readJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const cdsReport = readJson(cdsInput);
const productionReport = readJson(productionInput);
const executionSummary = readJson(executionSummaryInput);

let plan;
try {
  plan = JSON.parse(readFileSync(planInput, 'utf8'));
} catch {
  plan = null;
}

const evidenceRows = [
  ...collectPlaywrightCases(cdsReport, 'cds'),
  ...collectPlaywrightCases(productionReport, 'production'),
  ...(Array.isArray(executionSummary?.supplementalEvidenceRows)
    ? executionSummary.supplementalEvidenceRows
    : []),
];
const requiredCaseIdsByEnvironment = Object.fromEntries(selectedEnvironments.map((targetEnvironment) => {
  const execution = executionSummary?.executions?.find((item) => item.environment === targetEnvironment);
  const fromExecution = Array.isArray(execution?.requiredCaseIds) ? execution.requiredCaseIds : null;
  return [
    targetEnvironment,
    fromExecution
      || plan?.requiredCaseIdsByEnvironment?.[targetEnvironment]
      || plan?.requiredCaseIds
      || [],
  ];
}));
const rows = reconcileCaseCoverage(
  grepExpression
    ? Object.fromEntries(Object.entries(requiredCaseIdsByEnvironment).map(([targetEnvironment, caseIds]) => [
      targetEnvironment,
      selectRequiredCaseIds(
        caseIds,
        grepExpression,
        evidenceRows.filter((row) => row.environment === targetEnvironment),
      ),
    ]))
    : requiredCaseIdsByEnvironment,
  evidenceRows,
  selectedEnvironments.length > 0 ? selectedEnvironments : ['cds', 'production'],
);
const coverageSummary = summarizeCoverage(rows, plan?.verdict || 'conditional');
const executionFailures = Array.isArray(executionSummary?.coverage?.executionFailures)
  ? executionSummary.coverage.executionFailures
  : [];
const summary = executionFailures.length > 0
  ? { ...coverageSummary, verdict: 'fail', executionFailures }
  : coverageSummary;
const notRunLedger = buildNotRunLedger(rows, {
  cds: Boolean(cdsReport),
  production: Boolean(productionReport),
  productionRestricted: executionSummary?.productionSafetyGate?.restricted === true,
  productionSafetyGate: executionSummary?.productionSafetyGate,
});
const verdict = summary.verdict;
const totalDuration = rows.reduce((sum, row) => sum + row.durationMs, 0);
const grouped = new Map();
for (const row of rows) {
  const prefix = row.caseId.startsWith('REG-') ? row.caseId.split('-').slice(0, 3).join('-') : row.caseId.split('-')[0];
  const key = prefix;
  const value = grouped.get(key) || [];
  value.push(row);
  grouped.set(key, value);
}

const lines = [
  `# 稳定冒烟验收报告 · ${runId}`,
  '',
  `Verdict: ${verdict}`,
  '',
  '## 1. 验收目标',
  '',
  '验证 CDS 环境与正式环境的关键业务旅程，并对计划中的每个 caseId 建立执行、产物、失败、清理和恢复证据。',
  '',
  '## 2. 验收范围',
  '',
  '本轮覆盖身份、录音、文件与短视频解析、文学创作、单图和多图视觉创作、视频创作、模型治理、用户可读错误、进度与响应式布局。没有真实执行证据的计划用例明确记为 not-run。',
  '',
  '## 3. 环境与版本',
  '',
  `- 环境：${environmentDescription || '未选择'}`,
  `- runId：${runId}`,
  `- 地址配置：${baseUrlConfigured ? '已注入' : '缺失'}`,
  `- 执行时间：${new Date().toISOString()}`,
  `- 业务台账版本：${plan?.catalogVersion || '缺失'}`,
  `- 固定 commit：${plan?.commit || '缺失'}`,
  `- 进程级失败环境：${executionFailures.length > 0 ? executionFailures.join('、') : '无'}`,
  '',
  '## 4. 身份与安全边界',
  '',
  '使用环境白名单内的合成测试专用账号。登录票据有效期 3 分钟、单次消费；登录会话最长 30 分钟且不能刷新。报告不保存票据、AI 超级密钥或访问令牌。',
  '',
  `- 执行证据：${evidenceRows.length} 条`,
  `- 计划环境用例：${rows.length} 条`,
  `- 通过：${summary.passed}；失败：${summary.failed}；未执行：${summary.notRun}；重试后通过：${summary.flaky}`,
  '',
  '## 4.1 执行覆盖账本',
  '',
  '| 环境 | 计划 | 已执行 | 通过 | 失败 | 未执行 | 阻塞类别 | 直接执行路径 |',
  '|---|---:|---:|---:|---:|---:|---|---|',
  ...['cds', 'production'].map((targetEnvironment) => {
    if (!selectedEnvironments.includes(targetEnvironment)) {
      return `| ${targetEnvironment === 'cds' ? 'CDS 环境' : '正式环境'} | 0 | 0 | 0 | 0 | 0 | 未选择 | 本轮未选择 |`;
    }
    const environmentRows = rows.filter((row) => row.environment === targetEnvironment);
    const environmentNotRun = environmentRows.filter((row) => row.status === 'not-run');
    const reportAvailable = targetEnvironment === 'cds' ? Boolean(cdsReport) : Boolean(productionReport);
    const blocker = environmentNotRun.length === 0
      ? '无'
      : reportAvailable
        ? '自动化步骤缺失'
        : targetEnvironment === 'production'
          ? '正式环境专用身份缺失'
          : '环境执行报告缺失';
    const command = targetEnvironment === 'cds'
      ? 'node scripts/stable-smoke-run.mjs --cds-only'
      : 'node scripts/stable-smoke-run.mjs';
    return `| ${targetEnvironment === 'cds' ? 'CDS 环境' : '正式环境'} | ${environmentRows.length} | ${environmentRows.length - environmentNotRun.length} | ${environmentRows.filter((row) => row.status === 'pass').length} | ${environmentRows.filter((row) => row.status === 'fail').length} | ${environmentNotRun.length} | ${blocker} | \`${command}\` |`;
  }),
  '',
  '识别规则：`pass` 或 `fail` 表示真实执行过；`not-run` 只表示没有执行证据，不能按通过计算。每个未执行项必须在下表给出阻塞原因、代码入口、补跑命令和关闭条件。',
  '',
  '## 4.2 未执行明细与补跑路径',
  '',
  '| caseId | 环境 | 阻塞代码 | 为什么未执行 | 代码入口 | 补跑命令 | 关闭条件 |',
  '|---|---|---|---|---|---|---|',
  ...notRunLedger.map((row) => `| ${row.caseId} | ${row.environment === 'cds' ? 'CDS 环境' : '正式环境'} | ${row.reasonCode} | ${row.reason} | \`${row.sourcePath}\` | \`${row.command.replaceAll('|', '\\|')}\` | ${row.closeCondition} |`),
  '',
  '## 5. 模块结果',
  '',
  '| 模块 | CDS 环境 | 正式环境 | 计划用例 | 失败 | 未执行 | 耗时 |',
  '|---|---|---|---:|---:|---:|---:|',
  ...[...grouped.entries()].map(([module, moduleRows]) => {
    const cdsRows = moduleRows.filter((row) => row.environment === 'cds');
    const prodRows = moduleRows.filter((row) => row.environment === 'production');
    const cdsLabel = environmentResultLabel(cdsRows, selectedEnvironments.includes('cds'));
    const productionLabel = environmentResultLabel(prodRows, selectedEnvironments.includes('production'));
    return `| ${module} | ${cdsLabel} | ${productionLabel} | ${moduleRows.length} | ${moduleRows.filter((row) => row.status === 'fail').length} | ${moduleRows.filter((row) => row.status === 'not-run').length} | ${(moduleRows.reduce((sum, row) => sum + row.durationMs, 0) / 1000).toFixed(2)}s |`;
  }),
];

if (rows.length === 0) {
  lines.push('| 未生成计划 | conditional | conditional | 0 | 0 | 0 | 0.00s |');
}

lines.push(
  '',
  '## 5.1 业务功能线覆盖',
  '',
  '| 功能线 | 等级 | 面包屑 | 自动化现状 |',
  '|---|---|---|---|',
  ...(plan?.featureLines || []).map((feature) => `| ${feature.label} | ${feature.criticality} | ${feature.breadcrumb.join(' → ')} | ${feature.automationStatus} |`),
  '',
  '## 6. caseId 结果与证据',
  '',
  '| caseId | 环境 | 结果 | 断言或阻塞原因 | 直接路径 | 耗时 |',
  '|---|---|---|---|---|---:|',
  ...rows.map((row) => {
    const gap = notRunLedger.find((item) => item.caseId === row.caseId && item.environment === row.environment);
    const detail = gap?.reason || userReadableError(row.error || row.title);
    const directPath = gap ? gap.command : '见 Playwright 执行证据';
    return `| ${row.caseId} | ${row.environment === 'cds' ? 'CDS 环境' : '正式环境'} | ${row.status} | ${detail.replaceAll('|', '\\|')} | ${directPath.replaceAll('|', '\\|')} | ${(row.durationMs / 1000).toFixed(2)}s |`;
  }),
  '',
  '## 7. 双环境差异',
  '',
  `CDS 执行报告：${cdsReport ? '已读取' : selectedEnvironments.includes('cds') ? '缺失' : '本轮未选择'}；正式环境执行报告：${productionReport ? '已读取' : selectedEnvironments.includes('production') ? '缺失' : '本轮未选择'}。选中环境的任一必跑用例缺少证据时，整轮最多为 conditional；未选择环境不计入本轮结论。`,
  '',
  '## 8. 清理结果',
  '',
  '业务旅程必须在各测试用例的 finally 阶段清理，并回读确认。没有清理断言的用例不得判定为通过；清理失败归类为 cleanup P1。',
  '',
  '## 9. 结论与下一步',
  '',
  `整轮结论为 ${verdict}，计划 ${rows.length} 条环境用例，通过 ${summary.passed} 条，失败 ${summary.failed} 条，未执行 ${summary.notRun} 条，总耗时 ${(totalDuration / 1000).toFixed(2)}s。只有计划内用例全部获得真实证据且无失败、无重试抖动时才能判定 pass。`,
  '',
);

writeFileSync(output, lines.join('\n'), 'utf8');
writeFileSync(supervisorOutput, renderSupervisorReport({
  plan,
  rows,
  notRunLedger,
  matrixMarkdown: readFileSync(matrixInput, 'utf8'),
  runId,
  technicalUrl,
  cdsUrl,
  productionUrl,
  executionFailures,
  selectedEnvironments,
}), 'utf8');
