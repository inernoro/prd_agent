#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  collectPlaywrightCases,
  reconcileCaseCoverage,
  selectRequiredCaseIds,
  summarizeCoverage,
} from './stable-smoke-results.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const defaultOutputRoot = '/tmp/prd-agent-stable-smoke';
const productionBaseUrl = 'https://map.ebcone.net';
const credentialRegistryPath = resolve(repoRoot, '.claude/skills/stable-smoke/reference/credential-registry.json');

const valueOptions = new Set([
  '--run-id',
  '--output-root',
  '--env-file',
  '--grep',
  '--visual-manifest',
  '--report-url',
]);
const flagOptions = new Set(['--force-unlock', '--cds-only', '--production-only', '--dry-run', '--preflight', '--help']);
export const productionReadOnlyGrep = '\\[CORE-001\\]';

export const runnerHelpText = `稳定冒烟本地运行器

用法：
  node scripts/stable-smoke-run.mjs [选项]

选项：
  --preflight          只检查双环境地址、身份和 CDS 部署状态，不启动测试
  --cds-only           只运行 CDS 环境
  --production-only    只运行正式环境只读健康检查；写入旅程必须先在同一轮完成 CDS 验证
  --dry-run            生成计划并检查凭据，不执行业务旅程
  --run-id <值>        指定本轮稳定冒烟标识
  --output-root <路径> 指定本地产物目录
  --env-file <路径>    指定本地凭据兼容文件
  --grep <表达式>      只运行匹配的 Playwright 用例
  --visual-manifest <路径> 指定真人浏览器视觉取证 manifest；缺失时视觉门禁明确判失败
  --report-url <地址>  使用已归档的 HTTPS 验收报告地址；缺省时自动归档到 CDS 验收中心
  --force-unlock       仅在确认原进程已结束或锁损坏时清理遗留互斥锁
  --help               显示本说明
`;

export function parseRunnerArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (valueOptions.has(option)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${option} 必须提供值`);
      values[option] = value;
      index += 1;
      continue;
    }
    if (flagOptions.has(option)) {
      flags.add(option);
      continue;
    }
    throw new Error(`不支持的参数 ${option}，请运行 --help 查看可用选项`);
  }
  if (flags.has('--cds-only') && flags.has('--production-only')) {
    throw new Error('--cds-only 与 --production-only 不能同时使用');
  }
  return {
    has: (name) => flags.has(name),
    read: (name, fallback = '') => values[name] || fallback,
  };
}

export function parseEnvFile(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function loadLocalEnvironment(envPath) {
  if (!existsSync(envPath)) return { loaded: false, values: {} };
  const mode = statSync(envPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${envPath} 权限必须为 0600，当前为 ${mode.toString(8)}`);
  }
  return { loaded: true, values: parseEnvFile(readFileSync(envPath, 'utf8')) };
}

function command(name, args, options = {}) {
  return spawnSync(name, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

export function applyCredentialRegistry(values, registry, secretReader = () => '') {
  const next = { ...values };
  for (const binding of registry.localBindings || []) {
    if (!next[binding.envKey] && binding.value) next[binding.envKey] = binding.value;
    if (!next[binding.envKey] && binding.keychainService) {
      const secret = secretReader(binding.keychainService, binding.keychainAccount || 'stable-smoke');
      if (secret) next[binding.envKey] = secret;
    }
  }
  return next;
}

function readKeychainSecret(service, account) {
  if (process.platform !== 'darwin') return '';
  const result = command('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

export function resolveCdsPreviewUrls(
  explicitUrl = '',
  explicitGatewayUrl = '',
  previewReader = () => command('python3', ['.claude/skills/cds/cli/cdscli.py', '--human', 'preview-url']),
) {
  const result = previewReader();
  if (result.status !== 0) throw new Error('CDS 权威预览地址读取失败，请修复项目凭据或部署状态后重试');
  const urls = String(result.stdout || '').match(/https:\/\/[^\s]+/g) || [];
  // preview-url 的公开入口顺序是权威契约：第一个为主应用，第二个为模型网关。
  // 不能从域名文本猜服务类型，分支名本身可能包含 llmgw，网关域名也未必包含该词。
  const [appUrl, gatewayUrl] = urls;
  if (!appUrl) throw new Error('CDS 未返回主应用预览地址，拒绝本地推算');
  if (!gatewayUrl) throw new Error('CDS 未返回模型网关预览地址，拒绝本地推算');
  const authoritativeAppUrl = appUrl.replace(/\/+$/, '');
  const authoritativeGatewayUrl = gatewayUrl.replace(/\/+$/, '');
  const cachedAppUrl = explicitUrl.replace(/\/+$/, '');
  const cachedGatewayUrl = explicitGatewayUrl.replace(/\/+$/, '');
  if (cachedAppUrl && cachedAppUrl !== authoritativeAppUrl) {
    throw new Error('CDS 主应用缓存地址与当前分支权威地址不一致，请更新本地凭据配置后重试');
  }
  if (cachedGatewayUrl && cachedGatewayUrl !== authoritativeGatewayUrl) {
    throw new Error('CDS 模型网关缓存地址与当前分支权威地址不一致，请更新本地凭据配置后重试');
  }
  return {
    appUrl: authoritativeAppUrl,
    gatewayUrl: authoritativeGatewayUrl,
  };
}

export function requireAuthoritativeCdsAddress(blockers = []) {
  if (blockers.length > 0) {
    throw new Error(`CDS 权威预览地址校验未通过，拒绝使用缓存地址开测：${blockers.join('；')}`);
  }
}

export function buildReportVerificationArgs(reportUrl, runId, commit, screenshotCount) {
  if (!runId || !commit) throw new Error('验收报告验证缺少当前 runId 或固定 commit');
  return [
    '.claude/skills/create-visual-test-to-kb/scripts/verify-open.mjs',
    reportUrl,
    '核心业务稳定冒烟',
    String(Math.max(1, screenshotCount || 0)),
    runId,
    commit,
  ];
}

export function validateEnvironmentConfig(name, values) {
  const prefix = name === 'cds' ? 'STABLE_SMOKE_CDS' : 'STABLE_SMOKE_PROD';
  const errors = [];
  if (!values[`${prefix}_BASE_URL`]) errors.push(`${prefix}_BASE_URL`);
  if (!values[`${prefix}_AI_ACCESS_KEY`]) errors.push(`${prefix}_AI_ACCESS_KEY`);
  if (!values[`${prefix}_USER`]) errors.push(`${prefix}_USER`);
  if (!values[`${prefix}_GW_BASE_URL`]) errors.push(`${prefix}_GW_BASE_URL`);
  if (!values[`${prefix}_GW_USER`]) errors.push(`${prefix}_GW_USER`);
  if (!values[`${prefix}_GW_PASSWORD`]) errors.push(`${prefix}_GW_PASSWORD`);
  if (name === 'production' && values[`${prefix}_BASE_URL`]?.replace(/\/+$/, '') !== productionBaseUrl) {
    errors.push('正式环境地址必须固定为 https://map.ebcone.net');
  }
  return errors;
}

export function validateProductionReadOnlyConfig(values) {
  const baseUrl = values.STABLE_SMOKE_PROD_BASE_URL?.replace(/\/+$/, '');
  return baseUrl === productionBaseUrl
    ? []
    : ['正式环境只读健康检查地址必须固定为 https://map.ebcone.net'];
}

function withoutTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

export async function validateEnvironmentIdentities(environment, values, fetchFn = globalThis.fetch) {
  const prefix = environment === 'cds' ? 'STABLE_SMOKE_CDS' : 'STABLE_SMOKE_PROD';
  const label = environment === 'cds' ? 'CDS 环境' : '正式环境';
  const blockers = [];

  try {
    const response = await fetchFn(
      `${withoutTrailingSlash(values[`${prefix}_BASE_URL`])}/api/v1/auth/synthetic/ticket`,
      {
        signal: AbortSignal.timeout(10_000),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AI-Access-Key': values[`${prefix}_AI_ACCESS_KEY`],
          'X-AI-Impersonate': values[`${prefix}_USER`],
        },
        body: JSON.stringify({ returnUrl: '/', expiresInSeconds: 60 }),
      },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true || !payload?.data?.loginUrl) {
      blockers.push(`${label}主应用自动化身份校验未通过`);
    }
  } catch {
    blockers.push(`${label}主应用自动化身份无法连接`);
  }

  try {
    const response = await fetchFn(
      `${withoutTrailingSlash(values[`${prefix}_GW_BASE_URL`])}/gw/auth/login`,
      {
        signal: AbortSignal.timeout(10_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: values[`${prefix}_GW_USER`],
          password: values[`${prefix}_GW_PASSWORD`],
        }),
      },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok
      || payload?.success !== true
      || !payload?.data?.token
      || payload?.data?.mustChangePassword !== false) {
      blockers.push(`${label}模型网关自动化身份校验未通过`);
    }
  } catch {
    blockers.push(`${label}模型网关自动化身份无法连接`);
  }

  return blockers;
}

const validationOnlyPrefixes = [
  '.agents/skills/',
  '.claude/skills/create-visual-test-to-kb/',
  '.claude/skills/stable-smoke/',
  '.Codex/',
  'changelogs/',
  'doc/',
  'e2e/',
  'scripts/tests/',
];

const validationOnlyFiles = new Set([
  'scripts/compose-stable-smoke-supervisor-report.mjs',
  'scripts/prepare-stable-smoke-archive-report.mjs',
  'scripts/render-stable-smoke-report.mjs',
  'scripts/split-stable-smoke-report.mjs',
]);

export function isValidationOnlyPath(path) {
  const normalized = String(path || '').replaceAll('\\', '/');
  return validationOnlyFiles.has(normalized)
    || normalized.startsWith('scripts/stable-smoke-')
    || validationOnlyPrefixes.some((prefix) => normalized.startsWith(prefix));
}

export function deployedRuntimeCommit(branch) {
  const commits = new Set(Object.values(branch?.services || {}).flatMap((service) => {
    const match = String(service?.deployedImage || '').match(/:sha-([0-9a-f]{7,40})$/i);
    return match ? [match[1]] : [];
  }));
  return commits.size === 1 ? [...commits][0] : '';
}

const serviceBuildScopes = [
  { matches: (name) => name.startsWith('llmgw-serve'), paths: ['llmgw/serving/', 'prd-api/', '.github/workflows/branch-image.yml'] },
  { matches: (name) => name.startsWith('llmgw-web'), paths: ['llmgw/web/', 'prd-api/', '.github/workflows/branch-image.yml'] },
  { matches: (name) => name.startsWith('llmgw'), paths: ['llmgw/console-api/', 'prd-api/', '.github/workflows/branch-image.yml'] },
  { matches: (name) => name.startsWith('admin'), paths: ['prd-admin/', '.github/workflows/branch-image.yml'] },
  { matches: (name) => name.startsWith('api'), paths: ['prd-api/', '.github/workflows/branch-image.yml'] },
];

function deployedImageCommit(service) {
  return String(service?.deployedImage || '').match(/:sha-([0-9a-f]{7,40})$/i)?.[1] || '';
}

function serviceNeedsCurrentCommit(serviceName, changedFiles) {
  const scope = serviceBuildScopes.find((candidate) => candidate.matches(serviceName));
  if (!scope || !Array.isArray(changedFiles)) return true;
  return changedFiles.some((path) => scope.paths.some((prefix) => (
    prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix
  )));
}

export function resolveServiceRuntimeCommits(branch, expectedCommit, changedFilesByCommit = {}) {
  return Object.fromEntries(Object.entries(branch?.services || {}).map(([key, service]) => {
    const serviceName = String(service?.profileId || key).toLowerCase();
    const deployedCommit = deployedImageCommit(service);
    if (!deployedCommit || deployedCommit === expectedCommit) return [key, expectedCommit];
    const changedFiles = changedFilesByCommit[deployedCommit];
    return [key, serviceNeedsCurrentCommit(serviceName, changedFiles) ? expectedCommit : deployedCommit];
  }));
}

export function resolveRuntimeExpectation(branch, expectedCommit, changedFiles = [], changedFilesByCommit = {}) {
  const deployedCommit = deployedRuntimeCommit(branch);
  const runtimeEquivalent = Boolean(
    deployedCommit
    && deployedCommit !== expectedCommit
    && changedFiles.length > 0
    && changedFiles.every(isValidationOnlyPath),
  );
  const runtimeCommit = runtimeEquivalent ? deployedCommit : expectedCommit;
  return {
    expectedCommit,
    runtimeCommit,
    runtimeEquivalent,
    validationOnlyChanges: runtimeEquivalent ? [...changedFiles] : [],
    serviceRuntimeCommits: runtimeEquivalent
      ? Object.fromEntries(Object.keys(branch?.services || {}).map((key) => [key, runtimeCommit]))
      : resolveServiceRuntimeCommits(branch, expectedCommit, changedFilesByCommit),
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonFromText(text) {
  try {
    return JSON.parse(String(text || '').trim());
  } catch {
    return null;
  }
}

export function evaluateCdsReadiness(branch, expectedCommit, runtimeExpectation = {}) {
  const runtimeCommit = runtimeExpectation.runtimeCommit || expectedCommit;
  const runtimeEquivalent = runtimeExpectation.runtimeEquivalent === true;
  const serviceRuntimeCommits = runtimeExpectation.serviceRuntimeCommits || {};
  const reasons = [];
  const services = Object.values(branch?.services || {});
  if (branch?.status !== 'running') reasons.push(`分支状态为 ${branch?.status || 'unknown'}`);
  if (branch?.commitSha !== expectedCommit) reasons.push('CDS 分支提交尚未同步到本地目标提交');
  if (!runtimeEquivalent && branch?.ciTargetSha !== expectedCommit) reasons.push('CDS 镜像目标尚未锁定本地目标提交');
  if (!runtimeEquivalent && branch?.ciImageStatus !== 'ready') reasons.push(`CDS 镜像状态为 ${branch?.ciImageStatus || 'unknown'}`);
  if (branch?.lastDeployDispatchCommitSha !== runtimeCommit) reasons.push('CDS 尚未对运行时目标提交完成部署调度');
  if (branch?.deployRuntime?.drift?.hasDrift) reasons.push('CDS 服务存在版本漂移');
  if (services.length === 0) reasons.push('CDS 未返回任何业务服务');
  for (const [serviceKey, service] of Object.entries(branch?.services || {})) {
    const serviceName = service.profileId || service.containerName || '未知服务';
    if (service.status !== 'running') reasons.push(`${serviceName} 未运行`);
    const expectedServiceCommit = serviceRuntimeCommits[serviceKey] || runtimeCommit;
    const sourceMode = service.deployedMode && service.deployedMode !== 'express';
    if (!sourceMode && !String(service.deployedImage || '').endsWith(`:sha-${expectedServiceCommit}`)) {
      reasons.push(`${serviceName} 尚未切换到运行时目标镜像`);
    }
  }
  return {
    ready: reasons.length === 0,
    reasons: [...new Set(reasons)],
    versionId: branch?.currentVersionId || '',
    commit: branch?.commitSha || '',
    runtimeCommit,
    runtimeEquivalent,
    validationOnlyChanges: runtimeExpectation.validationOnlyChanges || [],
    serviceRuntimeCommits,
  };
}

function runtimeExpectationForBranch(branch, expectedCommit) {
  const deployedCommits = [...new Set(Object.values(branch?.services || {})
    .map(deployedImageCommit)
    .filter((commit) => commit && commit !== expectedCommit))];
  const changedFilesByCommit = {};
  for (const deployedCommit of deployedCommits) {
    const diffResult = command('git', ['diff', '--name-only', `${deployedCommit}..${expectedCommit}`]);
    if (diffResult.status === 0) {
      changedFilesByCommit[deployedCommit] = String(diffResult.stdout || '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  const uniformDeployedCommit = deployedRuntimeCommit(branch);
  return resolveRuntimeExpectation(
    branch,
    expectedCommit,
    uniformDeployedCommit ? changedFilesByCommit[uniformDeployedCommit] || [] : [],
    changedFilesByCommit,
  );
}

function readCdsBranchStatus() {
  const branchIdResult = command('python3', ['.claude/skills/cds/cli/cdscli.py', 'branch-id']);
  const branchIdPayload = branchIdResult.status === 0 ? JSON.parse(String(branchIdResult.stdout || '{}')) : null;
  const branchId = branchIdPayload?.data?.branchId;
  if (!branchId) throw new Error('CDS 权威分支标识读取失败，拒绝在未知部署版本上开测');
  const statusResult = command('python3', ['.claude/skills/cds/cli/cdscli.py', 'branch', 'status', branchId]);
  const statusPayload = statusResult.status === 0 ? JSON.parse(String(statusResult.stdout || '{}')) : null;
  if (!statusPayload?.data) throw new Error('CDS 分支部署状态读取失败，拒绝在未知部署版本上开测');
  return statusPayload.data;
}

async function waitForCdsDeployment(expectedCommit, timeoutMs = 15 * 60 * 1000) {
  const startedAt = Date.now();
  let readiness = { ready: false, reasons: ['尚未检查'], versionId: '', commit: '' };
  while (Date.now() - startedAt < timeoutMs) {
    const branch = readCdsBranchStatus();
    readiness = evaluateCdsReadiness(branch, expectedCommit, runtimeExpectationForBranch(branch, expectedCommit));
    if (readiness.ready) return { ...readiness, waitedMs: Date.now() - startedAt };
    await delay(10_000);
  }
  throw new Error(`CDS 版本冻结等待超时：${readiness.reasons.join('；')}`);
}

function runPlaywright(environment, values, runDir, grep = '') {
  const prefix = environment === 'cds' ? 'STABLE_SMOKE_CDS' : 'STABLE_SMOKE_PROD';
  const resultPath = resolve(runDir, `${environment}-results.json`);
  const htmlPath = resolve(runDir, `${environment}-playwright-report`);
  const testResultPath = resolve(runDir, `${environment}-test-results`);
  const env = {
    ...process.env,
    ...values,
    E2E_BASE_URL: values[`${prefix}_BASE_URL`],
    STABLE_SMOKE_AI_ACCESS_KEY: values[`${prefix}_AI_ACCESS_KEY`],
    STABLE_SMOKE_USER: values[`${prefix}_USER`],
    STABLE_SMOKE_ENVIRONMENT: environment,
    STABLE_SMOKE_GW_BASE_URL: values[`${prefix}_GW_BASE_URL`] || '',
    STABLE_SMOKE_GW_USER: values[`${prefix}_GW_USER`] || '',
    STABLE_SMOKE_GW_PASSWORD: values[`${prefix}_GW_PASSWORD`] || '',
    STABLE_SMOKE_RUN_ID: values.STABLE_SMOKE_RUN_ID,
    STABLE_SMOKE_COMMIT: values.STABLE_SMOKE_COMMIT,
    STABLE_SMOKE_RUN: '1',
    STABLE_SMOKE_JSON_OUTPUT: resultPath,
    STABLE_SMOKE_HTML_OUTPUT: htmlPath,
    STABLE_SMOKE_TEST_OUTPUT: testResultPath,
  };
  const args = [
    '--dir', 'e2e', 'exec', 'playwright', 'test', 'specs/stable-smoke.spec.ts',
  ];
  if (grep) args.push('--grep', grep);
  const result = command('pnpm', args, { env, stdio: 'inherit', encoding: undefined });
  return { status: result.status ?? 1, resultPath, htmlPath, testResultPath };
}

export function buildExecutionRecord(environment, execution) {
  return {
    ...execution,
    environment,
    status: execution.status === 0 ? 'executed' : 'failed',
    missing: [],
  };
}

export function canReuseVisualPlan(plan, { runId, commit, environments }) {
  const expectedEnvironments = [...environments].sort();
  const actualEnvironments = Array.isArray(plan?.environments) ? [...plan.environments].sort() : [];
  return plan?.schemaVersion === '3.0'
    && String(plan.runId || '') === String(runId || '')
    && String(plan.commit || '') === String(commit || '')
    && Number.isFinite(Date.parse(String(plan.captureStartedAt || '')))
    && plan.slots?.length > 0
    && JSON.stringify(actualEnvironments) === JSON.stringify(expectedEnvironments);
}

export function enforceExecutionVerdict(summary, executions) {
  const executionFailures = executions
    .filter((execution) => execution.status === 'failed')
    .map((execution) => execution.environment);
  if (executionFailures.length === 0) return summary;
  return {
    ...summary,
    verdict: 'fail',
    executionFailures,
  };
}

export function evaluateProductionSafetyGate(cdsExecution, cdsRows = [], cdsWasFiltered = false) {
  const cleanupCaseIds = new Set(['COMMON-001', 'COMMON-004', 'REC-012', 'FILE-010', 'PARSE-008', 'VIDEO-010', 'LIT-010', 'VIS-010']);
  const hazardousFailures = cdsRows.filter((row) => {
    const attemptErrors = Array.isArray(row.attemptErrors) ? row.attemptErrors.join(' ') : '';
    const caseIds = String(row.caseId || '').match(/[A-Z]+-\d+/gi) || [];
    const isCleanupCase = caseIds.some((caseId) => cleanupCaseIds.has(caseId.toUpperCase()))
      || /清理|\bcleanup\b/i.test(String(row.title || ''));
    const isCleanupHazard = isCleanupCase || /\bP0\b|数据污染|清理失败|pollution/i.test(
      `${row.error || ''} ${attemptErrors}`,
    );
    return isCleanupHazard && (row.status === 'fail' || row.hadFailedAttempt === true || row.retryCount > 0);
  });
  const processFailed = !cdsExecution || !['executed', 'dry-run'].includes(cdsExecution.status);
  const restricted = cdsWasFiltered || processFailed || hazardousFailures.length > 0;
  return {
    restricted,
    mode: restricted ? 'read-only' : 'full',
    grep: restricted ? productionReadOnlyGrep : '',
    reasons: [
      ...(cdsWasFiltered ? ['CDS 仅执行了筛选用例，未满足正式环境写入所需的全量验证'] : []),
      ...(processFailed ? [`CDS 全量测试未完成（${cdsExecution?.status || 'missing'}）`] : []),
      ...hazardousFailures.map((row) => row.status === 'fail'
        ? `${row.caseId || '未编号用例'}：CDS 出现高危失败`
        : `${row.caseId || '未编号用例'}：CDS 清理类用例重试后通过，无法确认首次尝试未留下数据`),
    ],
  };
}

export function initializeProductionSafetyGate(selected) {
  if (selected.includes('production') && !selected.includes('cds')) {
    return {
      restricted: true,
      mode: 'read-only',
      grep: productionReadOnlyGrep,
      reasons: ['本轮未执行 CDS 全量测试，正式环境仅允许只读健康检查'],
    };
  }
  return { restricted: false, mode: 'full', grep: '', reasons: [] };
}

export function selectCoverageCaseIds(requiredCaseIds, userGrep, selected, productionSafetyGate) {
  const productionOnlyReadOnly = selected.length === 1
    && selected[0] === 'production'
    && productionSafetyGate.restricted;
  const effectiveGrep = productionOnlyReadOnly ? productionSafetyGate.grep : userGrep;
  return selectRequiredCaseIds(requiredCaseIds, effectiveGrep);
}

export function foldVisualGateVerdict(functionalVerdict, visualResult) {
  if (functionalVerdict === 'fail') return 'fail';
  if (visualResult?.verdict === '通过') return functionalVerdict;
  const statusCounts = visualResult?.statusCounts || {};
  return (statusCounts['不通过'] || 0) > 0 || (statusCounts['需干预'] || 0) > 0
    ? 'fail'
    : 'conditional';
}

export function extractArchivedReportUrl(output) {
  for (const line of String(output || '').split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.deeplink === 'string' && isHttpsReportUrl(parsed.deeplink)) return parsed.deeplink;
    } catch {
      // 归档脚本还会输出人类提示，只解析其中的 JSON 结果行。
    }
  }
  return '';
}

export function isHttpsReportUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function buildRunId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `stsmk-${stamp}-${suffix}`;
}

function readLooseArg(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : '';
  return value && !value.startsWith('--') ? value : fallback;
}

export function buildUnhandledFailureSummary({ runId, selected, reason, reportUrl = '' }) {
  return {
    runId,
    verdict: 'fail',
    phase: 'runner-exception',
    environments: selected,
    failure: {
      reason,
      recovery: '修复异常阶段后，使用相同 runId 重新执行稳定冒烟并核对新报告。',
    },
    archive: reportUrl
      ? { status: 'provided', reportUrl }
      : { status: 'unavailable', reportUrl: '', reason: '执行链异常发生在在线报告归档完成之前' },
    notification: { status: 'pending' },
  };
}

export async function deliverUnhandledFailure(argv, error) {
  const requestedRunId = readLooseArg(argv, '--run-id');
  const runId = /^[a-z0-9._-]+$/i.test(requestedRunId) ? requestedRunId : buildRunId();
  let outputRoot = resolve(readLooseArg(argv, '--output-root', defaultOutputRoot));
  let runDir = resolve(outputRoot, runId);
  const selected = argv.includes('--cds-only')
    ? ['cds']
    : argv.includes('--production-only')
      ? ['production']
      : ['cds', 'production'];
  const reason = error instanceof Error ? error.message : '未知执行异常';
  const providedReportUrl = '';
  const notificationCenterUrl = `${productionBaseUrl}/?panel=notifications`;
  const summaryDocument = buildUnhandledFailureSummary({
    runId,
    selected,
    reason,
    reportUrl: providedReportUrl,
  });

  try {
    mkdirSync(runDir, { recursive: true });
  } catch {
    outputRoot = resolve(defaultOutputRoot);
    runDir = resolve(outputRoot, runId);
    mkdirSync(runDir, { recursive: true });
  }
  const summaryPath = resolve(runDir, 'summary.json');
  if (argv.includes('--dry-run')) {
    summaryDocument.notification = { status: 'skipped', reason: 'dry-run 不发送通知' };
  } else {
    try {
      const envPath = resolve(readLooseArg(argv, '--env-file', resolve(repoRoot, '.env.stable-smoke.local')));
      let local = { loaded: false, values: {} };
      try {
        local = loadLocalEnvironment(envPath);
      } catch (credentialError) {
        summaryDocument.credentialWarning = credentialError instanceof Error
          ? credentialError.message
          : '本地凭据文件读取失败';
      }
      const registry = readJson(credentialRegistryPath) || {};
      const values = applyCredentialRegistry({ ...local.values, ...process.env }, registry, readKeychainSecret);
      const notification = command('node', [
        'scripts/stable-smoke-notify.mjs',
        '--verdict', 'fail',
        '--run-id', runId,
        '--environment', selected.map((item) => item === 'cds' ? 'CDS 环境' : '正式环境').join('、'),
        '--module', '稳定冒烟执行链',
        '--recovery', '稳定冒烟异常终止。请先处理执行摘要中的失败阶段，再使用相同 runId 重新执行并核对验收报告。',
        '--report-url', providedReportUrl || notificationCenterUrl,
        '--action-label', providedReportUrl ? '查看验收证据' : '打开通知中心',
      ], {
        env: {
          ...process.env,
          ...values,
          STABLE_SMOKE_NOTIFY_BASE_URL: values.STABLE_SMOKE_NOTIFY_BASE_URL || productionBaseUrl,
        },
      });
      summaryDocument.notification = notification.status === 0
        ? {
            status: 'sent',
            result: readJsonFromText(notification.stdout),
            actionUrl: providedReportUrl || notificationCenterUrl,
          }
        : {
            status: 'delivery-failed',
            error: String(notification.stderr || notification.stdout || 'MAP 通知发送失败').trim().slice(0, 500),
          };
    } catch (deliveryError) {
      summaryDocument.notification = {
        status: 'delivery-failed',
        error: deliveryError instanceof Error ? deliveryError.message : 'MAP 通知发送失败',
      };
    }
  }
  writeFileSync(summaryPath, `${JSON.stringify(summaryDocument, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ runId, runDir, verdict: 'fail', notification: summaryDocument.notification })}\n`);
  process.stderr.write(`稳定冒烟异常终止，失败摘要已保存：${reason}\n`);
  return { runDir, summaryPath, summary: summaryDocument };
}

export function buildLockedRunSummary({ runId, selected, reportUrl = '' }) {
  return {
    runId,
    verdict: 'conditional',
    phase: 'runner-locked',
    environments: selected,
    reason: '已有稳定冒烟正在运行，本次定时复测未重复启动。',
    recovery: '等待当前稳定冒烟结束并核对其验收报告；若当前任务没有完成，请使用本次 runId 补跑。',
    archive: reportUrl
      ? { status: 'provided', reportUrl }
      : {
          status: 'delegated-active-run',
          reportUrl: '',
          reason: '本次没有重复执行测试，验收证据由持有互斥锁的当前任务归档。',
        },
    notification: { status: 'pending' },
  };
}

export async function deliverLockedRun(argv, dependencies = {}) {
  const requestedRunId = readLooseArg(argv, '--run-id');
  const runId = /^[a-z0-9._-]+$/i.test(requestedRunId) ? requestedRunId : buildRunId();
  const outputRoot = resolve(readLooseArg(argv, '--output-root', defaultOutputRoot));
  const runDir = resolve(outputRoot, runId);
  const selected = argv.includes('--cds-only')
    ? ['cds']
    : argv.includes('--production-only')
      ? ['production']
      : ['cds', 'production'];
  const providedReportUrl = '';
  const notificationCenterUrl = `${productionBaseUrl}/?panel=notifications`;
  const summaryDocument = buildLockedRunSummary({ runId, selected, reportUrl: providedReportUrl });
  const commandFn = dependencies.commandFn || command;

  mkdirSync(runDir, { recursive: true });
  if (argv.includes('--dry-run')) {
    summaryDocument.notification = { status: 'skipped', reason: 'dry-run 不发送通知' };
  } else {
    try {
      const envPath = resolve(readLooseArg(argv, '--env-file', resolve(repoRoot, '.env.stable-smoke.local')));
      const local = dependencies.values
        ? { loaded: true, values: dependencies.values }
        : loadLocalEnvironment(envPath);
      const registry = readJson(credentialRegistryPath) || {};
      const values = applyCredentialRegistry(
        { ...local.values, ...process.env },
        registry,
        dependencies.secretReader || readKeychainSecret,
      );
      const actionUrl = providedReportUrl || notificationCenterUrl;
      const notification = commandFn('node', [
        'scripts/stable-smoke-notify.mjs',
        '--verdict', 'conditional',
        '--run-id', runId,
        '--environment', selected.map((item) => item === 'cds' ? 'CDS 环境' : '正式环境').join('、'),
        '--module', '稳定冒烟调度',
        '--recovery', summaryDocument.recovery,
        '--report-url', actionUrl,
        '--action-label', providedReportUrl ? '查看验收证据' : '打开通知中心',
      ], {
        env: {
          ...process.env,
          ...values,
          STABLE_SMOKE_NOTIFY_BASE_URL: values.STABLE_SMOKE_NOTIFY_BASE_URL || productionBaseUrl,
        },
      });
      summaryDocument.notification = notification.status === 0
        ? { status: 'sent', result: readJsonFromText(notification.stdout), actionUrl }
        : {
            status: 'delivery-failed',
            error: String(notification.stderr || notification.stdout || 'MAP 通知发送失败').trim().slice(0, 500),
          };
    } catch (deliveryError) {
      summaryDocument.notification = {
        status: 'delivery-failed',
        error: deliveryError instanceof Error ? deliveryError.message : 'MAP 通知发送失败',
      };
    }
  }
  if (summaryDocument.notification.status === 'delivery-failed') {
    summaryDocument.verdict = 'fail';
    summaryDocument.deliveryFailure = '重叠执行结果未能送达指定用户';
  }
  const summaryPath = resolve(runDir, 'summary.json');
  const blockedPath = resolve(runDir, 'blocked.json');
  const serialized = `${JSON.stringify(summaryDocument, null, 2)}\n`;
  writeFileSync(summaryPath, serialized, 'utf8');
  writeFileSync(blockedPath, serialized, 'utf8');
  process.stdout.write(`${JSON.stringify({
    runId,
    runDir,
    verdict: summaryDocument.verdict,
    archive: summaryDocument.archive,
    notification: summaryDocument.notification,
  })}\n`);
  return { runDir, summaryPath, blockedPath, summary: summaryDocument };
}

export function removeStaleLockIfSafe(lockPath) {
  if (!existsSync(lockPath)) return true;
  let observed;
  try {
    observed = statSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  const ageMs = Date.now() - observed.mtimeMs;
  let stale = ageMs > 3 * 60 * 60 * 1000;
  try {
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    // open('wx') 与写入 PID 之间存在极短窗口；新建的空文件必须先视为活锁，
    // 避免第二个执行器误删后并发进入写入型稳定冒烟。
    if (!Number.isInteger(pid) || pid <= 0) stale = ageMs > 30_000;
    else {
      try {
        process.kill(pid, 0);
        stale = false;
      } catch (error) {
        stale = error?.code === 'ESRCH';
      }
    }
  } catch {
    stale = ageMs > 30_000;
  }
  if (!stale) return false;
  try {
    const current = statSync(lockPath);
    if (current.dev !== observed.dev
      || current.ino !== observed.ino
      || current.mtimeMs !== observed.mtimeMs
      || current.size !== observed.size) return false;
    unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return true;
}

export function acquireLock(lockPath) {
  removeStaleLockIfSafe(lockPath);
  const candidatePath = `${lockPath}.${process.pid}.${randomUUID()}.candidate`;
  try {
    // 先完整写入候选文件，再以 hard link 原子发布锁；其他执行器永远看不到空锁。
    writeFileSync(candidatePath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    linkSync(candidatePath, lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    if (existsSync(candidatePath)) unlinkSync(candidatePath);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseRunnerArgs(argv);
  if (options.has('--help')) {
    process.stdout.write(runnerHelpText);
    return;
  }
  const runId = options.read('--run-id', buildRunId());
  const providedReportUrl = options.read('--report-url');
  if (providedReportUrl && !isHttpsReportUrl(providedReportUrl)) {
    throw new Error('验收报告地址必须是无内嵌凭据的 HTTPS 在线深链');
  }
  const outputRoot = resolve(options.read('--output-root', defaultOutputRoot));
  const runDir = resolve(outputRoot, runId);
  const envPath = resolve(options.read('--env-file', resolve(repoRoot, '.env.stable-smoke.local')));
  const lockPath = resolve(outputRoot, '.stable-smoke.lock');
  const selected = options.has('--cds-only')
    ? ['cds']
    : options.has('--production-only')
      ? ['production']
      : ['cds', 'production'];

  const local = loadLocalEnvironment(envPath);
  const registry = readJson(credentialRegistryPath) || {};
  const values = applyCredentialRegistry(
    { ...local.values, ...process.env, STABLE_SMOKE_RUN_ID: runId },
    registry,
    readKeychainSecret,
  );
  const preflightBlockers = [];
  const cdsAddressBlockers = [];
  if (selected.includes('cds')) {
    try {
      const cdsUrls = resolveCdsPreviewUrls(
        values.STABLE_SMOKE_CDS_BASE_URL || '',
        values.STABLE_SMOKE_CDS_GW_BASE_URL || '',
      );
      values.STABLE_SMOKE_CDS_BASE_URL = cdsUrls.appUrl;
      values.STABLE_SMOKE_CDS_GW_BASE_URL = cdsUrls.gatewayUrl;
    } catch (error) {
      cdsAddressBlockers.push(error instanceof Error ? error.message : 'CDS 预览地址读取失败');
      preflightBlockers.push(...cdsAddressBlockers);
    }
  }
  values.STABLE_SMOKE_PROD_BASE_URL = values.STABLE_SMOKE_PROD_BASE_URL || productionBaseUrl;
  for (const environment of selected) {
    const missing = validateEnvironmentConfig(environment, values);
    if (missing.length > 0) preflightBlockers.push(`${environment === 'cds' ? 'CDS 环境' : '正式环境'}缺少：${missing.join('、')}`);
  }
  if (options.has('--preflight')) {
    for (const environment of selected) {
      if (validateEnvironmentConfig(environment, values).length === 0) {
        preflightBlockers.push(...await validateEnvironmentIdentities(environment, values));
      }
    }
    if (selected.includes('cds')
      && cdsAddressBlockers.length === 0
      && validateEnvironmentConfig('cds', values).length === 0) {
      const commitResult = command('git', ['rev-parse', 'HEAD']);
      const expectedCommit = String(commitResult.stdout || '').trim();
      if (commitResult.status !== 0 || !expectedCommit) {
        preflightBlockers.push('无法读取待验收提交');
      } else {
        try {
          const branch = readCdsBranchStatus();
          const readiness = evaluateCdsReadiness(branch, expectedCommit, runtimeExpectationForBranch(branch, expectedCommit));
          preflightBlockers.push(...readiness.reasons);
        } catch (error) {
          preflightBlockers.push(error instanceof Error ? error.message : 'CDS 部署状态读取失败');
        }
      }
    }
    process.stdout.write(preflightBlockers.length === 0
      ? `预检通过：${selected.map((item) => item === 'cds' ? 'CDS 环境' : '正式环境').join('、')}可以开始稳定冒烟。\n`
      : `预检未通过，测试尚未启动：\n${preflightBlockers.map((item) => `- ${item}`).join('\n')}\n`);
    if (preflightBlockers.length > 0) process.exitCode = 2;
    return;
  }

  mkdirSync(outputRoot, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  if (options.has('--force-unlock') && !removeStaleLockIfSafe(lockPath)) {
    await deliverLockedRun(argv);
    process.exitCode = 2;
    return;
  }
  if (!acquireLock(lockPath)) {
    await deliverLockedRun(argv);
    process.exitCode = 2;
    return;
  }

  try {
    if (selected.includes('cds')) requireAuthoritativeCdsAddress(cdsAddressBlockers);
    if (selected.includes('cds')
      && !options.has('--dry-run')
      && cdsAddressBlockers.length === 0
      && validateEnvironmentConfig('cds', values).length === 0) {
      const commitResult = command('git', ['rev-parse', 'HEAD']);
      const expectedCommit = String(commitResult.stdout || '').trim();
      if (commitResult.status !== 0 || !expectedCommit) throw new Error('无法读取待验收提交，拒绝开测');
      const readiness = await waitForCdsDeployment(expectedCommit);
      writeFileSync(resolve(runDir, 'cds-readiness.json'), `${JSON.stringify({
        checkedAt: new Date().toISOString(),
        expectedCommit,
        ...readiness,
      }, null, 2)}\n`, 'utf8');
    }

    const planPath = resolve(runDir, 'plan.json');
    const planMarkdownPath = resolve(runDir, 'plan.md');
    const planResult = command('node', [
      'scripts/stable-smoke-plan.mjs', '--mode', 'scheduled',
      '--output-json', planPath, '--output-md', planMarkdownPath, '--strict',
    ]);
    if (planResult.status !== 0) throw new Error('稳定冒烟计划生成失败，请检查业务功能台账和未映射变更');
    const plan = readJson(planPath);
    values.STABLE_SMOKE_COMMIT = String(plan?.commit || '').trim();
    if (!values.STABLE_SMOKE_COMMIT) throw new Error('稳定冒烟计划缺少待验收提交，拒绝生成无版本绑定的视觉证据');

    const visualPlanPath = resolve(runDir, 'visual-plan.json');
    const visualPlanMarkdownPath = resolve(runDir, 'visual-plan.md');
    const existingVisualPlan = readJson(visualPlanPath);
    const reuseVisualPlan = existsSync(visualPlanMarkdownPath) && canReuseVisualPlan(existingVisualPlan, {
      runId,
      commit: values.STABLE_SMOKE_COMMIT,
      environments: selected,
    });
    const visualCaptureStartedAt = new Date().toISOString();
    const visualPlanResult = reuseVisualPlan ? { status: 0 } : command('node', [
      'scripts/stable-smoke-visual-plan.mjs',
      '--output-json', visualPlanPath,
      '--output-md', visualPlanMarkdownPath,
      '--environments', selected.join(','),
      '--run-id', runId,
      '--commit', values.STABLE_SMOKE_COMMIT,
      '--capture-started-at', visualCaptureStartedAt,
    ]);
    if (visualPlanResult.status !== 0) throw new Error('视觉取证计划生成失败，拒绝发布无逐项证据的报告');

    const executions = [];
    const grep = options.read('--grep');
    let productionSafetyGate = initializeProductionSafetyGate(selected);
    for (const environment of selected) {
      if (environment === 'production' && selected.includes('cds')) {
        const cdsExecution = executions.find((execution) => execution.environment === 'cds');
        const cdsRows = cdsExecution?.resultPath
          ? collectPlaywrightCases(readJson(cdsExecution.resultPath), 'cds')
          : [];
        productionSafetyGate = evaluateProductionSafetyGate(cdsExecution, cdsRows, Boolean(grep));
      }
      const errors = environment === 'production' && productionSafetyGate.restricted
        ? validateProductionReadOnlyConfig(values)
        : validateEnvironmentConfig(environment, values);
      if (errors.length > 0) {
        executions.push({
          environment,
          status: 'blocked',
          missing: errors,
          resultPath: '',
          policy: environment === 'production' ? productionSafetyGate.mode : 'full',
          gateReasons: environment === 'production' ? productionSafetyGate.reasons : [],
        });
        continue;
      }
      if (options.has('--dry-run')) {
        executions.push({ environment, status: 'dry-run', missing: [], resultPath: '' });
        continue;
      }
      const effectiveGrep = environment === 'production' && productionSafetyGate.restricted
        ? productionSafetyGate.grep
        : grep;
      const execution = runPlaywright(environment, values, runDir, effectiveGrep);
      executions.push({
        ...buildExecutionRecord(environment, execution),
        policy: environment === 'production' ? productionSafetyGate.mode : 'full',
        gateReasons: environment === 'production' ? productionSafetyGate.reasons : [],
      });
    }

    const environmentRows = executions.flatMap((execution) => {
      if (!execution.resultPath) return [];
      return collectPlaywrightCases(readJson(execution.resultPath), execution.environment);
    });
    const requiredCaseIds = selectCoverageCaseIds(
      plan?.requiredCaseIds || [],
      grep,
      selected,
      productionSafetyGate,
    );
    const rows = reconcileCaseCoverage(requiredCaseIds, environmentRows, selected);
    const coverageSummary = summarizeCoverage(rows, plan?.verdict || 'conditional');
    const functionalSummary = enforceExecutionVerdict(coverageSummary, executions);
    const requestedVisualManifest = options.read('--visual-manifest');
    const emptyVisualManifestPath = resolve(runDir, 'visual-manifest.json');
    const visualManifestPath = requestedVisualManifest && existsSync(resolve(requestedVisualManifest))
      ? resolve(requestedVisualManifest)
      : emptyVisualManifestPath;
    if (!existsSync(visualManifestPath)) writeFileSync(visualManifestPath, '[]\n', 'utf8');
    const visualGatePath = resolve(runDir, 'visual-gate.json');
    const visualGateMarkdownPath = resolve(runDir, 'visual-gate.md');
    const visualTechnicalPath = resolve(runDir, 'visual-technical-appendix.md');
    const visualGateExecution = command('node', [
      'scripts/stable-smoke-visual-gate.mjs',
      '--manifest', visualManifestPath,
      '--plan', visualPlanPath,
      '--output-json', visualGatePath,
      '--output-md', visualGateMarkdownPath,
      '--output-technical-md', visualTechnicalPath,
      '--environments', selected.join(','),
    ]);
    const visualResult = readJson(visualGatePath);
    if (!visualResult) throw new Error('视觉证据门禁未产生可读取结论');
    const summary = {
      ...functionalSummary,
      verdict: foldVisualGateVerdict(functionalSummary.verdict, visualResult),
      visual: {
        verdict: visualResult.verdict,
        screenshots: visualResult.screenshotCount,
        floor: visualResult.screenshotFloor,
        passedModules: visualResult.passedModules,
        modules: visualResult.modules?.length || 0,
        gateExitCode: visualGateExecution.status ?? 1,
        manifestPath: visualManifestPath,
        requestedManifestMissing: Boolean(requestedVisualManifest && !existsSync(resolve(requestedVisualManifest))),
      },
    };
    const summaryPath = resolve(runDir, 'summary.json');
    const summaryDocument = {
      runId,
      verdict: summary.verdict,
      catalogVersion: plan?.catalogVersion,
      commit: plan?.commit,
      envFileLoaded: local.loaded,
      executions,
      productionSafetyGate,
      coverage: summary,
      archive: { status: 'pending', reportUrl: '' },
      notification: { status: 'pending' },
    };
    writeFileSync(summaryPath, `${JSON.stringify(summaryDocument, null, 2)}\n`, 'utf8');

    const functionalReportPath = resolve(runDir, 'report.md');
    const functionalSupervisorPath = resolve(runDir, 'functional-supervisor-report.md');
    const renderArgs = [
      'scripts/render-stable-smoke-report.mjs',
      '--plan', planPath,
      '--cds-input', resolve(runDir, 'cds-results.json'),
      '--production-input', resolve(runDir, 'production-results.json'),
      '--output', functionalReportPath,
      '--supervisor-output', functionalSupervisorPath,
      '--technical-url', './technical-appendix.md',
      '--cds-url', values.STABLE_SMOKE_CDS_BASE_URL || '',
      '--production-url', productionBaseUrl,
      '--run-id', runId,
      '--base-url-configured', 'true',
      '--environments', selected.join(','),
      '--execution-summary', summaryPath,
    ];
    if (grep) renderArgs.push('--grep', grep);
    const render = command('node', renderArgs);
    if (render.status !== 0) throw new Error('稳定冒烟报告生成失败');

    const technicalPath = resolve(runDir, 'technical-appendix.md');
    writeFileSync(
      technicalPath,
      `${readFileSync(functionalReportPath, 'utf8').trim()}\n\n${readFileSync(visualTechnicalPath, 'utf8').trim()}\n`,
      'utf8',
    );
    const supervisorPath = resolve(runDir, 'supervisor-report.md');
    const compose = command('node', [
      'scripts/compose-stable-smoke-supervisor-report.mjs',
      '--functional', functionalSupervisorPath,
      '--visual', visualGateMarkdownPath,
      '--visual-gate', visualGateMarkdownPath,
      '--visual-plan', visualPlanMarkdownPath,
      '--technical-url', './technical-appendix.md',
      '--output', supervisorPath,
    ]);
    if (compose.status !== 0) throw new Error('功能与视觉主管报告合并失败');

    const archiveReportPath = resolve(runDir, 'archive-report.md');
    const prepareArchive = command('node', [
      'scripts/prepare-stable-smoke-archive-report.mjs',
      '--report', supervisorPath,
      '--manifest', visualManifestPath,
      '--output', archiveReportPath,
    ]);
    if (prepareArchive.status !== 0) throw new Error('验收归档报告准备失败');

    let reportUrl = providedReportUrl;
    if (reportUrl) {
      summaryDocument.archive = { status: 'provided', reportUrl };
    } else if (!options.has('--dry-run')) {
      const branchResult = command('git', ['branch', '--show-current']);
      const commitResult = command('git', ['rev-parse', 'HEAD']);
      const archive = command('python3', [
        '.claude/skills/create-visual-test-to-kb/scripts/archive_report.py',
        '--config', '.claude/skills/create-visual-test-to-kb/acceptance.config.json',
        '--target', `核心业务稳定冒烟 ${runId}`,
        '--report-kind', '发布验收',
        '--title-focus', '核心业务稳定冒烟',
        '--module', '稳定冒烟',
        '--type', '每48小时复测',
        '--folder-path', `稳定冒烟/${new Date().toISOString().slice(0, 7)}`,
        '--verdict', summary.verdict,
        '--tier', 'L2',
        '--report-md', archiveReportPath,
        '--manifest', visualManifestPath,
        '--branch', String(branchResult.stdout || '').trim(),
        '--commit', String(commitResult.stdout || '').trim(),
      ], { env: { ...process.env, ...values } });
      reportUrl = archive.status === 0 ? extractArchivedReportUrl(archive.stdout) : '';
      summaryDocument.archive = reportUrl
        ? { status: 'archived', reportUrl }
        : {
            status: 'failed',
            reportUrl: '',
            error: String(archive.stderr || archive.stdout || 'CDS 归档没有返回报告地址').trim().slice(0, 500),
          };
    } else {
      summaryDocument.archive = { status: 'skipped-dry-run', reportUrl: '' };
    }

    if (reportUrl && !options.has('--dry-run')) {
      const verifyOpen = command('node', buildReportVerificationArgs(
        reportUrl,
        runId,
        String(plan?.commit || ''),
        visualResult.screenshotCount,
      ), { env: { ...process.env, ...values } });
      if (verifyOpen.status === 0) {
        summaryDocument.archive.verifyOpen = 'passed';
      } else {
        summaryDocument.archive = {
          ...summaryDocument.archive,
          status: 'verification-failed',
          verifyOpen: 'failed',
          error: String(verifyOpen.stderr || verifyOpen.stdout || '归档报告打开验证失败').trim().slice(0, 500),
        };
        reportUrl = '';
      }
    }

    if (['failed', 'verification-failed'].includes(summaryDocument.archive.status)) {
      summaryDocument.notification = {
        status: 'delivery-failed',
        error: '验收报告在线归档失败，通知不得引用本地路径或不存在的证据地址',
      };
    } else if (summary.verdict === 'pass' || options.has('--dry-run')) {
      summaryDocument.notification = {
        status: 'skipped',
        reason: options.has('--dry-run') ? 'dry-run 不发送通知' : '通过只归档，不发送通知',
      };
    } else if (!reportUrl) {
      summaryDocument.notification = {
        status: 'delivery-failed',
        error: '验收报告尚未形成可访问的 HTTPS 归档地址，按通知契约拒绝发送无证据通知',
      };
    } else {
      const notification = command('node', [
        'scripts/stable-smoke-notify.mjs',
        '--verdict', summary.verdict,
        '--run-id', runId,
        '--environment', selected.map((item) => item === 'cds' ? 'CDS 环境' : '正式环境').join('、'),
        '--module', '整轮',
        '--recovery', '先处理主管报告中的失败、未执行和视觉缺证项，再按相同 runId 补跑并核对清理结果。',
        '--report-url', reportUrl,
      ], {
        env: {
          ...process.env,
          ...values,
          STABLE_SMOKE_NOTIFY_BASE_URL: values.STABLE_SMOKE_NOTIFY_BASE_URL || productionBaseUrl,
        },
      });
      summaryDocument.notification = notification.status === 0
        ? { status: 'sent', result: readJsonFromText(notification.stdout) }
        : {
            status: 'delivery-failed',
            error: String(notification.stderr || notification.stdout || 'MAP 通知发送失败').trim().slice(0, 500),
          };
    }
    if (summaryDocument.notification.status === 'delivery-failed') {
      summaryDocument.verdict = 'fail';
      summaryDocument.deliveryFailure = '非通过报告未能完成“在线归档后定向通知”的交付闭环';
    }
    writeFileSync(summaryPath, `${JSON.stringify(summaryDocument, null, 2)}\n`, 'utf8');

    process.stdout.write(`${JSON.stringify({
      runId,
      runDir,
      verdict: summaryDocument.verdict,
      coverage: summary,
      archive: summaryDocument.archive,
      notification: summaryDocument.notification,
    })}\n`);
    if (summaryDocument.verdict !== 'pass') process.exitCode = 2;
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // 锁文件已经不存在时无需处理。
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    await deliverUnhandledFailure(process.argv.slice(2), error);
    process.exitCode = 2;
  }
}
