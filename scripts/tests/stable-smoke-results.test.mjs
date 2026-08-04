import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNotRunLedger,
  collectPlaywrightCases,
  reconcileCaseCoverage,
  summarizeCoverage,
  userReadableError,
} from '../stable-smoke-results.mjs';

test('从 Playwright 报告提取 caseId 和最终结果', () => {
  const report = {
    suites: [{
      specs: [{
        title: '[CORE-001] 首页可用',
        tests: [{ results: [{ status: 'failed', duration: 10 }, { status: 'passed', duration: 20 }] }],
      }],
    }],
  };
  assert.deepEqual(collectPlaywrightCases(report, 'cds'), [{
    caseId: 'CORE-001',
    environment: 'cds',
    title: '[CORE-001] 首页可用',
    status: 'pass',
    durationMs: 30,
    error: '',
    retryCount: 1,
  }]);
});

test('同一条真实旅程可为多个相关 caseId 提供共同证据', () => {
  const report = {
    suites: [{
      specs: [{
        title: '[VIS-002][VIS-005][VIS-007] 文生图产物与进度',
        tests: [{ results: [{ status: 'passed', duration: 30 }] }],
      }],
    }],
  };
  assert.deepEqual(
    collectPlaywrightCases(report, 'cds').map((row) => row.caseId),
    ['VIS-002', 'VIS-005', 'VIS-007'],
  );
});

test('带模块名称的永久回归 caseId 能从组合旅程提取', () => {
  const report = {
    suites: [{
      specs: [{
        title: '[MVIS-001][REG-multi-image-001][REG-user-error-001] 多图永久回归',
        tests: [{ results: [{ status: 'passed', duration: 30 }] }],
      }],
    }],
  };
  assert.deepEqual(
    collectPlaywrightCases(report, 'cds').map((row) => row.caseId),
    ['MVIS-001', 'REG-MULTI-IMAGE-001', 'REG-USER-ERROR-001'],
  );
});

test('永久回归台账的大小写不影响执行证据对账', () => {
  const rows = reconcileCaseCoverage(['REG-user-error-001'], [{
    caseId: 'REG-USER-ERROR-001',
    environment: 'cds',
    title: '用户错误回归',
    status: 'pass',
    durationMs: 10,
    error: '',
    retryCount: 0,
  }]);
  assert.equal(rows[0].caseId, 'REG-user-error-001');
  assert.equal(rows[0].status, 'pass');
});

test('计划要求但没有证据的用例必须标记 not-run', () => {
  const rows = reconcileCaseCoverage(['CORE-001', 'VIS-001'], [{
    caseId: 'CORE-001', environment: 'cds', title: 'ok', status: 'pass', durationMs: 1, error: '', retryCount: 0,
  }]);
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((row) => row.status === 'not-run').length, 3);
  assert.equal(summarizeCoverage(rows).verdict, 'conditional');
});

test('未执行账本区分自动化缺口与正式环境身份阻塞', () => {
  const ledger = buildNotRunLedger([
    { caseId: 'REC-001', environment: 'cds', status: 'not-run' },
    { caseId: 'CORE-001', environment: 'production', status: 'not-run' },
    { caseId: 'CORE-002', environment: 'cds', status: 'pass' },
  ], { cds: true, production: false });
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].reasonCode, 'automation-case-missing');
  assert.match(ledger[0].command, /stable-smoke\.spec\.ts/);
  assert.match(ledger[0].command, /--cds-only/);
  assert.equal(ledger[1].reasonCode, 'environment-report-missing');
  assert.match(ledger[1].reason, /正式环境专用合成身份/);
  assert.match(ledger[1].command, /--production-only/);
});

test('正式环境已有报告但缺步骤时给正式环境补跑命令', () => {
  const ledger = buildNotRunLedger([
    { caseId: 'VIDEO-001', environment: 'production', status: 'not-run' },
  ], { cds: true, production: true });
  assert.equal(ledger[0].reasonCode, 'automation-case-missing');
  assert.match(ledger[0].command, /--production-only/);
  assert.doesNotMatch(ledger[0].command, /--cds-only/);
});

test('失败优先于未执行，重试通过仍是 conditional', () => {
  assert.equal(summarizeCoverage([{ status: 'fail', retryCount: 0 }]).verdict, 'fail');
  assert.equal(summarizeCoverage([{ status: 'pass', retryCount: 1 }]).verdict, 'conditional');
});

test('公开报告会隐藏地址和底层技术词', () => {
  const value = userReadableError('HTTP 500 Provider failed token at https://secret.example/a');
  assert.doesNotMatch(value, /HTTP|Provider|token|secret\.example/i);
});
