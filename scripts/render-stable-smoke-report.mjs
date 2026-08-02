import { readFileSync, writeFileSync } from 'node:fs';

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const input = readArg('--input', 'e2e/results.json');
const planInput = readArg('--plan', 'stable-smoke-plan/plan.json');
const output = readArg('--output', 'e2e/stable-smoke-report.md');
const environment = readArg('--environment', 'unknown');
const runId = readArg('--run-id', `stsmk-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12)}`);
const baseUrlConfigured = readArg('--base-url-configured', 'false') === 'true';

let report;
try {
  report = JSON.parse(readFileSync(input, 'utf8'));
} catch {
  report = null;
}

let plan;
try {
  plan = JSON.parse(readFileSync(planInput, 'utf8'));
} catch {
  plan = null;
}

const rows = [];
function collectSuites(suites = []) {
  for (const suite of suites) {
    for (const spec of suite.specs || []) {
      const tests = spec.tests || [];
      const results = tests.flatMap((test) => test.results || []);
      const finalResult = results.at(-1);
      const status = finalResult?.status || 'not-run';
      const duration = results.reduce((sum, item) => sum + (item.duration || 0), 0);
      rows.push({ title: spec.title, status, duration });
    }
    collectSuites(suite.suites || []);
  }
}
if (report) collectSuites(report.suites || []);

const failed = rows.filter((row) => row.status !== 'passed');
const executionVerdict = !report || rows.length === 0 ? 'conditional' : failed.length > 0 ? 'fail' : 'pass';
const verdict = executionVerdict === 'fail' || plan?.verdict === 'fail'
  ? 'fail'
  : executionVerdict === 'conditional' || !plan || plan.verdict === 'conditional'
    ? 'conditional'
    : 'pass';
const statusLabel = (status) => status === 'passed' ? 'pass' : status === 'skipped' ? 'conditional' : 'fail';
const totalDuration = rows.reduce((sum, row) => sum + row.duration, 0);

const lines = [
  `# 稳定冒烟验收报告 · ${runId}`,
  '',
  `Verdict: ${verdict}`,
  '',
  '## 1. 验收目标',
  '',
  '验证合成测试账号可在 SSO 环境使用短时一次性入口，并检查关键创作模块在部署环境中的可达性、前端运行错误和移动端横向溢出。',
  '',
  '## 2. 验收范围',
  '',
  '本轮覆盖身份、视觉创作、文学创作、视频创作、录音与上传解析、多图视觉创作、模型网关配置及移动端核心入口。真实生成、上传、取消、恢复和清理属于后续深层矩阵，不由入口冒烟替代。',
  '',
  '## 3. 环境与版本',
  '',
  `- 环境：${environment}`,
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
  '## 5. 模块结果',
  '',
  '| 模块或场景 | 结果 | 耗时 |',
  '|---|---|---:|',
  ...rows.map((row) => `| ${row.title.replaceAll('|', '\\|')} | ${statusLabel(row.status)} | ${(row.duration / 1000).toFixed(2)}s |`),
];

if (rows.length === 0) {
  lines.push('| 未执行 | conditional | 0.00s |');
}

lines.push(
  '',
  '## 5.1 业务功能线覆盖',
  '',
  '| 功能线 | 等级 | 面包屑 | 自动化现状 |',
  '|---|---|---|---|',
  ...(plan?.featureLines || []).map((feature) => `| ${feature.label} | ${feature.criticality} | ${feature.breadcrumb.join(' → ')} | ${feature.automationStatus} |`),
  '',
  '## 6. 失败与证据',
  '',
  failed.length > 0
    ? failed.map((row) => `- ${row.title}：${row.status}。详细截图、trace、视频和错误上下文见同一本地运行目录。`).join('\n')
    : report
      ? '- 未发现入口级失败；截图与 Playwright 报告见同一本地运行目录。'
      : '- Playwright JSON 报告缺失，本轮不得判定为通过。请检查环境密钥、部署状态和浏览器测试步骤后重跑。',
  '',
  '## 7. 双环境差异',
  '',
  '本文件记录单一环境结果。CDS 环境与正式环境报告使用相同 case 和结构，整轮结论必须在汇总时比较两份报告；任一环境缺失时整轮最多为 conditional。',
  '',
  '## 8. 清理结果',
  '',
  '本轮入口冒烟不创建业务资源，无业务数据需要清理。一次性登录票据由原子消费和 TTL 索引回收，短会话不可续期。',
  '',
  '## 9. 结论与下一步',
  '',
  `本环境结论为 ${verdict}，共执行 ${rows.length} 条，失败或未完成 ${failed.length} 条，总耗时 ${(totalDuration / 1000).toFixed(2)}s。入口级通过不等于全功能通过；真实产物矩阵按稳定冒烟台账继续执行。`,
  '',
);

writeFileSync(output, lines.join('\n'), 'utf8');
