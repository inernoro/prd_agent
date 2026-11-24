import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTestMatrix, renderSupervisorReport } from '../stable-smoke-supervisor-report.mjs';

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
  assert.match(report, /正式合成身份未就绪/);
  assert.match(report, /正式环境 \| 全部计划模块 \| 2 项/);
  assert.equal((report.match(/正式合成身份未就绪/g) || []).length, 1);
  assert.match(report, /## 执行覆盖账本/);
  assert.match(report, /正式环境 \| 2 \| 0 \| 0 \| 0 \| 2 \|/);
  assert.match(report, /CORE-001 \| 正式环境 \| identity-missing \| 正式身份未就绪/);
  assert.match(report, /代码或页面入口 \| 补跑命令 \| 关闭条件/);
  assert.match(report, /## 逐项验收账本/);
  assert.match(report, /#method-vis-003/);
  assert.match(report, /\| VIS-003 \| 正式环境 \| identity-missing \|/);
  assert.match(report, /node scripts\/stable-smoke-run\.mjs/);
  assert.doesNotMatch(report, /curl /);
});

test('用例行通过但 Playwright 进程失败时主管结论仍是不通过', () => {
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
  assert.match(report, /Playwright 进程异常退出/);
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
