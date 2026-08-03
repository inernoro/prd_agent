import assert from 'node:assert/strict';
import test from 'node:test';
import {
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

test('计划要求但没有证据的用例必须标记 not-run', () => {
  const rows = reconcileCaseCoverage(['CORE-001', 'VIS-001'], [{
    caseId: 'CORE-001', environment: 'cds', title: 'ok', status: 'pass', durationMs: 1, error: '', retryCount: 0,
  }]);
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((row) => row.status === 'not-run').length, 3);
  assert.equal(summarizeCoverage(rows).verdict, 'conditional');
});

test('失败优先于未执行，重试通过仍是 conditional', () => {
  assert.equal(summarizeCoverage([{ status: 'fail', retryCount: 0 }]).verdict, 'fail');
  assert.equal(summarizeCoverage([{ status: 'pass', retryCount: 1 }]).verdict, 'conditional');
});

test('公开报告会隐藏地址和底层技术词', () => {
  const value = userReadableError('HTTP 500 Provider failed token at https://secret.example/a');
  assert.doesNotMatch(value, /HTTP|Provider|token|secret\.example/i);
});
