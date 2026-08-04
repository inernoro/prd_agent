import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTestMatrix, renderSupervisorReport } from '../stable-smoke-supervisor-report.mjs';

const matrix = `
| caseId | 场景 | 核心断言 | CDS | 正式 |
|---|---|---|---|---|
| CORE-001 | 首页 | 首页能打开 | 必跑 | 必跑 |
| VIS-003 | 单图参考 | 参考图进入请求 | 必跑 | 最小图片档 |
`;

const plan = {
  featureLines: [
    { id: 'identity-access', label: '身份与访问', breadcrumb: ['登录', '会话', '首页'], requiredCaseIds: ['CORE-001'], regressionCaseIds: [] },
    { id: 'visual-creation', label: '视觉创作', breadcrumb: ['首页', '视觉创作', '参考图', '结果'], requiredCaseIds: ['VIS-003'], regressionCaseIds: [] },
  ],
};

test('测试矩阵解析场景、断言和双环境策略', () => {
  const parsed = parseTestMatrix(matrix);
  assert.equal(parsed.get('VIS-003')?.scenario, '单图参考');
  assert.equal(parsed.get('VIS-003')?.productionPolicy, '最小图片档');
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
      { caseId: 'CORE-001', environment: 'production', reason: '正式身份未就绪' },
      { caseId: 'VIS-003', environment: 'production', reason: '正式身份未就绪' },
    ],
  });
  assert.match(report, /主管结论：不通过/);
  assert.match(report, /## 未通过与未执行逐项清单/);
  assert.match(report, /首页 → 视觉创作 → 参考图 → 结果 → 单图参考/);
  assert.match(report, /单图参考 \| 功能/);
  assert.match(report, /正式合成身份未就绪/);
  assert.match(report, /正式环境 \| 全部计划模块 \| 2 项/);
  assert.equal((report.match(/正式合成身份未就绪/g) || []).length, 1);
  assert.match(report, /## 逐项验收账本/);
  assert.match(report, /#method-vis-003/);
  assert.doesNotMatch(report, /\| VIS-003 \|/);
  assert.doesNotMatch(report, /node scripts|e2e\/|curl /);
});
