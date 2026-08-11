import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  acquireLock,
  applyCredentialRegistry,
  buildExecutionRecord,
  deployedRuntimeCommit,
  enforceExecutionVerdict,
  evaluateCdsReadiness,
  evaluateProductionSafetyGate,
  extractArchivedReportUrl,
  foldVisualGateVerdict,
  isValidationOnlyPath,
  parseEnvFile,
  parseRunnerArgs,
  runnerHelpText,
  resolveRuntimeExpectation,
  resolveServiceRuntimeCommits,
  validateEnvironmentConfig,
  validateEnvironmentIdentities,
  validateProductionReadOnlyConfig,
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

  assert.equal(evaluateProductionSafetyGate({ status: 'executed' }, [{ status: 'pass' }]).restricted, false);
  assert.equal(evaluateProductionSafetyGate({ status: 'blocked' }, []).restricted, true);
  assert.deepEqual(validateProductionReadOnlyConfig({
    STABLE_SMOKE_PROD_BASE_URL: 'https://map.ebcone.net/',
  }), []);
  assert.deepEqual(validateProductionReadOnlyConfig({
    STABLE_SMOKE_PROD_BASE_URL: 'https://wrong.example',
  }), ['正式环境只读健康检查地址必须固定为 https://map.ebcone.net']);
});

test('功能与视觉结论取更严格结果', () => {
  assert.equal(foldVisualGateVerdict('pass', { verdict: '通过' }), 'pass');
  assert.equal(foldVisualGateVerdict('pass', { verdict: '不通过', statusCounts: {} }), 'conditional');
  assert.equal(foldVisualGateVerdict('pass', { verdict: '不通过', statusCounts: { 不通过: 1 } }), 'fail');
  assert.equal(foldVisualGateVerdict('fail', { verdict: '通过' }), 'fail');
});

test('只有归档输出中的 HTTPS 深链可以进入通知', () => {
  const output = '正在归档\n{"mode":"cds","deeplink":"https://cds.example/reports?report=1"}\n归档完成\n';
  assert.equal(extractArchivedReportUrl(output), 'https://cds.example/reports?report=1');
  assert.equal(extractArchivedReportUrl('{"deeplink":"file:///tmp/report"}'), '');
});

test('主运行器必须串联视觉门禁、主管报告合并、CDS 归档和 MAP 通知', () => {
  const source = readFileSync('scripts/stable-smoke-run.mjs', 'utf8');
  assert.match(source, /scripts\/stable-smoke-visual-plan\.mjs/);
  assert.match(source, /scripts\/stable-smoke-visual-gate\.mjs/);
  assert.match(source, /scripts\/compose-stable-smoke-supervisor-report\.mjs/);
  assert.match(source, /create-visual-test-to-kb\/scripts\/archive_report\.py/);
  assert.match(source, /create-visual-test-to-kb\/scripts\/verify-open\.mjs/);
  assert.match(source, /scripts\/stable-smoke-notify\.mjs/);
  assert.match(source, /summaryDocument\.notification\.status === 'delivery-failed'/);
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

test('超过时限但进程仍存活的互斥锁不得被第二轮删除', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stable-smoke-lock-'));
  const lockPath = resolve(directory, '.stable-smoke.lock');
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 4 * 60 * 60 * 1000);
    utimesSync(lockPath, old, old);

    assert.equal(acquireLock(lockPath), false);
    assert.equal(existsSync(lockPath), true);
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
    'scripts/stable-smoke-visual-gate.mjs',
    'scripts/tests/stable-smoke-visual-gate.test.mjs',
    'changelogs/2026-08-05_stable-smoke.md',
  ];
  assert.equal(deployedRuntimeCommit(branch), deployedCommit);
  assert.equal(files.every(isValidationOnlyPath), true);
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
