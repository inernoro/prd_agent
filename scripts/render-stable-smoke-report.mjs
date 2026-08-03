import { readFileSync, writeFileSync } from 'node:fs';
import {
  collectPlaywrightCases,
  reconcileCaseCoverage,
  summarizeCoverage,
  userReadableError,
} from './stable-smoke-results.mjs';

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const input = readArg('--input', 'e2e/results.json');
const cdsInput = readArg('--cds-input', input);
const productionInput = readArg('--production-input', '');
const planInput = readArg('--plan', 'stable-smoke-plan/plan.json');
const output = readArg('--output', 'e2e/stable-smoke-report.md');
const environment = readArg('--environment', 'unknown');
const runId = readArg('--run-id', `stsmk-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12)}`);
const baseUrlConfigured = readArg('--base-url-configured', 'false') === 'true';

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

let plan;
try {
  plan = JSON.parse(readFileSync(planInput, 'utf8'));
} catch {
  plan = null;
}

const evidenceRows = [
  ...collectPlaywrightCases(cdsReport, 'cds'),
  ...collectPlaywrightCases(productionReport, 'production'),
];
const rows = reconcileCaseCoverage(plan?.requiredCaseIds || [], evidenceRows);
const summary = summarizeCoverage(rows, plan?.verdict || 'conditional');
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
  `- 环境：${environment === 'unknown' ? 'CDS 环境与正式环境' : environment}`,
  `- runId：${runId}`,
  `- 地址配置：${baseUrlConfigured ? '已注入' : '缺失'}`,
  `- 执行时间：${new Date().toISOString()}`,
  `- 业务台账版本：${plan?.catalogVersion || '缺失'}`,
  `- 固定 commit：${plan?.commit || '缺失'}`,
  '',
  '## 4. 身份与安全边界',
  '',
  '使用环境白名单内的合成测试专用账号。登录票据有效期 3 分钟、单次消费；登录会话最长 30 分钟且不能刷新。报告不保存票据、AI 超级密钥或访问令牌。',
  '',
  `- 执行证据：${evidenceRows.length} 条`,
  `- 计划环境用例：${rows.length} 条`,
  `- 通过：${summary.passed}；失败：${summary.failed}；未执行：${summary.notRun}；重试后通过：${summary.flaky}`,
  '',
  '## 5. 模块结果',
  '',
  '| 模块 | CDS 环境 | 正式环境 | 计划用例 | 失败 | 未执行 | 耗时 |',
  '|---|---|---|---:|---:|---:|---:|',
  ...[...grouped.entries()].map(([module, moduleRows]) => {
    const cdsRows = moduleRows.filter((row) => row.environment === 'cds');
    const prodRows = moduleRows.filter((row) => row.environment === 'production');
    const label = (items) => items.some((row) => row.status === 'fail') ? 'fail' : items.some((row) => row.status === 'not-run') ? 'conditional' : 'pass';
    return `| ${module} | ${label(cdsRows)} | ${label(prodRows)} | ${moduleRows.length} | ${moduleRows.filter((row) => row.status === 'fail').length} | ${moduleRows.filter((row) => row.status === 'not-run').length} | ${(moduleRows.reduce((sum, row) => sum + row.durationMs, 0) / 1000).toFixed(2)}s |`;
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
  '| caseId | 环境 | 结果 | 断言或阻塞原因 | 耗时 |',
  '|---|---|---|---|---:|',
  ...rows.map((row) => `| ${row.caseId} | ${row.environment === 'cds' ? 'CDS 环境' : '正式环境'} | ${row.status} | ${userReadableError(row.error || row.title).replaceAll('|', '\\|')} | ${(row.durationMs / 1000).toFixed(2)}s |`),
  '',
  '## 7. 双环境差异',
  '',
  `CDS 执行报告：${cdsReport ? '已读取' : '缺失'}；正式环境执行报告：${productionReport ? '已读取' : '缺失'}。任一环境或必跑用例缺少证据时，整轮最多为 conditional。`,
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
