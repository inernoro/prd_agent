#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  collectPlaywrightCases,
  reconcileCaseCoverage,
  summarizeCoverage,
} from './stable-smoke-results.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const defaultOutputRoot = '/tmp/prd-agent-stable-smoke';
const productionBaseUrl = 'https://map.ebcone.net';
const credentialRegistryPath = resolve(repoRoot, '.claude/skills/stable-smoke/reference/credential-registry.json');

const valueOptions = new Set(['--run-id', '--output-root', '--env-file', '--grep']);
const flagOptions = new Set(['--force-unlock', '--cds-only', '--production-only', '--dry-run', '--preflight', '--help']);

export const runnerHelpText = `稳定冒烟本地运行器

用法：
  node scripts/stable-smoke-run.mjs [选项]

选项：
  --preflight          只检查双环境地址、身份和 CDS 部署状态，不启动测试
  --cds-only           只运行 CDS 环境
  --production-only    只运行正式环境
  --dry-run            生成计划并检查凭据，不执行业务旅程
  --run-id <值>        指定本轮稳定冒烟标识
  --output-root <路径> 指定本地产物目录
  --env-file <路径>    指定本地凭据兼容文件
  --grep <表达式>      只运行匹配的 Playwright 用例
  --force-unlock       清理遗留互斥锁后运行
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

export function resolveCdsPreviewUrls(explicitUrl = '', explicitGatewayUrl = '') {
  if (explicitUrl && explicitGatewayUrl) {
    return {
      appUrl: explicitUrl.replace(/\/+$/, ''),
      gatewayUrl: explicitGatewayUrl.replace(/\/+$/, ''),
    };
  }
  const result = command('python3', ['.claude/skills/cds/cli/cdscli.py', '--human', 'preview-url']);
  if (result.status !== 0) throw new Error('CDS 权威预览地址读取失败，请修复项目凭据或部署状态后重试');
  const urls = String(result.stdout || '').match(/https:\/\/[^\s]+/g) || [];
  const appUrl = urls.find((url) => !/llmgw/i.test(url));
  const gatewayUrl = urls.find((url) => /llmgw/i.test(url));
  if (!appUrl) throw new Error('CDS 未返回主应用预览地址，拒绝本地推算');
  if (!gatewayUrl) throw new Error('CDS 未返回模型网关预览地址，拒绝本地推算');
  return {
    appUrl: (explicitUrl || appUrl).replace(/\/+$/, ''),
    gatewayUrl: (explicitGatewayUrl || gatewayUrl).replace(/\/+$/, ''),
  };
}

export function validateEnvironmentConfig(name, values) {
  const prefix = name === 'cds' ? 'STABLE_SMOKE_CDS' : 'STABLE_SMOKE_PROD';
  const errors = [];
  if (!values[`${prefix}_BASE_URL`]) errors.push(`${prefix}_BASE_URL`);
  if (!values[`${prefix}_AI_ACCESS_KEY`]) errors.push(`${prefix}_AI_ACCESS_KEY`);
  if (!values[`${prefix}_USER`]) errors.push(`${prefix}_USER`);
  if (name === 'production' && values[`${prefix}_BASE_URL`]?.replace(/\/+$/, '') !== productionBaseUrl) {
    errors.push('正式环境地址必须固定为 https://map.ebcone.net');
  }
  return errors;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function evaluateCdsReadiness(branch, expectedCommit) {
  const reasons = [];
  const services = Object.values(branch?.services || {});
  if (branch?.status !== 'running') reasons.push(`分支状态为 ${branch?.status || 'unknown'}`);
  if (branch?.commitSha !== expectedCommit) reasons.push('CDS 分支提交尚未同步到本地目标提交');
  if (branch?.ciTargetSha !== expectedCommit) reasons.push('CDS 镜像目标尚未锁定本地目标提交');
  if (branch?.ciImageStatus !== 'ready') reasons.push(`CDS 镜像状态为 ${branch?.ciImageStatus || 'unknown'}`);
  if (branch?.lastDeployDispatchCommitSha !== expectedCommit) reasons.push('CDS 尚未对目标提交完成部署调度');
  if (branch?.deployRuntime?.drift?.hasDrift) reasons.push('CDS 服务存在版本漂移');
  if (services.length === 0) reasons.push('CDS 未返回任何业务服务');
  for (const service of services) {
    const serviceName = service.profileId || service.containerName || '未知服务';
    if (service.status !== 'running') reasons.push(`${serviceName} 未运行`);
    if (!String(service.deployedImage || '').endsWith(`:sha-${expectedCommit}`)) {
      reasons.push(`${serviceName} 尚未切换到目标镜像`);
    }
  }
  return {
    ready: reasons.length === 0,
    reasons: [...new Set(reasons)],
    versionId: branch?.currentVersionId || '',
    commit: branch?.commitSha || '',
  };
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
    readiness = evaluateCdsReadiness(readCdsBranchStatus(), expectedCommit);
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

function buildRunId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `stsmk-${stamp}-${suffix}`;
}

function acquireLock(lockPath) {
  if (existsSync(lockPath)) {
    let stale = Date.now() - statSync(lockPath).mtimeMs > 3 * 60 * 60 * 1000;
    try {
      const pid = Number(readFileSync(lockPath, 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 0) stale = true;
      else {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error?.code === 'ESRCH') stale = true;
        }
      }
    } catch {
      stale = true;
    }
    if (stale) unlinkSync(lockPath);
  }
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, `${process.pid}\n`, 'utf8');
    closeSync(fd);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
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
    if (selected.includes('cds')
      && cdsAddressBlockers.length === 0
      && validateEnvironmentConfig('cds', values).length === 0) {
      const commitResult = command('git', ['rev-parse', 'HEAD']);
      const expectedCommit = String(commitResult.stdout || '').trim();
      if (commitResult.status !== 0 || !expectedCommit) {
        preflightBlockers.push('无法读取待验收提交');
      } else {
        try {
          const readiness = evaluateCdsReadiness(readCdsBranchStatus(), expectedCommit);
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
  if (options.has('--force-unlock') && existsSync(lockPath)) unlinkSync(lockPath);
  if (!acquireLock(lockPath)) {
    writeFileSync(resolve(runDir, 'blocked.json'), `${JSON.stringify({ verdict: 'conditional', reason: '已有稳定冒烟正在运行' }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  try {
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

    const executions = [];
    const grep = options.read('--grep');
    for (const environment of selected) {
      const errors = validateEnvironmentConfig(environment, values);
      if (errors.length > 0) {
        executions.push({ environment, status: 'blocked', missing: errors, resultPath: '' });
        continue;
      }
      if (options.has('--dry-run')) {
        executions.push({ environment, status: 'dry-run', missing: [], resultPath: '' });
        continue;
      }
      const execution = runPlaywright(environment, values, runDir, grep);
      executions.push(buildExecutionRecord(environment, execution));
    }

    const environmentRows = executions.flatMap((execution) => {
      if (!execution.resultPath) return [];
      return collectPlaywrightCases(readJson(execution.resultPath), execution.environment);
    });
    const rows = reconcileCaseCoverage(plan?.requiredCaseIds || [], environmentRows);
    const summary = summarizeCoverage(rows, plan?.verdict || 'conditional');
    writeFileSync(resolve(runDir, 'summary.json'), `${JSON.stringify({
      runId,
      verdict: summary.verdict,
      catalogVersion: plan?.catalogVersion,
      commit: plan?.commit,
      envFileLoaded: local.loaded,
      executions,
      coverage: summary,
    }, null, 2)}\n`, 'utf8');

    const render = command('node', [
      'scripts/render-stable-smoke-report.mjs',
      '--plan', planPath,
      '--cds-input', resolve(runDir, 'cds-results.json'),
      '--production-input', resolve(runDir, 'production-results.json'),
      '--output', resolve(runDir, 'report.md'),
      '--run-id', runId,
      '--base-url-configured', 'true',
    ]);
    if (render.status !== 0) throw new Error('稳定冒烟报告生成失败');

    process.stdout.write(`${JSON.stringify({ runId, runDir, verdict: summary.verdict, coverage: summary })}\n`);
    if (summary.verdict !== 'pass') process.exitCode = 2;
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
    process.stderr.write(`稳定冒烟未启动：${error instanceof Error ? error.message : '未知错误'}\n`);
    process.exitCode = 2;
  }
}
