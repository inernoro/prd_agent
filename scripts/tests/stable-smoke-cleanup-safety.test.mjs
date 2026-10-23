import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readCleanupBlocker, writeCleanupBlocker, cleanupFailureFromAttachments, isCleanupReadOnlyJourney, readShortVideoCleanupCapability } from '../../e2e/utils/stableSmokeCleanupSafety.mjs';
import { collectPlaywrightCases } from '../stable-smoke-results.mjs';
import { runReportRiskRegression } from '../stable-smoke-run.mjs';
import * as safety from '../../e2e/utils/stableSmokeCleanupSafety.mjs';

const referenceController = readFileSync(new URL('../../prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs', import.meta.url), 'utf8');
const referenceContract = readFileSync(new URL('../../prd-api/src/PrdAgent.Core/Models/MultiImage/ImageReferenceContract.cs', import.meta.url), 'utf8');
const referenceSource = (controller = referenceController, contract = referenceContract) => (_revision, path) => path.endsWith('/ImageMasterController.cs') ? controller : contract;
const actualVisual = '1678c63d6eded9044275ae7e441b96d4ce5b1219';

test('REG-stsmk-cleanup-circuit-001 VISCOUNT 实际旧版本不能把数量负例送入计费生成', async () => {
  assert.equal(typeof safety.readImageReferenceRejectionCapability, 'function');
  const result = await safety.readImageReferenceRejectionCapability({ getVersion: async () => versionResponse({ actualCommit: actualVisual, expectedCommit: actualVisual }) });
  assert.equal(result.supported, false);
  assert.equal(result.deploymentCommit, actualVisual);
  assert.match(result.reason, /零创建.*未执行/);
});

test('REG-stsmk-cleanup-circuit-001 VISCOUNT 必须证明实际handler先拒绝及DTO与validator合同，改掉任一必红', async () => {
  assert.equal(typeof safety.readImageReferenceRejectionCapability, 'function');
  const check = (controller, contract) => safety.readImageReferenceRejectionCapability({ getVersion: async () => versionResponse(), readSource: referenceSource(controller, contract) });
  assert.equal((await check(referenceController, referenceContract)).supported, true);
  for (const [from, to] of [['ImageReferenceContract.ValidateDeclared(', 'ImageReferenceContract.Validate('],
    ['if (!referenceValidation.IsValid)', 'if (referenceValidation.IsValid)'],
    ['return BadRequest(ApiResponse<object>.Fail(\n                    referenceValidation.ErrorCode', 'return Ok(ApiResponse<object>.Fail(\n                    referenceValidation.ErrorCode'],
    ['public int? ExpectedImageRefCount { get; set; }', ''],
    ['public int? ExpectedImageRefCount { get; set; }', 'public int? ExpectedImageRefCount { get; set; } = 0;'],
    ['var referenceValidation =', 'await _db.ImageGenRuns.InsertOneAsync(run, cancellationToken: ct);\n            var referenceValidation ='],
    ['var referenceValidation =', 'await UpsertWorkspaceCanvasPlaceholderAsync();\n            var referenceValidation ='],
    ['var referenceValidation =', 'await queue.EnqueueAsync(run);\n            var referenceValidation =']]) {
    assert.ok(referenceController.includes(from), from);
    assert.equal((await check(referenceController.replace(from, to), referenceContract)).supported, false, from);
  }
  assert.equal((await check(referenceController.replace(/var submittedImageRefCount =[^]*?: string\.IsNullOrWhiteSpace\(initSha\) \? 0 : 1;/, 'var submittedImageRefCount = 1;'), referenceContract)).supported, false, '错误的收到数量计算不能放行');
  const begin = referenceController.indexOf('            var referenceValidation =');
  const end = referenceController.indexOf('            // 关键：', begin);
  const guard = referenceController.slice(begin, end);
  assert.ok(begin > 0 && end > begin);
  for (const replacement of [`/*${guard}*/`, `if (false) { ${guard} }`]) {
    assert.equal((await check(referenceController.slice(0, begin) + replacement + referenceController.slice(end), referenceContract)).supported, false, '注释或不可达嵌套声明不能充当安全证据');
  }
  for (const [from, to] of [['"IMAGE_REF_COUNT_REQUIRED"', '"OTHER_REQUIRED"'], ['"IMAGE_REF_INCOMPLETE"', '"OTHER_INCOMPLETE"'],
    ['new ImageReferenceValidation(false, RequiredCountCode', 'new ImageReferenceValidation(true, RequiredCountCode'],
    ['return effectiveExpected == submittedCount', 'return effectiveExpected != submittedCount']]) {
    assert.ok(referenceContract.includes(from));
    assert.equal((await check(referenceController, referenceContract.replace(from, to))).supported, false, from);
  }
});

test('REG-stsmk-cleanup-circuit-001 VISCOUNT 公共版本未知/HTTP失败/源码不可核或核对中漂移均failclosed', async () => {
  assert.equal(typeof safety.readImageReferenceRejectionCapability, 'function');
  let reads = 0;
  for (const value of [{ actualCommit: '' }, { actualCommit: 'not-a-commit' }, { expectedCommit: '2'.repeat(40) }, { commitMatch: 'mismatch' }]) {
    const result = await safety.readImageReferenceRejectionCapability({ getVersion: async () => versionResponse(value), readSource: () => { reads++;return ''; } });
    assert.equal(result.supported, false);
  }
  assert.equal(reads, 0);
  for (const getVersion of [async () => ({ ok: () => false }), async () => { throw Error('transport'); }]) {
    assert.equal((await safety.readImageReferenceRejectionCapability({ getVersion })).supported, false);
  }
  assert.equal((await safety.readImageReferenceRejectionCapability({ getVersion: async () => versionResponse(), readSource: () => { throw Error('source unavailable'); } })).supported, false);
  let versions = 0;
  const result = await safety.readImageReferenceRejectionCapability({ getVersion: async () => versionResponse(++versions === 1 ? {} : { actualCommit: '2'.repeat(40), expectedCommit: '2'.repeat(40) }), readSource: referenceSource() });
  assert.equal(versions, 2);assert.equal(result.supported, false);assert.match(result.reason, /漂移/);
});

test('REG-stsmk-cleanup-circuit-001 VISCOUNT 执行原VIS011前缀和真实准入函数，未证明能力时零登录零创建', async () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const begin = source.indexOf("  test('[VIS-011][REG-image-reference-count-001]");
  const body = source.slice(begin, source.indexOf('\n  test(', begin + 1));
  const callPrefix = body.slice(body.indexOf('=> {') + 4, body.indexOf('    try {'));
  let logins = 0, creates = 0, attached;
  const requireStart = source.indexOf('async function requireImageReferenceRejectionCapability(');
  assert.ok(requireStart >= 0);
  const requireText = source.slice(requireStart, source.indexOf('\nasync function requireShortVideoCleanupCapability(', requireStart)).replace(': APIRequestContext', '').replace(': TestInfo', '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const guard = new Function('readImageReferenceRejectionCapability', 'Buffer', 'test', `return (${requireText});`)(
    options => safety.readImageReferenceRejectionCapability({ ...options, readSource: () => '' }), Buffer,
    { skip: (blocked, reason) => { if (blocked) { assert.match(reason, /零创建/);throw Error('reference-safety-skip'); } } },
  );
  const runPrefix = new AsyncFunction('page', 'request', 'testInfo', 'requireImageReferenceRejectionCapability', 'loginAndReadToken', 'createVisualWorkspace', callPrefix);
  await assert.rejects(() => runPrefix({}, { get: async path => { assert.equal(path, '/api/version');return versionResponse(); } },
    { attach: async (name, value) => { attached = { name, data: JSON.parse(value.body) }; } }, guard,
    async () => { logins++;throw Error('unexpected-login'); }, async () => { creates++;return { workspace: {} }; }), /reference-safety-skip/);
  assert.equal(logins, 0);assert.equal(creates, 0);assert.equal(attached.name, 'image-reference-rejection-preflight');assert.equal(attached.data.supported, false);
  for (const predicate of ['expect(missing.status()).toBe(400)', 'expect(incomplete.status()).toBe(400)', "toBe('IMAGE_REF_COUNT_REQUIRED')", "toBe('IMAGE_REF_INCOMPLETE')", 'expect(missingBody.success).toBe(false)', 'expect(incompleteBody.success).toBe(false)']) assert.ok(body.includes(predicate), predicate);
});

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

const deployed = '1'.repeat(40);
const supportedController = '[Route("api/short-video-materials")]\n[HttpGet("runs/{runId}")]\n[HttpDelete("runs/{runId}")]\n[HttpPost("runs/{runId}/cancel")]';
const versionResponse = (overrides = {}) => ({ ok: () => true, json: async () => ({ actualCommit: deployed, expectedCommit: deployed, commitMatch: 'match', ...overrides }) });
test('REG-stsmk-cleanup-circuit-001 创建前须按实际部署源核取消删除回读，缺一项或未知均停跑', async () => {
  for (const missing of ['[HttpGet("runs/{runId}")]', '[HttpDelete("runs/{runId}")]', '[HttpPost("runs/{runId}/cancel")]']) {
    const result = await readShortVideoCleanupCapability({ getVersion: async () => versionResponse(), readControllerSource: revision => { assert.equal(revision, deployed);return supportedController.replace(missing, ''); } });
    assert.equal(result.supported, false);
    assert.match(result.reason, /零创建/);
  }
  assert.equal((await readShortVideoCleanupCapability({ getVersion: async () => versionResponse(), readControllerSource: () => { throw Error('exact source unavailable'); } })).supported, false);
  assert.equal((await readShortVideoCleanupCapability({ getVersion: async () => versionResponse(), readControllerSource: () => supportedController })).supported, true);
});
test('REG-stsmk-cleanup-circuit-001 漂移或非法部署不得查询猜测源码，健康与HTTP200不替代清理合同', async () => {
  let reads = 0;
  for (const value of [{ commitMatch: 'mismatch' }, { actualCommit: 'invalid' }, { expectedCommit: '2'.repeat(40) }]) {
    const result = await readShortVideoCleanupCapability({ getVersion: async () => versionResponse(value), readControllerSource: () => { reads++;return supportedController; } });
    assert.equal(result.supported, false);
  }
  assert.equal(reads, 0);
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
test('REG-stsmk-cleanup-circuit-001 原非法输入子判据每轮被真实消费且失败不被忽略', () => {
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--test', new URL('./stable-smoke-short-video-invalid.test.mjs', import.meta.url).pathname], {
    encoding: 'utf8', timeout: 30_000, env: childEnvironment,
  });
  assert.equal(child.status, 0, `${child.stdout || ''}\n${child.stderr || ''}`);
  assert.match(child.stdout || '', /^# tests [1-9]\d*$/m, '必须看到子判据真实执行数量，空跑exit0不能通过');
});
test('REG-stsmk-cleanup-circuit-001 原三条短视频旅程创建和登录前必须消费同一能力预检', async () => {
  const titles = ['[PARSE-001][PARSE-002][PARSE-005][PARSE-007][PARSE-008]', '[PARSE-001][PARSE-006][PARSE-007]', 'CDS 短视频非法API400与受控长文案机械子项（不计业务验收）'];
  for (const title of titles) {
    const start = spec.indexOf(`  test('${title}`);assert.ok(start >= 0);
    const body = spec.slice(start, spec.indexOf('\n  test(', start + 1));
    const guard = body.indexOf('await requireShortVideoCleanupCapability(request, testInfo);');
    assert.ok(guard > 0 && guard < body.indexOf('loginAndReadToken'));
    if (body.includes('browser.newContext')) assert.ok(guard < body.indexOf('browser.newContext'));
  }
  const start = spec.indexOf('async function requireShortVideoCleanupCapability(');
  const finish = spec.indexOf('\nconst recordingJourneyPlan', start);
  const source = spec.slice(start, finish).replace(': APIRequestContext', '').replace(': TestInfo', '');
  let attached, skipped = false;
  const fn = new Function('readShortVideoCleanupCapability', 'Buffer', 'test', `return (${source});`)(
    async ({ getVersion }) => { assert.equal(await getVersion(), 'readonly-version');return { supported: false, reason: '缺删除能力；零创建停跑' }; }, Buffer,
    { skip: (blocked, reason) => { skipped = blocked;assert.match(reason, /零创建/);throw Error('safety-skip'); } },
  );
  await assert.rejects(fn({ get: path => { assert.equal(path, '/api/version');return 'readonly-version'; } }, { attach: async (name, value) => { attached = { name, value: JSON.parse(value.body) }; } }), /safety-skip/);
  assert.equal(skipped, true);assert.equal(attached.name, 'short-video-cleanup-preflight');assert.equal(attached.value.supported, false);
});
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
  assert.equal(calls.length, 5);
  assert.ok(calls.some(call => call.name === 'node' && call.args.includes('REG-stsmk-cleanup-circuit-001') && call.args.includes('scripts/tests/stable-smoke-cleanup-safety.test.mjs')));
  assert.equal(result.rows[0].status, 'fail');
});
