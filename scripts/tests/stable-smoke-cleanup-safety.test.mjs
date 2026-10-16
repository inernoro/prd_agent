import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readCleanupBlocker, writeCleanupBlocker, cleanupFailureFromAttachments, isCleanupReadOnlyJourney } from '../../e2e/utils/stableSmokeCleanupSafety.mjs';
import { collectPlaywrightCases } from '../stable-smoke-results.mjs';
import { runReportRiskRegression } from '../stable-smoke-run.mjs';

const root = '/tmp/prd-agent-stable-smoke';
mkdirSync(root, { recursive: true });
const runId = 'stsmk-cleanup-circuit-fixture';
const ids = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
function fixture(t) {
  const outputDirectory = mkdtempSync(join(root, 'stsmk-unit-cleanup-'));
  t.after(() => rmSync(outputDirectory, { recursive: true }));
  return { outputDirectory, environment: 'production', sharedPath: join(outputDirectory, 'shared.json') };
}
function attachment(overrides = {}) {
  return { name: 'short-video-cleanup-receipt', body: Buffer.from(JSON.stringify({ inspectionRunId: runId, runId: ids[0], storeId: ids[1], uploadedEntryId: ids[2], runReadbackStatus: 200, storeReadbackStatus: 404, entryReadbackStatus: 404, errors: [], ...overrides })) };
}

test('REG-stsmk-cleanup-circuit-001 清理任务仍200或回读未知必须熔断，全部404才无新风险', () => {
  assert.deepEqual(cleanupFailureFromAttachments([attachment()], runId).resourceIds, ids);
  assert.ok(cleanupFailureFromAttachments([attachment({ runReadbackStatus: null })], runId));
  assert.ok(cleanupFailureFromAttachments([attachment({ runReadbackStatus: 404, errors: ['cleanup failed'] })], runId));
  assert.equal(cleanupFailureFromAttachments([attachment({ runReadbackStatus: 404 })], runId), undefined);
  assert.ok(cleanupFailureFromAttachments([attachment({ inspectionRunId: 'other-run' })], runId));
});

test('REG-stsmk-cleanup-circuit-001 本地熔断跨重试保留且读错状态不能放行', t => {
  const options = fixture(t);
  const failure = cleanupFailureFromAttachments([attachment()], runId);
  writeCleanupBlocker(options.outputDirectory, { environment: options.environment, inspectionRunId: runId, ...failure, sharedPath: options.sharedPath });
  assert.deepEqual(readCleanupBlocker(options).resourceIds, ids);
  writeFileSync(join(options.outputDirectory, 'cleanup-safety-circuit.json'), '{');
  assert.match(readCleanupBlocker(options).reason, /无法读取/);
});

test('REG-stsmk-cleanup-circuit-001 跨轮熔断不能借inactive或健康通过解除，只接受原资源全部404', t => {
  const options = fixture(t);
  const state = { schemaVersion: 1, active: true, environment: 'production', resourceIds: ids };
  writeFileSync(options.sharedPath, JSON.stringify(state));
  assert.ok(readCleanupBlocker(options));
  writeFileSync(options.sharedPath, JSON.stringify({ ...state, active: false, recovery: { status: 'healthy' } }));
  assert.ok(readCleanupBlocker(options));
  writeFileSync(options.sharedPath, JSON.stringify({ ...state, active: false, recovery: { status: 'verified', readbacks: ids.slice(1).map(resourceId => ({ resourceId, status: 404 })) } }));
  assert.ok(readCleanupBlocker(options));
  writeFileSync(options.sharedPath, JSON.stringify({ ...state, active: false, recovery: { status: 'verified', readbacks: ids.map(resourceId => ({ resourceId, status: 404 })) } }));
  assert.equal(readCleanupBlocker(options), undefined);
});

test('REG-stsmk-cleanup-circuit-001 仅显式只读旅程可继续，融合写入及未知标题不许借核心标签越过', () => {
  assert.equal(isCleanupReadOnlyJourney('[CORE-002][CORE-003] 登录会话'), true);
  assert.equal(isCleanupReadOnlyJourney('[CORE-003][REG-auth-identity-permissions-001] 权限'), true);
  assert.equal(isCleanupReadOnlyJourney('[CORE-001][PARSE-001] 融合写入'), false);
  assert.equal(isCleanupReadOnlyJourney('[REC-003] 上传'), false);
  assert.equal(isCleanupReadOnlyJourney('未知旅程'), false);
});

const spec = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
function sourceHook(begin, end, bindings) {
  const start = spec.indexOf(begin);
  assert.ok(start >= 0);
  const finish = spec.indexOf(end, start);
  assert.ok(finish > start);
  const call = spec.slice(start, finish).trim();
  const callback = call.slice(call.indexOf('(') + 1, -2);
  return new Function(...Object.keys(bindings), `return (${callback});`)(...Object.values(bindings));
}

test('REG-stsmk-cleanup-circuit-001 执行原beforeEach：清理失败在探针和鉴权之前阻断下一次业务', async t => {
  const options = fixture(t);
  writeCleanupBlocker(options.outputDirectory, { environment: 'production', inspectionRunId: runId, resourceIds: ids, reason: '原资源仍200', sharedPath: options.sharedPath });
  let probes = 0;
  const before = sourceHook('  test.beforeEach(async ({ request }, testInfo) => {', '\n\n  test.afterEach', {
    process: { env: { STABLE_SMOKE_RUN: '1' } },
    requiredEnv: name => ({ STABLE_SMOKE_TEST_OUTPUT: options.outputDirectory, STABLE_SMOKE_ENVIRONMENT: options.environment })[name],
    readCleanupBlocker: value => readCleanupBlocker({ ...value, sharedPath: options.sharedPath }), isCleanupReadOnlyJourney,
    test: { skip: (enabled, reason) => { if (enabled) throw Error(`safety-skipped:${reason}`); } },
    readStableSmokeInfrastructureCircuit: () => { probes += 1; return undefined; },
    writeStableSmokeInfrastructureCircuit: () => { throw Error('health must not clear cleanup'); },
    probeStableSmokeReadiness: () => { throw Error('no network'); }, clearStableSmokeInfrastructureCircuit: () => { throw Error('no health reset'); },
  });
  await assert.rejects(before({ request: {} }, { title: '[PARSE-001] 新业务' }), /safety-skipped/);
  assert.equal(probes, 0);
  await before({ request: {} }, { title: '[CORE-001] 只读' });
  assert.equal(probes, 1);
});

test('REG-stsmk-cleanup-circuit-001 执行原afterEach：真实清理失败附件向下一worker传播', async t => {
  const options = fixture(t);
  const after = sourceHook('  test.afterEach(async ({ request }, testInfo) => {', '\n\n  test.beforeEach(async ({ context })', {
    process: { env: { STABLE_SMOKE_RUN: '1' } },
    requiredEnv: name => ({ STABLE_SMOKE_TEST_OUTPUT: options.outputDirectory, STABLE_SMOKE_ENVIRONMENT: options.environment, STABLE_SMOKE_RUN_ID: runId })[name],
    cleanupFailureFromAttachments, writeCleanupBlocker: (directory, circuit) => writeCleanupBlocker(directory, { ...circuit, sharedPath: options.sharedPath }),
    stableSmokeDiagnosticIndicatesInfrastructureTimeout: () => false, sanitizeStableSmokeTestInfo: () => {},
    probeStableSmokeReadiness: () => { throw Error('no health probe'); }, writeStableSmokeInfrastructureCircuit: () => {},
  });
  await after({ request: {} }, { attachments: [attachment()], errors: [] });
  assert.deepEqual(readCleanupBlocker(options).resourceIds, ids);
});

test('REG-stsmk-cleanup-circuit-001 新失败必须跨轮持久阻断且后续记录不能覆盖原未清理ID', t => {
  const options = fixture(t);
  writeCleanupBlocker(options.outputDirectory, { environment: 'production', inspectionRunId: runId, resourceIds: ids, reason: '原资源仍200', sharedPath: options.sharedPath });
  const next = fixture(t), extra = 'd'.repeat(32);
  assert.deepEqual(readCleanupBlocker({ ...next, sharedPath: options.sharedPath }).resourceIds, ids);
  writeCleanupBlocker(next.outputDirectory, { environment: 'production', inspectionRunId: 'next-run', resourceIds: [extra], reason: '另一条未清理', sharedPath: options.sharedPath });
  assert.deepEqual(readCleanupBlocker({ ...fixture(t), sharedPath: options.sharedPath }).resourceIds, [...ids, extra]);
  const state = JSON.parse(readFileSync(options.sharedPath, 'utf8'));
  assert.deepEqual(state.sourceRunIds, [runId, 'next-run']);
  assert.equal(state.active, true);
});

test('REG-stsmk-cleanup-circuit-001 共享保护写入失败仍必须执行原脱敏，不借健康探针恢复', async t => {
  const options = fixture(t);
  let sanitized = false;
  const after = sourceHook('  test.afterEach(async ({ request }, testInfo) => {', '\n\n  test.beforeEach(async ({ context })', {
    process: { env: { STABLE_SMOKE_RUN: '1' } },
    requiredEnv: name => ({ STABLE_SMOKE_TEST_OUTPUT: options.outputDirectory, STABLE_SMOKE_ENVIRONMENT: options.environment, STABLE_SMOKE_RUN_ID: runId })[name],
    cleanupFailureFromAttachments, writeCleanupBlocker: () => { throw Error('共享状态不能覆盖'); },
    stableSmokeDiagnosticIndicatesInfrastructureTimeout: () => false,
    sanitizeStableSmokeTestInfo: () => { sanitized = true; },
    probeStableSmokeReadiness: () => { throw Error('no health probe'); }, writeStableSmokeInfrastructureCircuit: () => {},
  });
  await assert.rejects(after({ request: {} }, { attachments: [attachment()], errors: [] }), /共享状态不能覆盖/);
  assert.equal(sanitized, true);
});

test('REG-stsmk-cleanup-circuit-001 损坏或跨环境共享熔断不得被新失败覆盖，当轮仍阻断', t => {
  const options = fixture(t);
  for (const original of ['{', JSON.stringify({ schemaVersion: 1, active: true, environment: 'cds', resourceIds: ids })]) {
    writeFileSync(options.sharedPath, original);
    assert.throws(() => writeCleanupBlocker(options.outputDirectory, { environment: 'production', inspectionRunId: runId, resourceIds: ids, reason: '原资源仍200', sharedPath: options.sharedPath }));
    assert.equal(readFileSync(options.sharedPath, 'utf8'), original);
    assert.deepEqual(readCleanupBlocker(options).resourceIds, ids);
  }
});

test('REG-stsmk-cleanup-circuit-001 collector不得用熔断skip抹去首败；全skip仍未执行、重试成功仍保留flaky来源', () => {
  const collect = results => collectPlaywrightCases({ suites: [{ specs: [{ title: '[PARSE-008] 清理', tests: [{ results }] }] }] }, 'production')[0];
  const row = collect([{ status: 'failed', error: { message: 'run仍200' } }, { status: 'skipped', annotations: [{ type: 'skip', description: 'cleanup fuse' }] }]);
  assert.equal(row.status, 'fail');assert.equal(row.error, 'run仍200');assert.equal(row.hadFailedAttempt, true);
  assert.equal(collect([{ status: 'skipped' }]).status, 'not-run');
  const recovered = collect([{ status: 'failed' }, { status: 'passed' }]);
  assert.equal(recovered.status, 'pass');assert.equal(recovered.hadFailedAttempt, true);
});

test('REG-stsmk-cleanup-circuit-001 例行父项必须实际消费本子判据并传播唯一失败', t => {
  const options = fixture(t);
  const calls = [];
  const result = runReportRiskRegression(options.outputDirectory, (name, args) => {
    calls.push({ name, args });
    return { status: args.includes('REG-stsmk-cleanup-circuit-001') ? 1 : 0, stdout: '有限机械回归', stderr: '' };
  });
  assert.equal(calls.length, 4);
  assert.ok(calls.some(call => call.name === 'node' && call.args.includes('REG-stsmk-cleanup-circuit-001') && call.args.includes('scripts/tests/stable-smoke-cleanup-safety.test.mjs')));
  assert.equal(result.rows[0].status, 'fail');
});
