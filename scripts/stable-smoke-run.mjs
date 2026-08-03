#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

function readArg(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
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

export function resolveCdsPreviewUrl(explicitUrl = '') {
  if (explicitUrl) return explicitUrl.replace(/\/+$/, '');
  const result = command('python3', ['.claude/skills/cds/cli/cdscli.py', '--human', 'preview-url']);
  if (result.status !== 0) throw new Error('CDS 权威预览地址读取失败，请修复项目凭据或部署状态后重试');
  const urls = String(result.stdout || '').match(/https:\/\/[^\s]+/g) || [];
  const appUrl = urls.find((url) => !/llmgw/i.test(url));
  if (!appUrl) throw new Error('CDS 未返回主应用预览地址，拒绝本地推算');
  return appUrl.replace(/\/+$/, '');
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
  const runId = readArg(argv, '--run-id', buildRunId());
  const outputRoot = resolve(readArg(argv, '--output-root', defaultOutputRoot));
  const runDir = resolve(outputRoot, runId);
  const envPath = resolve(readArg(argv, '--env-file', resolve(repoRoot, '.env.stable-smoke.local')));
  const lockPath = resolve(outputRoot, '.stable-smoke.lock');
  mkdirSync(outputRoot, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  if (argv.includes('--force-unlock') && existsSync(lockPath)) unlinkSync(lockPath);
  if (!acquireLock(lockPath)) {
    writeFileSync(resolve(runDir, 'blocked.json'), `${JSON.stringify({ verdict: 'conditional', reason: '已有稳定冒烟正在运行' }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const local = loadLocalEnvironment(envPath);
    const registry = readJson(credentialRegistryPath) || {};
    const values = applyCredentialRegistry(
      { ...local.values, ...process.env, STABLE_SMOKE_RUN_ID: runId },
      registry,
      readKeychainSecret,
    );
    values.STABLE_SMOKE_CDS_BASE_URL = resolveCdsPreviewUrl(values.STABLE_SMOKE_CDS_BASE_URL || '');
    values.STABLE_SMOKE_PROD_BASE_URL = values.STABLE_SMOKE_PROD_BASE_URL || productionBaseUrl;

    const planPath = resolve(runDir, 'plan.json');
    const planMarkdownPath = resolve(runDir, 'plan.md');
    const planResult = command('node', [
      'scripts/stable-smoke-plan.mjs', '--mode', 'scheduled',
      '--output-json', planPath, '--output-md', planMarkdownPath, '--strict',
    ]);
    if (planResult.status !== 0) throw new Error('稳定冒烟计划生成失败，请检查业务功能台账和未映射变更');
    const plan = readJson(planPath);

    const selected = argv.includes('--cds-only')
      ? ['cds']
      : argv.includes('--production-only')
        ? ['production']
        : ['cds', 'production'];
    const executions = [];
    const grep = readArg(argv, '--grep');
    for (const environment of selected) {
      const errors = validateEnvironmentConfig(environment, values);
      if (errors.length > 0) {
        executions.push({ environment, status: 'blocked', missing: errors, resultPath: '' });
        continue;
      }
      if (argv.includes('--dry-run')) {
        executions.push({ environment, status: 'dry-run', missing: [], resultPath: '' });
        continue;
      }
      const execution = runPlaywright(environment, values, runDir, grep);
      executions.push({ environment, status: execution.status === 0 ? 'executed' : 'failed', missing: [], ...execution });
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
  await main();
}
