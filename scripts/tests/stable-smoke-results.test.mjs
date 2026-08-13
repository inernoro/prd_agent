import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildNotRunLedger,
  collectPlaywrightCases,
  environmentResultLabel,
  reconcileCaseCoverage,
  selectRequiredCaseIds,
  summarizeCoverage,
  userReadableError,
} from '../stable-smoke-results.mjs';

test('从 Playwright 报告提取 caseId 和最终结果', () => {
  const report = {
    suites: [{
      specs: [{
        title: '[CORE-001] 首页可用',
        tags: ['cleanup'],
        tests: [{ results: [{ status: 'failed', duration: 10 }, { status: 'passed', duration: 20 }] }],
      }],
    }],
  };
  assert.deepEqual(collectPlaywrightCases(report, 'cds'), [{
    caseId: 'CORE-001',
    environment: 'cds',
    title: '[CORE-001] 首页可用',
    tags: ['cleanup'],
    status: 'pass',
    durationMs: 30,
    error: '',
    retryCount: 1,
    hadFailedAttempt: true,
    attemptErrors: [],
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

test('双环境不同必跑集合不会被重新做笛卡尔积', () => {
  const rows = reconcileCaseCoverage({
    cds: ['REC-006'],
    production: ['CORE-001'],
  }, [
    { caseId: 'REC-006', environment: 'cds', status: 'pass' },
    { caseId: 'CORE-001', environment: 'production', status: 'pass' },
  ], ['cds', 'production']);

  assert.deepEqual(rows.map((row) => `${row.environment}:${row.caseId}`), [
    'cds:REC-006',
    'production:CORE-001',
  ]);
  assert.ok(rows.every((row) => row.status === 'pass'));
});

test('同一 caseId 多条证据保留最严格结果和全部失败诊断', () => {
  const rows = reconcileCaseCoverage(['CORE-005'], [
    {
      caseId: 'CORE-005', environment: 'cds', title: '首页告警', status: 'fail',
      durationMs: 10, error: '首页显示内部错误', retryCount: 0,
    },
    {
      caseId: 'CORE-005', environment: 'cds', title: '无效生图', status: 'pass',
      durationMs: 20, error: '', retryCount: 0,
    },
  ], ['cds']);

  assert.equal(rows[0].status, 'fail');
  assert.match(rows[0].title, /首页告警/);
  assert.match(rows[0].title, /无效生图/);
  assert.match(rows[0].error, /首页显示内部错误/);
  assert.deepEqual(rows[0].attemptErrors, ['首页显示内部错误']);
  assert.equal(rows[0].durationMs, 30);
});

test('单环境复测只对账运行器实际选择的环境', () => {
  const cdsRows = reconcileCaseCoverage(['CORE-001'], [{
    caseId: 'CORE-001', environment: 'cds', title: 'ok', status: 'pass', durationMs: 1, error: '', retryCount: 0,
  }], ['cds']);
  const productionRows = reconcileCaseCoverage(['CORE-001'], [{
    caseId: 'CORE-001', environment: 'production', title: 'ok', status: 'pass', durationMs: 1, error: '', retryCount: 0,
  }], ['production']);

  assert.deepEqual(cdsRows.map((row) => row.environment), ['cds']);
  assert.deepEqual(productionRows.map((row) => row.environment), ['production']);
  assert.equal(summarizeCoverage(cdsRows).verdict, 'pass');
  assert.equal(summarizeCoverage(productionRows).verdict, 'pass');
});

test('grep 单用例复测只对账表达式中选择的 caseId', () => {
  const required = ['CORE-001', 'REC-003', 'REG-user-error-001'];

  expectCaseIds(selectRequiredCaseIds(required, '\\[REC-003\\]'), ['REC-003']);
  expectCaseIds(
    selectRequiredCaseIds(required, '\\[REC-003\\]|\\[REG-user-error-001\\]'),
    ['REC-003', 'REG-user-error-001'],
  );
  expectCaseIds(selectRequiredCaseIds(required, '头像生成', [
    { caseId: 'REC-003' },
    { caseId: 'REG-USER-ERROR-001' },
  ]), ['REC-003', 'REG-user-error-001']);
  expectCaseIds(selectRequiredCaseIds(required, '不存在的标题', []), []);
});

test('单环境复测不会把未选择环境标记为通过', () => {
  const passedRows = [{ caseId: 'CORE-001', environment: 'cds', status: 'pass' }];

  assert.equal(environmentResultLabel(passedRows, true), 'pass');
  assert.equal(environmentResultLabel([], false), 'not-selected');
  assert.equal(environmentResultLabel([], true), 'conditional');
});

test('单环境技术报告明确展示另一环境未选择', () => {
  const runDirectory = mkdtempSync(join(tmpdir(), 'stable-smoke-report-'));
  try {
    const planPath = join(runDirectory, 'plan.json');
    const cdsResultPath = join(runDirectory, 'cds.json');
    const reportPath = join(runDirectory, 'report.md');
    const supervisorPath = join(runDirectory, 'supervisor.md');
    writeFileSync(planPath, JSON.stringify({
      verdict: 'pass',
      requiredCaseIds: ['CORE-001'],
      featureLines: [],
    }));
    writeFileSync(cdsResultPath, JSON.stringify({
      suites: [{
        specs: [{
          title: '[CORE-001] 首页可用',
          tests: [{ results: [{ status: 'passed', duration: 10 }] }],
        }],
      }],
    }));

    const result = spawnSync(process.execPath, [
      'scripts/render-stable-smoke-report.mjs',
      '--plan', planPath,
      '--cds-input', cdsResultPath,
      '--production-input', join(runDirectory, 'production-missing.json'),
      '--output', reportPath,
      '--supervisor-output', supervisorPath,
      '--environments', 'cds',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /\| CORE \| pass \| not-selected \|/);
    assert.match(report, /\| 正式环境 \| 0 \| 0 \| 0 \| 0 \| 0 \| 未选择 \| 本轮未选择 \|/);
    assert.doesNotMatch(report, /\| CORE \| pass \| pass \|/);
    const supervisor = readFileSync(supervisorPath, 'utf8');
    assert.match(supervisor, /\| 未映射功能线 \| 关键业务 \| 通过（1 通过，0 失败，0 未执行） \| 未选择 \|/);
    assert.doesNotMatch(supervisor, /正式环境.*通过（0 通过，0 失败，0 未执行）/);
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

function expectCaseIds(actual, expected) {
  assert.deepEqual(actual, expected);
}

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
  assert.match(ledger[1].command, /配齐双环境凭据/);
  assert.match(ledger[1].command, /同轮 CDS 验证/);
  assert.doesNotMatch(ledger[1].command, /--production-only/);
});

test('正式环境已有报告但缺步骤时给正式环境补跑命令', () => {
  const ledger = buildNotRunLedger([
    { caseId: 'VIDEO-001', environment: 'production', status: 'not-run' },
  ], { cds: true, production: true });
  assert.equal(ledger[0].reasonCode, 'automation-case-missing');
  assert.match(ledger[0].command, /stable-smoke-run\.mjs --grep/);
  assert.doesNotMatch(ledger[0].command, /--production-only/);
  assert.doesNotMatch(ledger[0].command, /--cds-only/);
});

test('CDS 失败触发安全门槛时正式环境未执行项不得误报为自动化缺口', () => {
  const ledger = buildNotRunLedger([
    { caseId: 'VIDEO-001', environment: 'production', status: 'not-run' },
  ], { cds: true, production: true, productionRestricted: true });
  assert.equal(ledger[0].reasonCode, 'production-safety-restricted');
  assert.match(ledger[0].reason, /安全门槛/);
  assert.match(ledger[0].command, /先修复 CDS 失败项/);
  assert.match(ledger[0].closeCondition, /CDS 失败项关闭/);
  assert.doesNotMatch(ledger[0].command, /实现 \[VIDEO-001\]/);
});

test('失败优先于未执行，重试通过仍是 conditional', () => {
  assert.equal(summarizeCoverage([{ status: 'fail', retryCount: 0 }]).verdict, 'fail');
  assert.equal(summarizeCoverage([{ status: 'pass', retryCount: 1 }]).verdict, 'conditional');
});

test('公开报告会隐藏地址和底层技术词', () => {
  const value = userReadableError('HTTP 500 Provider failed token at https://secret.example/a');
  assert.doesNotMatch(value, /HTTP|Provider|token|secret\.example/i);
});
