import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTestMatrix, renderSupervisorReport } from '../stable-smoke-supervisor-report.mjs';
import { buildNotRunLedger, collectPlaywrightCases, reconcileCaseCoverage } from '../stable-smoke-results.mjs';

const matrix = `
| caseId | 场景 | 核心断言 | CDS | 正式 |
|---|---|---|---|---|
| CORE-001 | 首页 | 首页能打开 | 必跑 | 必跑 |
| VIS-003 | 单图参考 | 参考图进入请求 | 必跑 | 最小图片档 |
| WEB-004 | 分享锚点 | 锚点留在页面内 | 必跑 | 必跑 |
`;

const plan = {
  featureLines: [
    { id: 'identity-access', label: '身份与访问', breadcrumb: ['登录', '会话', '首页'], requiredCaseIds: ['CORE-001'], regressionCaseIds: [] },
    { id: 'visual-creation', label: '视觉创作', breadcrumb: ['首页', '视觉创作', '参考图', '结果'], requiredCaseIds: ['VIS-003'], regressionCaseIds: [] },
    { id: 'web-hosting-sharing', label: '网页托管与分享', breadcrumb: ['首页', '网页托管'], requiredCaseIds: ['WEB-004'], regressionCaseIds: [] },
  ],
};

function restrictedRunFixture() {
  const cdsReport = {
    errors: [],
    suites: [{ specs: [{
      title: '[VIS-003] 单图参考',
      tests: [{ results: [{ status: 'failed', duration: 20, error: { message: '参考图没有进入请求' } }] }],
    }] }],
  };
  const productionBaseline = {
    rows: [{ caseId: 'CORE-001', environment: 'production', status: 'pass', durationMs: 10, error: '' }],
  };
  const productionSafetyGate = {
    restricted: true,
    grep: '\\[CORE-001\\]',
    reasons: ['CDS 验收断言未通过'],
  };
  const rows = reconcileCaseCoverage(
    { cds: ['VIS-003'], production: ['CORE-001', 'VIS-003'] },
    [...collectPlaywrightCases(cdsReport, 'cds'), ...productionBaseline.rows],
    ['cds', 'production'],
  );
  return {
    plan,
    matrixMarkdown: matrix,
    runId: 'stsmk-baseline-pass-assertion-fail-restricted',
    rows,
    notRunLedger: buildNotRunLedger(rows, {
      cds: true,
      production: true,
      productionRestricted: productionSafetyGate.restricted,
      productionSafetyGate,
    }),
    // 测试运行器因失败用例返回非零，但报告没有全局进程错误。
    executionFailures: ['cds'],
    selectedEnvironments: ['cds', 'production'],
  };
}

test('正式基线通过后安全门限制的未执行不冒充身份故障', () => {
  const fixture = restrictedRunFixture();
  assert.equal(fixture.rows.find((row) => row.environment === 'production' && row.caseId === 'CORE-001').status, 'pass');
  assert.equal(fixture.notRunLedger[0].reasonCode, 'production-safety-restricted');
  const report = renderSupervisorReport(fixture);

  assert.match(report, /正式环境 \| 2 \| 1 \| 1 \| 0 \| 0 \| 1 \|/);
  assert.match(report, /production-safety-restricted/);
  assert.match(report, /正式环境安全门限制为只读检查，写入旅程未运行/);
  assert.match(report, /CDS 验收断言未通过/);
  assert.doesNotMatch(report, /正式合成身份未就绪|共用身份前置未完成|确认正式验收身份可用|准备正式验收身份后补测/);
});

test('CDS 断言失败保留失败事实，不将未诊断分类升级为真实业务根因', () => {
  const report = renderSupervisorReport(restrictedRunFixture());
  assert.match(report, /主管结论：不通过/);
  assert.match(report, /1 项不通过、1 项未执行/);
  assert.match(report, /JPEG 参考图已生成产物/);
  assert.match(report, /关闭条件：原 VIS-003/);
  assert.match(report, /分类与根因待诊断/);
  assert.doesNotMatch(report, /真实业务失败/);
});

test('失败用例导致执行非零时，不凭执行失败环境断言进程异常', () => {
  const report = renderSupervisorReport(restrictedRunFixture());
  assert.match(report, /主管结论：不通过/);
  assert.match(report, /执行未成功，原因待诊断/);
  assert.doesNotMatch(report, /Playwright 进程异常退出|修复全局初始化、清理或报告器错误/);
});

test('缺少未执行原因时明确待诊断，不猜正式身份或自动化故障', () => {
  const report = renderSupervisorReport({
    plan,
    matrixMarkdown: matrix,
    runId: 'stsmk-unknown-gap',
    rows: [{ caseId: 'VIS-003', environment: 'production', status: 'not-run', durationMs: 0, error: '' }],
    selectedEnvironments: ['production'],
  });
  assert.match(report, /原因待诊断/);
  assert.doesNotMatch(report, /正式合成身份未就绪|共用身份前置未完成|准备正式验收身份后补测/);
});

test('不通过项使用实际环境并给出用户影响和可判定关闭条件', () => {
  const report = renderSupervisorReport({
    plan,
    matrixMarkdown: matrix,
    runId: 'stsmk-production-failure-unknown-cause',
    rows: [{ caseId: 'VIS-003', environment: 'production', status: 'fail', durationMs: 10, error: '' }],
    selectedEnvironments: ['production'],
  });
  const intervention = report.split('## 需干预事项')[1].split('## 业务功能线与面包屑')[0];
  assert.match(intervention, /P1 \| 正式环境 \| 1 项/);
  assert.doesNotMatch(intervention, /\| CDS \|/);
  const abnormal = report.split('## 未通过与未执行逐项清单')[1].split('## 逐项验收账本')[0];
  assert.match(abnormal, /JPEG 参考图已生成产物/);
  assert.match(abnormal, /连续两次证明字段为 image\[\]/);
  assert.doesNotMatch(abnormal, /参考图进入请求/);
});

test('测试矩阵解析场景、断言和双环境策略', () => {
  const parsed = parseTestMatrix(matrix);
  assert.equal(parsed.get('VIS-003')?.scenario, '单图参考');
  assert.equal(parsed.get('VIS-003')?.productionPolicy, '最小图片档');
  assert.equal(parsed.get('WEB-004')?.scenario, '分享锚点');
});

test('网页托管失败会路由给网页托管负责人', () => {
  const report = renderSupervisorReport({
    plan,
    matrixMarkdown: matrix,
    runId: 'stsmk-web-owner',
    rows: [{ caseId: 'WEB-004', environment: 'cds', status: 'fail', durationMs: 10, error: '片段导航离开页面' }],
    selectedEnvironments: ['cds'],
  });

  assert.match(report, /网页托管负责人/);
  assert.doesNotMatch(report, /WEB-004[^\n]*质量负责人/);
});

test('主管报告把异常提前并保留全量逐项账本', () => {
  const report = renderSupervisorReport({
    plan,
    matrixMarkdown: matrix,
    runId: 'stsmk-test',
    cdsUrl: 'https://cds.example.test/visual-agent',
    technicalUrl: 'https://reports.example.test/technical',
    rows: [
      { caseId: 'CORE-001', environment: 'cds', status: 'pass', durationMs: 10, error: '' },
      { caseId: 'CORE-001', environment: 'production', status: 'not-run', durationMs: 0, error: '' },
      { caseId: 'VIS-003', environment: 'cds', status: 'fail', durationMs: 20, error: '参考图没有进入请求' },
      { caseId: 'VIS-003', environment: 'production', status: 'not-run', durationMs: 0, error: '' },
    ],
    notRunLedger: [
      { caseId: 'CORE-001', environment: 'production', reasonCode: 'identity-missing', reason: '正式身份未就绪', sourcePath: 'e2e/specs/core.spec.ts', command: 'node scripts/stable-smoke-run.mjs', closeCondition: '身份预检通过并复测' },
      { caseId: 'VIS-003', environment: 'production', reasonCode: 'identity-missing', reason: '正式身份未就绪', sourcePath: 'e2e/specs/visual.spec.ts', command: 'node scripts/stable-smoke-run.mjs', closeCondition: '身份预检通过并复测' },
    ],
  });
  assert.match(report, /主管结论：不通过/);
  assert.match(report, /## 未通过与未执行逐项清单/);
  assert.match(report, /首页 → 视觉创作 → 参考图 → 结果 → 单图参考/);
  assert.match(report, /单图参考 \| 功能/);
  assert.match(report, /正式环境 \| 未执行项涉及模块 \| 2 项/);
  assert.doesNotMatch(report, /正式合成身份未就绪|共用身份前置未完成/);
  assert.match(report, /## 执行覆盖账本/);
  assert.match(report, /正式环境 \| 2 \| 0 \| 0 \| 0 \| 0 \| 2 \|/);
  assert.match(report, /CORE-001 \| 正式环境 \| identity-missing \| 正式身份未就绪/);
  assert.match(report, /代码或页面入口 \| 补跑命令 \| 关闭条件/);
  assert.match(report, /## 逐项验收账本/);
  assert.match(report, /#method-vis-003/);
  assert.match(report, /\| VIS-003 \| 正式环境 \| identity-missing \|/);
  assert.match(report, /node scripts\/stable-smoke-run\.mjs/);
  assert.doesNotMatch(report, /curl /);
});

test('用例行通过但执行记录未成功时主管结论仍是不通过且不猜根因', () => {
  const report = renderSupervisorReport({
    plan,
    matrixMarkdown: matrix,
    runId: 'stsmk-process-failure',
    rows: [
      { caseId: 'CORE-001', environment: 'cds', status: 'pass', durationMs: 10, error: '' },
    ],
    executionFailures: ['cds'],
  });

  assert.match(report, /主管结论：不通过/);
  assert.match(report, /执行未成功，原因待诊断/);
  assert.doesNotMatch(report, /Playwright 进程异常退出/);
  assert.doesNotMatch(report, /总体结论 \| 通过/);
});

test('单环境执行时主管模块表明确标记另一环境未选择', () => {
  const report = renderSupervisorReport({
    plan,
    matrixMarkdown: matrix,
    runId: 'stsmk-cds-only',
    rows: [
      { caseId: 'CORE-001', environment: 'cds', status: 'pass', durationMs: 10, error: '' },
    ],
    selectedEnvironments: ['cds'],
  });

  assert.match(report, /身份与访问 .* 通过（1 通过，0 失败，0 未执行） \| 未选择 \|/);
  assert.doesNotMatch(report, /未选择.*通过（0 通过，0 失败，0 未执行）/);
  assert.doesNotMatch(report, /\| 无 \| 双环境 \|/);
});

test('主管首屏优先正式环境并把稳定通过与重试通过分开', () => {
  const report = renderSupervisorReport({
    plan,
    matrixMarkdown: matrix,
    runId: 'stsmk-manager-order',
    rows: [
      { caseId: 'CORE-001', environment: 'cds', status: 'pass', durationMs: 10, error: '' },
      { caseId: 'CORE-001', environment: 'production', status: 'pass', durationMs: 10, error: '', hadFailedAttempt: true },
      { caseId: 'VIS-003', environment: 'production', status: 'not-run', durationMs: 0, error: '' },
    ],
    notRunLedger: [{ caseId: 'VIS-003', environment: 'production', reasonCode: 'production-safety-restricted', reason: '安全门限制为只读' }],
    selectedEnvironments: ['cds', 'production'],
  });
  assert.match(report, /\| 稳定通过 \| 1\/3 \|/);
  assert.match(report, /\| 重试后通过 \| 1\/3 \|/);
  assert.match(report, /正式环境本轮已执行 1\/2 项/);
  const coverage = report.split('## 执行覆盖账本')[1].split('## 需干预事项')[0];
  assert.ok(coverage.indexOf('| 正式环境 |') < coverage.indexOf('| CDS |'));
  assert.match(coverage, /production-safety-restricted \| 1 \| CDS 出现高风险失败与清理未知，正式写入矩阵按安全门保持未启动/);
});
