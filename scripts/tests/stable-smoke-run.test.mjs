import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  acquireLock,
  applyCredentialRegistry,
  buildExecutionRecord,
  buildEnvironmentGrep,
  buildDryRunSummary,
  buildAffectedNotificationTargets,
  buildStableSmokeArchiveCommand,
  buildLockedRunSummary,
  buildUnhandledFailureSummary,
  canReuseVisualPlan,
  clearVisualGateOutputs,
  deliverLockedRun,
  deliverUnhandledFailure,
  deployedRuntimeCommit,
  enforceExecutionVerdict,
  evaluateCdsReadiness,
  evaluateProductionSafetyGate,
  initializeProductionSafetyGate,
  extractArchivedReportUrl,
  foldVisualGateVerdict,
  isValidationOnlyPath,
  isHttpsReportUrl,
  parseEnvFile,
  parseRunnerArgs,
  removeStaleLockIfSafe,
  runnerHelpText,
  resolveRuntimeExpectation,
  resolveServiceRuntimeCommits,
  resolveCdsPreviewUrls,
  requireAuthoritativeCdsAddress,
  buildReportVerificationArgs,
  selectCoverageCaseIds,
  selectCoverageCaseIdsByEnvironment,
  validateEnvironmentConfig,
  validateEnvironmentIdentities,
  validateProductionReadOnlyConfig,
  validateSelectedEnvironmentConfig,
  visualGateExecutionMatchesResult,
} from '../stable-smoke-run.mjs';

test('运行器帮助和预检参数不会误启动正式测试', () => {
  const parsed = parseRunnerArgs(['--preflight', '--cds-only', '--grep', '\\[REC-003\\]']);
  assert.equal(parsed.has('--preflight'), true);
  assert.equal(parsed.has('--cds-only'), true);
  assert.equal(parsed.read('--grep'), '\\[REC-003\\]');
  assert.match(runnerHelpText, /只检查双环境地址、身份和 CDS 部署状态，不启动测试/);
});

test('运行器拒绝未知参数、缺值和冲突环境', () => {
  assert.throws(() => parseRunnerArgs(['--unknown']), /不支持的参数/);
  assert.throws(() => parseRunnerArgs(['--grep']), /必须提供值/);
  assert.throws(() => parseRunnerArgs(['--cds-only', '--production-only']), /不能同时使用/);
});

test('dry-run 只产出计划摘要且不宣称功能或视觉验收通过', () => {
  const productionSafetyGate = initializeProductionSafetyGate(['cds', 'production']);
  const summary = buildDryRunSummary({
    runId: 'dry-run-test',
    plan: {
      catalogVersion: '2026.08',
      commit: 'a'.repeat(40),
      requiredCaseIds: ['CORE-001', 'VISUAL-001'],
      requiredCaseIdsByEnvironment: {
        cds: ['CORE-001'],
        production: ['VISUAL-001'],
      },
    },
    selected: ['cds', 'production'],
    envFileLoaded: true,
    productionSafetyGate,
  });

  assert.equal(summary.verdict, 'dry-run');
  assert.equal(summary.coverage.verdict, 'not-run');
  assert.equal(summary.coverage.notRun, 2);
  assert.deepEqual(summary.executions.map((item) => item.status), ['dry-run', 'dry-run']);
  assert.equal(summary.archive.status, 'skipped-dry-run');
  assert.equal(summary.notification.status, 'skipped');
});

test('双环境执行范围按各自矩阵取交集且正式环境不能点名越权用例', () => {
  const plan = {
    requiredCaseIds: ['CORE-001', 'REC-006', 'VIDEO-004'],
    requiredCaseIdsByEnvironment: {
      cds: ['CORE-001', 'REC-006', 'VIDEO-004'],
      production: ['CORE-001', 'VIDEO-004'],
    },
  };
  assert.equal(
    buildEnvironmentGrep(plan.requiredCaseIdsByEnvironment.production),
    '\\[CORE-001\\]|\\[VIDEO-004\\]',
  );
  assert.equal(
    buildEnvironmentGrep(plan.requiredCaseIdsByEnvironment.production, '\\[REC-006\\]'),
    '(?!)',
  );
  assert.equal(
    buildEnvironmentGrep(['REG-user-error-001'], '\\[reg-user-error-001\\]'),
    '\\[REG-user-error-001\\]',
  );
  assert.deepEqual(
    selectCoverageCaseIdsByEnvironment(
      plan,
      '',
      ['cds', 'production'],
      { restricted: false, grep: '' },
    ),
    {
      cds: ['CORE-001', 'REC-006', 'VIDEO-004'],
      production: ['CORE-001', 'VIDEO-004'],
    },
  );
});

test('失败、未执行和重试用例逐项形成带用例与追踪号的通知目标', () => {
  const targets = buildAffectedNotificationTargets({
    runId: 'stsmk-notify',
    verdict: 'fail',
    plan: {
      featureLines: [{
        label: '多图视觉创作',
        requiredCaseIds: ['MVIS-001', 'MVIS-002'],
      }],
    },
    rows: [
      {
        caseId: 'MVIS-001',
        environment: 'cds',
        title: '[MVIS-001] 双参考图生成',
        status: 'fail',
        retryCount: 0,
        error: '调用失败 requestId=req-mvis-001',
        attemptErrors: [],
      },
      {
        caseId: 'MVIS-002',
        environment: 'production',
        title: '[MVIS-002] 多图排序',
        status: 'not-run',
        retryCount: 0,
        error: '',
        attemptErrors: [],
      },
      {
        caseId: 'CORE-001',
        environment: 'cds',
        title: '[CORE-001] 首页可用',
        status: 'pass',
        retryCount: 0,
        error: '',
        attemptErrors: [],
      },
    ],
  });

  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((item) => item.caseId), ['MVIS-001', 'MVIS-002']);
  assert.equal(targets[0].module, '多图视觉创作');
  assert.equal(targets[0].requestId, 'req-mvis-001');
  assert.equal(targets[1].requestId, 'stsmk-notify:production:MVIS-002');
});

test('只有视觉门禁不通过时仍生成可追踪的视觉通知目标', () => {
  const targets = buildAffectedNotificationTargets({
    runId: 'stsmk-visual',
    verdict: 'conditional',
    plan: {},
    rows: [],
    visualResult: { verdict: '缺少证据' },
  });

  assert.deepEqual(targets, [{
    environment: '双环境',
    module: '视觉验收',
    caseId: 'VISUAL-GATE',
    requestId: 'stsmk-visual:visual-gate',
    recovery: '补齐视觉证据并重新执行视觉门禁，再按相同 runId 核对归档报告。',
  }]);
});

test('同一运行和提交可以复用既有视觉计划继续补证', () => {
  const plan = {
    schemaVersion: '3.0',
    runId: 'stsmk-current',
    commit: 'a'.repeat(40),
    captureStartedAt: '2026-08-11T14:00:00.000Z',
    environments: ['cds', 'production'],
    scope: 'full',
    slots: [{ slotId: 'CDS-VISUAL-IDENTITY-01' }],
  };
  const identity = { runId: 'stsmk-current', commit: 'a'.repeat(40), environments: ['cds', 'production'], scope: 'full' };
  assert.equal(canReuseVisualPlan(plan, identity), true);
  assert.equal(canReuseVisualPlan({ ...plan, runId: 'stsmk-old' }, identity), false);
  assert.equal(canReuseVisualPlan({ ...plan, commit: 'b'.repeat(40) }, identity), false);
  assert.equal(canReuseVisualPlan({ ...plan, environments: ['cds'] }, identity), false);
  assert.equal(canReuseVisualPlan({ ...plan, scope: 'production-read-only', slots: [] }, identity), false);
  assert.equal(canReuseVisualPlan({
    ...plan,
    environments: ['production'],
    scope: 'production-read-only',
    slots: [],
  }, {
    ...identity,
    environments: ['production'],
    scope: 'production-read-only',
  }), true);
});

test('执行结果使用审核人可读状态且不被进程退出码覆盖', () => {
  assert.deepEqual(buildExecutionRecord('cds', {
    status: 1,
    resultPath: '/tmp/results.json',
    htmlPath: '/tmp/report',
  }), {
    status: 'failed',
    resultPath: '/tmp/results.json',
    htmlPath: '/tmp/report',
    environment: 'cds',
    missing: [],
  });
  assert.equal(buildExecutionRecord('production', { status: 0 }).status, 'executed');
});

test('Playwright 进程失败必须覆盖用例行通过结论', () => {
  const summary = enforceExecutionVerdict(
    { verdict: 'pass', passed: 12, failed: 0 },
    [
      { environment: 'cds', status: 'executed' },
      { environment: 'production', status: 'failed' },
    ],
  );

  assert.deepEqual(summary, {
    verdict: 'fail',
    passed: 12,
    failed: 0,
    executionFailures: ['production'],
  });
});

test('CDS 失败后正式环境只能执行只读健康检查', () => {
  const processGate = evaluateProductionSafetyGate({ status: 'failed' }, []);
  assert.equal(processGate.restricted, true);
  assert.equal(processGate.mode, 'read-only');
  assert.equal(processGate.grep, '\\[CORE-001\\]');

  const cleanupGate = evaluateProductionSafetyGate({ status: 'executed' }, [{
    caseId: 'FILE-001',
    status: 'fail',
    title: '文件处理',
    error: 'cleanup 清理失败',
  }]);
  assert.equal(cleanupGate.restricted, true);
  assert.match(cleanupGate.reasons.join('；'), /FILE-001/);

  const flakyCleanupGate = evaluateProductionSafetyGate({ status: 'executed' }, [{
    caseId: 'FILE-002',
    status: 'pass',
    title: '上传后 cleanup 清理测试数据',
    tags: ['cleanup'],
    error: '',
    retryCount: 1,
    hadFailedAttempt: true,
    attemptErrors: ['清理失败'],
  }]);
  assert.equal(flakyCleanupGate.restricted, true);
  assert.match(flakyCleanupGate.reasons.join('；'), /重试后通过/);

  const chineseCleanupGate = evaluateProductionSafetyGate({ status: 'executed' }, [{
    caseId: 'COMMON-001',
    status: 'pass',
    title: '专用前缀资源可创建、回读并清理',
    tags: ['cleanup'],
    error: '',
    retryCount: 1,
    hadFailedAttempt: true,
    attemptErrors: ['Expected 500 to be 204'],
  }]);
  assert.equal(chineseCleanupGate.restricted, true);
  assert.match(chineseCleanupGate.reasons.join('；'), /COMMON-001/);

  const metadataOnlyCleanupGate = evaluateProductionSafetyGate({ status: 'executed' }, [{
    caseId: 'FILE-003',
    status: 'pass',
    title: '大文件上传期间持续显示文件名和百分比',
    tags: ['cleanup'],
    retryCount: 1,
    hadFailedAttempt: true,
    attemptErrors: ['Expected 500 to be 204'],
  }]);
  assert.equal(metadataOnlyCleanupGate.restricted, true);
  assert.match(metadataOnlyCleanupGate.reasons.join('；'), /FILE-003/);

  assert.equal(evaluateProductionSafetyGate({ status: 'executed' }, [{ status: 'pass' }]).restricted, false);
  const incompleteCoverageGate = evaluateProductionSafetyGate(
    { status: 'executed' },
    [{ caseId: 'CORE-001', status: 'pass' }],
    false,
    ['CORE-001', 'REC-003'],
  );
  assert.equal(incompleteCoverageGate.restricted, true);
  assert.match(incompleteCoverageGate.reasons.join('；'), /REC-003/);
  assert.equal(evaluateProductionSafetyGate(
    { status: 'executed' },
    [{ caseId: 'CORE-001', status: 'pass' }, { caseId: 'REC-003', status: 'pass' }],
    false,
    ['CORE-001', 'REC-003'],
  ).restricted, false);
  assert.equal(evaluateProductionSafetyGate(
    { status: 'executed' },
    [{ caseId: 'CORE-001', status: 'fail' }],
    false,
    ['CORE-001'],
  ).restricted, true);
  const filteredGate = evaluateProductionSafetyGate(
    { status: 'executed' },
    [{ caseId: 'IMG-001', status: 'pass' }],
    true,
  );
  assert.equal(filteredGate.restricted, true);
  assert.equal(filteredGate.mode, 'read-only');
  assert.equal(filteredGate.grep, '\\[CORE-001\\]');
  assert.match(filteredGate.reasons.join('；'), /仅执行了筛选用例/);
  assert.equal(evaluateProductionSafetyGate({ status: 'blocked' }, []).restricted, true);
  assert.deepEqual(validateProductionReadOnlyConfig({
    STABLE_SMOKE_PROD_BASE_URL: 'https://map.ebcone.net/',
  }), []);
  assert.deepEqual(validateProductionReadOnlyConfig({
    STABLE_SMOKE_PROD_BASE_URL: 'https://wrong.example',
  }), ['正式环境只读健康检查地址必须固定为 https://map.ebcone.net']);
});

test('正式环境单独运行时默认禁止业务写入', () => {
  assert.deepEqual(initializeProductionSafetyGate(['production']), {
    restricted: true,
    mode: 'read-only',
    grep: '\\[CORE-001\\]',
    reasons: ['本轮未执行 CDS 全量测试，正式环境仅允许只读健康检查'],
  });
  assert.deepEqual(initializeProductionSafetyGate(['cds', 'production']), {
    restricted: false,
    mode: 'full',
    grep: '',
    reasons: [],
  });
});

test('正式环境单独 dry-run 只校验只读健康检查地址', () => {
  assert.deepEqual(validateSelectedEnvironmentConfig('production', ['production'], {
    STABLE_SMOKE_PROD_BASE_URL: 'https://map.ebcone.net',
  }), []);
  assert.deepEqual(validateSelectedEnvironmentConfig('production', ['cds', 'production'], {
    STABLE_SMOKE_PROD_BASE_URL: 'https://map.ebcone.net',
  }), [
    'STABLE_SMOKE_PROD_AI_ACCESS_KEY',
    'STABLE_SMOKE_PROD_USER',
    'STABLE_SMOKE_PROD_GW_BASE_URL',
    'STABLE_SMOKE_PROD_GW_USER',
    'STABLE_SMOKE_PROD_GW_PASSWORD',
  ]);
});

test('正式环境只读模式只对账安全门实际执行的健康检查', () => {
  const required = ['CORE-001', 'REC-003', 'VIS-001'];
  const gate = initializeProductionSafetyGate(['production']);

  assert.deepEqual(
    selectCoverageCaseIds(required, '', ['production'], gate),
    ['CORE-001'],
  );
  assert.deepEqual(
    selectCoverageCaseIds(required, '\\[VIS-001\\]', ['production'], gate),
    ['CORE-001'],
  );
  assert.deepEqual(
    selectCoverageCaseIds(required, '', ['cds', 'production'], { ...gate, restricted: false }),
    required,
  );
  assert.deepEqual(
    selectCoverageCaseIds(required, '头像', ['cds'], { ...gate, restricted: false }, [
      { caseId: 'VIS-001', environment: 'cds' },
    ]),
    ['VIS-001'],
  );
});

test('功能与视觉结论取更严格结果', () => {
  assert.equal(foldVisualGateVerdict('pass', { verdict: '通过' }), 'pass');
  assert.equal(foldVisualGateVerdict('pass', { verdict: '不适用' }), 'pass');
  assert.equal(foldVisualGateVerdict('pass', { verdict: '不通过', statusCounts: {} }), 'conditional');
  assert.equal(foldVisualGateVerdict('pass', { verdict: '不通过', statusCounts: { 不通过: 1 } }), 'fail');
  assert.equal(foldVisualGateVerdict('fail', { verdict: '通过' }), 'fail');
});

test('视觉门禁执行前清除旧结果且只接受匹配的退出状态', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stable-smoke-visual-output-'));
  const paths = ['visual-gate.json', 'visual-gate.md', 'visual-technical-appendix.md']
    .map((name) => resolve(directory, name));
  try {
    for (const path of paths) writeFileSync(path, '历史通过结果', 'utf8');
    clearVisualGateOutputs(paths);
    assert.ok(paths.every((path) => !existsSync(path)));
    assert.equal(visualGateExecutionMatchesResult(0, { verdict: '通过' }), true);
    assert.equal(visualGateExecutionMatchesResult(0, { verdict: '不适用' }), true);
    assert.equal(visualGateExecutionMatchesResult(2, { verdict: '不通过' }), true);
    assert.equal(visualGateExecutionMatchesResult(1, { verdict: '通过' }), false);
    assert.equal(visualGateExecutionMatchesResult(0, { verdict: '不通过' }), false);
    assert.equal(visualGateExecutionMatchesResult(2, { verdict: '历史结论' }), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('所有持久化清理用例都必须声明清理元数据', () => {
  const source = readFileSync('e2e/specs/stable-smoke.spec.ts', 'utf8');
  const starts = [...source.matchAll(/\n  test\(/g)].map((match) => match.index);
  const blocks = starts.map((start, index) => source.slice(start, starts[index + 1] ?? source.length));
  const cleanupBlocks = blocks.filter((block) => block.includes("tag: '@cleanup'"));
  assert.ok(cleanupBlocks.length > 0);
  assert.ok(cleanupBlocks.every((block) => block.includes('finally {')));
  assert.match(source, /\[FILE-003\][\s\S]*?tag: '@cleanup'/);
  assert.match(source, /\[REC-004\]\[REC-005\]\[REC-010\][\s\S]*?tag: '@cleanup'/);
});

test('只有归档输出中的 HTTPS 深链可以进入通知', () => {
  const output = '正在归档\n{"mode":"cds","deeplink":"https://cds.example/reports?report=1"}\n归档完成\n';
  assert.equal(extractArchivedReportUrl(output), 'https://cds.example/reports?report=1');
  assert.equal(extractArchivedReportUrl('{"deeplink":"file:///tmp/report"}'), '');
  assert.equal(
    extractArchivedReportUrl('[OK] 已创建报告 12345678\n  直达: https://cds.example/reports?report=1\n'),
    'https://cds.example/reports?report=1',
  );
  assert.equal(isHttpsReportUrl('https://cds.example/reports?report=1'), true);
  assert.equal(isHttpsReportUrl('http://cds.example/reports?report=1'), false);
  assert.equal(isHttpsReportUrl('https://user:secret@cds.example/reports?report=1'), false);
});

test('正式环境只读运行使用无截图归档合同且打开验证不要求图片', () => {
  const archive = buildStableSmokeArchiveCommand({
    productionReadOnly: true,
    runId: 'read-only-test',
    verdict: 'pass',
    reportPath: '/tmp/report.md',
    manifestPath: '/tmp/empty-manifest.json',
    branch: 'codex/review',
    commit: 'a'.repeat(40),
    folderPath: '稳定冒烟/2026-08',
  });
  assert.equal(archive.contract, 'functional-read-only');
  assert.equal(archive.args.includes('archive_report.py'), false);
  assert.equal(archive.args.includes('report'), true);
  assert.equal(archive.args.includes('P0 只读冒烟'), true);
  assert.equal(archive.args.includes('/tmp/empty-manifest.json'), false);

  const verifyArgs = buildReportVerificationArgs(
    'https://cds.example/reports?report=1',
    'read-only-test',
    'a'.repeat(40),
    0,
    false,
  );
  assert.equal(verifyArgs[3], '0');
});

test('主运行器必须串联视觉门禁、主管报告合并、CDS 归档和 MAP 通知', () => {
  const source = readFileSync('scripts/stable-smoke-run.mjs', 'utf8');
  const automationPrompt = readFileSync('.claude/skills/stable-smoke/reference/local-automation-prompt.md', 'utf8');
  const verifyOpenSource = readFileSync('.claude/skills/create-visual-test-to-kb/scripts/verify-open.mjs', 'utf8');
  assert.match(source, /scripts\/stable-smoke-visual-plan\.mjs/);
  assert.match(source, /scripts\/stable-smoke-visual-gate\.mjs/);
  assert.match(source, /'--run-id', runId/);
  assert.match(source, /'--commit', values\.STABLE_SMOKE_COMMIT/);
  assert.match(source, /'--capture-started-at', visualCaptureStartedAt/);
  assert.match(source, /'--plan', visualPlanPath/);
  assert.match(source, /buildReportVerificationArgs/);
  assert.match(verifyOpenSource, /requiredTexts\.every/);
  assert.match(source, /scripts\/compose-stable-smoke-supervisor-report\.mjs/);
  assert.match(source, /create-visual-test-to-kb\/scripts\/archive_report\.py/);
  assert.match(source, /create-visual-test-to-kb\/scripts\/verify-open\.mjs/);
  assert.match(source, /scripts\/stable-smoke-notify\.mjs/);
  assert.match(source, /完整稳定冒烟缺少本轮视觉取证清单/);
  assert.doesNotMatch(source, /if \(!existsSync\(visualManifestPath\)\) writeFileSync\(visualManifestPath, '\[\]\\n'/);
  assert.match(automationPrompt, /--dry-run --run-id <runId>/);
  assert.match(automationPrompt, /\/验收/);
  assert.match(automationPrompt, /--visual-manifest <manifest\.json绝对路径>/);
  assert.match(source, /requiredCaseIdsByEnvironment/);
  assert.match(source, /buildEnvironmentGrep/);
  assert.match(automationPrompt, /人工 `--grep` 只能取本环境允许集合的交集/);
  assert.equal((source.match(/'--environments', selected\.join\(','\)/g) || []).length, 3);
  assert.match(source, /summaryDocument\.notification\.status === 'delivery-failed'/);
  assert.match(source, /await deliverUnhandledFailure\(process\.argv\.slice\(2\), error\)/);
});

test('未捕获异常会持久化失败摘要并进入失败交付路径', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stable-smoke-fatal-'));
  try {
    const result = await deliverUnhandledFailure([
      '--run-id', 'fatal-test',
      '--output-root', directory,
      '--env-file', resolve(directory, 'missing.env'),
      '--dry-run',
    ], new Error('视觉证据门禁未产生可读取结论'));
    const summary = JSON.parse(readFileSync(result.summaryPath, 'utf8'));

    const expected = buildUnhandledFailureSummary({
      runId: 'fatal-test',
      selected: ['cds', 'production'],
      reason: '视觉证据门禁未产生可读取结论',
    });
    assert.deepEqual({ ...summary, notification: expected.notification }, expected);
    assert.equal(summary.notification.status, 'skipped');
    assert.equal(summary.verdict, 'fail');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('环境文件解析不执行 shell 内容', () => {
  const values = parseEnvFile(`
# comment
export STABLE_SMOKE_CDS_USER='stsmk_cds'
STABLE_SMOKE_CDS_AI_ACCESS_KEY="literal-value"
IGNORED-KEY=value
`);
  assert.deepEqual(values, {
    STABLE_SMOKE_CDS_USER: 'stsmk_cds',
    STABLE_SMOKE_CDS_AI_ACCESS_KEY: 'literal-value',
  });
});

test('环境模板账号与凭据注册表保持一致', () => {
  const template = readFileSync('.env.template', 'utf8');
  const registry = JSON.parse(readFileSync(
    '.claude/skills/stable-smoke/reference/credential-registry.json',
    'utf8',
  ));
  const values = Object.fromEntries(registry.localBindings
    .filter((item) => item.value)
    .map((item) => [item.envKey, item.value]));
  assert.match(template, new RegExp(`STABLE_SMOKE_CDS_USER=${values.STABLE_SMOKE_CDS_USER}\\b`));
  assert.match(template, new RegExp(`STABLE_SMOKE_PROD_USER=${values.STABLE_SMOKE_PROD_USER}\\b`));
  assert.match(template, /SYNTHETIC_LOGIN_ALLOWED_USERS=stsmk_cds,stsmk_prod\b/);
  assert.doesNotMatch(template, /stsmk_(?:cds|prod)_admin/);
});

test('双环境凭据缺失时前置检查明确阻断', () => {
  assert.deepEqual(validateEnvironmentConfig('cds', {}), [
    'STABLE_SMOKE_CDS_BASE_URL',
    'STABLE_SMOKE_CDS_AI_ACCESS_KEY',
    'STABLE_SMOKE_CDS_USER',
    'STABLE_SMOKE_CDS_GW_BASE_URL',
    'STABLE_SMOKE_CDS_GW_USER',
    'STABLE_SMOKE_CDS_GW_PASSWORD',
  ]);
  assert.deepEqual(validateEnvironmentConfig('production', {
    STABLE_SMOKE_PROD_BASE_URL: 'https://wrong.example',
    STABLE_SMOKE_PROD_AI_ACCESS_KEY: 'secret',
    STABLE_SMOKE_PROD_USER: 'stsmk',
    STABLE_SMOKE_PROD_GW_BASE_URL: 'https://gateway.example',
    STABLE_SMOKE_PROD_GW_USER: 'gateway-user',
    STABLE_SMOKE_PROD_GW_PASSWORD: 'gateway-password',
  }), ['正式环境地址必须固定为 https://map.ebcone.net']);
});

test('主应用凭据齐全但网关凭据缺失时仍阻断开测', () => {
  assert.deepEqual(validateEnvironmentConfig('cds', {
    STABLE_SMOKE_CDS_BASE_URL: 'https://app.example',
    STABLE_SMOKE_CDS_AI_ACCESS_KEY: 'secret',
    STABLE_SMOKE_CDS_USER: 'stable-smoke',
  }), [
    'STABLE_SMOKE_CDS_GW_BASE_URL',
    'STABLE_SMOKE_CDS_GW_USER',
    'STABLE_SMOKE_CDS_GW_PASSWORD',
  ]);
});

test('凭据登记表只在环境变量缺失时读取 Keychain', () => {
  const calls = [];
  const values = applyCredentialRegistry(
    { STABLE_SMOKE_CDS_USER: 'explicit-user' },
    { localBindings: [
      { envKey: 'STABLE_SMOKE_CDS_USER', value: 'registry-user' },
      { envKey: 'STABLE_SMOKE_CDS_AI_ACCESS_KEY', keychainService: 'cds-key', keychainAccount: 'stable-smoke' },
    ] },
    (service, account) => {
      calls.push([service, account]);
      return 'secret-value';
    },
  );
  assert.equal(values.STABLE_SMOKE_CDS_USER, 'explicit-user');
  assert.equal(values.STABLE_SMOKE_CDS_AI_ACCESS_KEY, 'secret-value');
  assert.deepEqual(calls, [['cds-key', 'stable-smoke']]);
});

test('CDS 地址始终来自 preview-url 并拒绝过期缓存', () => {
  const authoritative = () => ({
    status: 0,
    stdout: 'https://branch.example/\nhttps://branch-llmgw.example/\n',
  });
  assert.deepEqual(resolveCdsPreviewUrls('', '', authoritative), {
    appUrl: 'https://branch.example',
    gatewayUrl: 'https://branch-llmgw.example',
  });
  assert.deepEqual(resolveCdsPreviewUrls(
    'https://branch.example/',
    'https://branch-llmgw.example/',
    authoritative,
  ), {
    appUrl: 'https://branch.example',
    gatewayUrl: 'https://branch-llmgw.example',
  });
  assert.throws(
    () => resolveCdsPreviewUrls('https://stale.example', '', authoritative),
    /缓存地址与当前分支权威地址不一致/,
  );
});

test('CDS 地址按权威入口顺序解析而不猜测域名中的服务名称', () => {
  const authoritative = () => ({
    status: 0,
    stdout: 'https://llmgw-feature.example/\nhttps://gateway.example/\n',
  });

  assert.deepEqual(resolveCdsPreviewUrls('', '', authoritative), {
    appUrl: 'https://llmgw-feature.example',
    gatewayUrl: 'https://gateway.example',
  });
});

test('CDS 权威地址解析失败时普通执行也必须熔断', () => {
  assert.throws(
    () => requireAuthoritativeCdsAddress(['CDS 主应用缓存地址与当前分支权威地址不一致']),
    /拒绝使用缓存地址开测/,
  );
  assert.doesNotThrow(() => requireAuthoritativeCdsAddress([]));
});

test('人工提供的验收报告必须同时绑定当前 runId 与固定 commit', () => {
  const args = buildReportVerificationArgs(
    'https://cds.example/reports?report=1',
    'stable-smoke-20260811-001',
    '1234567890abcdef',
    296,
  );
  assert.deepEqual(args.slice(-2), ['stable-smoke-20260811-001', '1234567890abcdef']);
  assert.equal(args[3], '296');
});

test('超过时限但进程仍存活的互斥锁不得被第二轮删除', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stable-smoke-lock-'));
  const lockPath = resolve(directory, '.stable-smoke.lock');
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 4 * 60 * 60 * 1000);
    utimesSync(lockPath, old, old);

    assert.equal(removeStaleLockIfSafe(lockPath), false);
    assert.equal(existsSync(lockPath), true);
    assert.equal(acquireLock(lockPath), false);
    assert.equal(existsSync(lockPath), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('互斥锁发布时已经包含完整 owner，不暴露空锁窗口', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stable-smoke-atomic-lock-'));
  const lockPath = resolve(directory, '.stable-smoke.lock');
  try {
    assert.equal(acquireLock(lockPath), true);
    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('无效锁先保留 owner 发布宽限期，超时后才允许强制清理', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stable-smoke-force-unlock-'));
  const lockPath = resolve(directory, '.stable-smoke.lock');
  try {
    writeFileSync(lockPath, 'not-a-pid\n', { mode: 0o600 });
    assert.equal(removeStaleLockIfSafe(lockPath), false);
    assert.equal(existsSync(lockPath), true);

    const afterOwnerPublishGrace = new Date(Date.now() - 60_000);
    utimesSync(lockPath, afterOwnerPublishGrace, afterOwnerPublishGrace);
    assert.equal(removeStaleLockIfSafe(lockPath), true);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('互斥锁阻塞的定时任务仍持久化有条件结论并发送 MAP 通知', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stable-smoke-locked-'));
  const calls = [];
  try {
    const result = await deliverLockedRun([
      '--run-id', 'locked-test',
      '--output-root', directory,
      '--cds-only',
    ], {
      values: {},
      commandFn: (name, args) => {
        calls.push({ name, args });
        return { status: 0, stdout: '{"sent":true}\n', stderr: '' };
      },
    });
    const summary = JSON.parse(readFileSync(result.summaryPath, 'utf8'));
    assert.deepEqual(
      buildLockedRunSummary({ runId: 'locked-test', selected: ['cds'] }).archive,
      summary.archive,
    );
    assert.equal(summary.verdict, 'conditional');
    assert.equal(summary.notification.status, 'sent');
    assert.equal(existsSync(result.blockedPath), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 5), [
      'scripts/stable-smoke-notify.mjs',
      '--verdict',
      'conditional',
      '--run-id',
      'locked-test',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('预检实际验证主应用与网关身份且不泄露凭据', async () => {
  const values = {
    STABLE_SMOKE_CDS_BASE_URL: 'https://app.example/',
    STABLE_SMOKE_CDS_AI_ACCESS_KEY: 'main-secret',
    STABLE_SMOKE_CDS_USER: 'stable-smoke',
    STABLE_SMOKE_CDS_GW_BASE_URL: 'https://gateway.example/',
    STABLE_SMOKE_CDS_GW_USER: 'gateway-user',
    STABLE_SMOKE_CDS_GW_PASSWORD: 'gateway-secret',
  };
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    if (String(url).endsWith('/api/v1/auth/synthetic/ticket')) {
      return { ok: true, json: async () => ({ success: true, data: { loginUrl: '/synthetic-login#code=test' } }) };
    }
    return { ok: true, json: async () => ({ success: true, data: { token: 'token', mustChangePassword: false } }) };
  };

  assert.deepEqual(await validateEnvironmentIdentities('cds', values, fetchFn), []);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://app.example/api/v1/auth/synthetic/ticket');
  assert.equal(calls[1].url, 'https://gateway.example/gw/auth/login');
  assert.equal(calls[0].options.headers['X-AI-Access-Key'], 'main-secret');
  assert.notEqual(calls[0].options.signal, calls[1].options.signal);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    username: 'gateway-user',
    password: 'gateway-secret',
  });
});

test('预检身份失败只返回审核人可读阻塞项', async () => {
  const values = {
    STABLE_SMOKE_PROD_BASE_URL: 'https://map.ebcone.net',
    STABLE_SMOKE_PROD_AI_ACCESS_KEY: 'main-secret',
    STABLE_SMOKE_PROD_USER: 'stable-smoke',
    STABLE_SMOKE_PROD_GW_BASE_URL: 'https://gateway.example',
    STABLE_SMOKE_PROD_GW_USER: 'gateway-user',
    STABLE_SMOKE_PROD_GW_PASSWORD: 'gateway-secret',
  };
  const fetchFn = async (url) => String(url).includes('/synthetic/ticket')
    ? { ok: false, json: async () => ({ error: { message: 'HTTP 401 provider token' } }) }
    : { ok: true, json: async () => ({ success: true, data: { token: '', mustChangePassword: true } }) };

  const blockers = await validateEnvironmentIdentities('production', values, fetchFn);
  assert.deepEqual(blockers, [
    '正式环境主应用自动化身份校验未通过',
    '正式环境模型网关自动化身份校验未通过',
  ]);
  assert.doesNotMatch(blockers.join(' '), /HTTP|provider|token|secret|gateway-user/i);
});

test('CDS 版本冻结门禁要求目标提交、全部服务健康且无漂移', () => {
  const commit = 'abc123';
  const branch = {
    status: 'running',
    commitSha: commit,
    ciTargetSha: commit,
    ciImageStatus: 'ready',
    lastDeployDispatchCommitSha: commit,
    currentVersionId: 'dv-test',
    deployRuntime: { drift: { hasDrift: false } },
    services: {
      api: { profileId: 'api', status: 'running', deployedImage: `registry/api:sha-${commit}` },
      admin: { profileId: 'admin', status: 'running', deployedImage: `registry/admin:sha-${commit}` },
    },
  };
  assert.deepEqual(evaluateCdsReadiness(branch, commit), {
    ready: true,
    reasons: [],
    versionId: 'dv-test',
    commit,
    runtimeCommit: commit,
    runtimeEquivalent: false,
    validationOnlyChanges: [],
    serviceRuntimeCommits: {},
  });
  branch.services.admin.status = 'stopped';
  branch.deployRuntime.drift.hasDrift = true;
  const blocked = evaluateCdsReadiness(branch, commit);
  assert.equal(blocked.ready, false);
  assert.ok(blocked.reasons.some((reason) => reason.includes('版本漂移')));
  assert.ok(blocked.reasons.some((reason) => reason.includes('admin 未运行')));
});

test('纯验收工具变化可复用已部署业务版本且留下等价记录', () => {
  const deployedCommit = '1111111';
  const expectedCommit = '2222222';
  const branch = {
    status: 'running',
    commitSha: expectedCommit,
    ciTargetSha: expectedCommit,
    ciImageStatus: 'waiting',
    lastDeployDispatchCommitSha: deployedCommit,
    currentVersionId: 'dv-runtime',
    deployRuntime: { drift: { hasDrift: false } },
    services: {
      api: { profileId: 'api', status: 'running', deployedImage: `registry/api:sha-${deployedCommit}` },
      admin: { profileId: 'admin', status: 'running', deployedImage: `registry/admin:sha-${deployedCommit}` },
    },
  };
  const files = [
    '.claude/skills/stable-smoke/reference/regression-ledger.md',
    '.Codex/rules/user-readable-errors.md',
    'e2e/specs/stable-smoke.spec.ts',
    'scripts/stable-smoke-visual-gate.mjs',
    'scripts/tests/stable-smoke-visual-gate.test.mjs',
    'changelogs/2026-08-05_stable-smoke.md',
  ];
  assert.equal(deployedRuntimeCommit(branch), deployedCommit);
  assert.equal(files.every(isValidationOnlyPath), true);
  assert.equal(isValidationOnlyPath('.codex/rules/user-readable-errors.md'), false);
  const expectation = resolveRuntimeExpectation(branch, expectedCommit, files);
  assert.deepEqual(evaluateCdsReadiness(branch, expectedCommit, expectation), {
    ready: true,
    reasons: [],
    versionId: 'dv-runtime',
    commit: expectedCommit,
    runtimeCommit: deployedCommit,
    runtimeEquivalent: true,
    validationOnlyChanges: files,
    serviceRuntimeCommits: {
      api: deployedCommit,
      admin: deployedCommit,
    },
  });
});

test('业务运行时代码变化不得借用旧镜像通过版本门禁', () => {
  const branch = {
    services: {
      api: { deployedImage: 'registry/api:sha-1111111' },
      admin: { deployedImage: 'registry/admin:sha-1111111' },
    },
  };
  const expectation = resolveRuntimeExpectation(branch, '2222222', ['prd-api/src/Program.cs']);
  assert.equal(expectation.runtimeEquivalent, false);
  assert.equal(expectation.runtimeCommit, '2222222');
});

test('组件级构建允许未受影响服务复用各自上一版镜像', () => {
  const previousCommit = '1111111';
  const expectedCommit = '2222222';
  const branch = {
    status: 'running',
    commitSha: expectedCommit,
    ciTargetSha: expectedCommit,
    ciImageStatus: 'ready',
    lastDeployDispatchCommitSha: expectedCommit,
    currentVersionId: 'dv-component-reuse',
    deployRuntime: { drift: { hasDrift: false } },
    services: {
      api: { profileId: 'api-prd-agent', status: 'running', deployedMode: 'express', deployedImage: `registry/api:sha-${previousCommit}` },
      admin: { profileId: 'admin-prd-agent', status: 'running', deployedMode: 'express', deployedImage: `registry/admin:sha-${expectedCommit}` },
    },
  };
  const changedFilesByCommit = { [previousCommit]: ['prd-admin/src/App.tsx'] };
  const serviceRuntimeCommits = resolveServiceRuntimeCommits(branch, expectedCommit, changedFilesByCommit);
  const expectation = resolveRuntimeExpectation(branch, expectedCommit, [], changedFilesByCommit);

  assert.deepEqual(serviceRuntimeCommits, { api: previousCommit, admin: expectedCommit });
  assert.equal(evaluateCdsReadiness(branch, expectedCommit, expectation).ready, true);
});

test('组件级构建拒绝复用包含本组件代码差异的旧镜像', () => {
  const previousCommit = '1111111';
  const expectedCommit = '2222222';
  const branch = {
    status: 'running',
    commitSha: expectedCommit,
    ciTargetSha: expectedCommit,
    ciImageStatus: 'ready',
    lastDeployDispatchCommitSha: expectedCommit,
    currentVersionId: 'dv-stale-api',
    deployRuntime: { drift: { hasDrift: false } },
    services: {
      api: { profileId: 'api-prd-agent', status: 'running', deployedMode: 'express', deployedImage: `registry/api:sha-${previousCommit}` },
    },
  };
  const changedFilesByCommit = { [previousCommit]: ['prd-api/src/Program.cs'] };
  const expectation = resolveRuntimeExpectation(branch, expectedCommit, [], changedFilesByCommit);
  const readiness = evaluateCdsReadiness(branch, expectedCommit, expectation);

  assert.equal(readiness.ready, false);
  assert.ok(readiness.reasons.some((reason) => reason.includes('api-prd-agent 尚未切换')));
});

test('CDS 源码模式以分支提交和运行状态验收而不要求 SHA 镜像', () => {
  const expectedCommit = '2222222';
  const branch = {
    status: 'running',
    commitSha: expectedCommit,
    ciTargetSha: expectedCommit,
    ciImageStatus: 'ready',
    lastDeployDispatchCommitSha: expectedCommit,
    currentVersionId: 'dv-source',
    deployRuntime: { drift: { hasDrift: false } },
    services: {
      api: { profileId: 'api-prd-agent', status: 'running', deployedMode: 'static', deployedImage: 'mcr.microsoft.com/dotnet/sdk:8.0' },
    },
  };

  const readiness = evaluateCdsReadiness(branch, expectedCommit, resolveRuntimeExpectation(branch, expectedCommit));
  assert.equal(readiness.ready, true);
});
