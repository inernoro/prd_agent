import assert from 'node:assert/strict';
import { buildPlan, loadCatalog, selectFeatureLines } from '../stable-smoke-plan.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  redactStableSmokeDiagnosticText,
  sanitizeStableSmokeArtifactTree,
  sanitizeStableSmokeTestInfo,
  stableSmokeReporterConfig,
  stableSmokeTraceMode,
} from '../../e2e/utils/stableSmokeDiagnostics.mjs';

const secretSamples = [
  'Authorization: Bearer header.payload.signature',
  'X-AI-Access-Key: access-key-value',
  'X-Stable-Smoke-Signature: request-signature-value',
  'X-Stable-Smoke-Nonce: one-time-nonce',
  'Cookie: theme=dark; session=private-cookie; csrf=private-csrf',
  '"set-cookie":"session=private-set-cookie; Path=/; HttpOnly", "status":401',
  '"authorization":"Bearer pa\\\"ssHEADERSECRET"',
  '"accessToken":"short-lived-token"',
  '"refreshToken":"refresh-secret"',
  '"privateKey":"private-key-value"',
  '"password":"pa\'ssSECRET"',
  '"aiAccessKey":"key\\\"suffixSECRET"',
  '"code":"one-time-body-code"',
  'https://example.test/synthetic-login#code=one-time-code',
  '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----',
];

test('[REG-stsmk-diagnostic-api-key-001] 诊断源码改动必须进入巡检且真实签发只在 CDS 执行', () => {
  const catalog = loadCatalog();
  const changedFiles = ['e2e/utils/stableSmokeDiagnostics.mjs'];
  const selection = selectFeatureLines(catalog, changedFiles, [], 'changed');
  assert.deepEqual(selection.unmappedFiles, []);
  assert.ok(selection.selected.some((feature) => feature.id === 'stability-foundation'));
  const caseId = 'REG-stsmk-diagnostic-api-key-001';
  for (const scope of [{ mode: 'changed', profile: 'full' }, { mode: 'scheduled', profile: 'routine' }]) {
    const plan = buildPlan({ catalog, changedFiles, activeRegressions: [caseId], ...scope,
      pools: { defects: [] }, commit: 'diagnostic-consumer-guard' });
    assert.ok(plan.requiredCaseIdsByEnvironment.cds.includes(caseId), `${scope.mode}/${scope.profile} 不得漏掉诊断安全回归`);
    assert.ok(!plan.requiredCaseIdsByEnvironment.production.includes(caseId), '不得在正式主动签发凭据');
  }
});

test('稳定冒烟诊断脱敏保留端点与状态并移除全部凭据形态', () => {
  const source = `apiRequestContext.post: Timeout 30000ms exceeded\nPOST /api/v1/auth/synthetic/ticket\nHTTP 504\n${secretSamples.join('\n')}`;
  const output = redactStableSmokeDiagnosticText(source);
  assert.match(output, /POST \/api\/v1\/auth\/synthetic\/ticket/);
  assert.match(output, /HTTP 504/);
  assert.match(output, /\[REDACTED\]/);
  for (const value of ['header.payload.signature', 'access-key-value', 'request-signature-value', 'one-time-nonce', 'private-cookie', 'private-csrf', 'private-set-cookie', 'ssHEADERSECRET', 'short-lived-token', 'refresh-secret', 'private-key-value', "pa'ssSECRET", 'suffixSECRET', 'one-time-body-code', 'one-time-code', 'private-material']) {
    assert.doesNotMatch(output, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(redactStableSmokeDiagnosticText('{"code":"AUTH_DENIED"}'), '{"code":"AUTH_DENIED"}');
  assert.equal(
    redactStableSmokeDiagnosticText('{"cookie":"a=1; session=secret", "status":401}'),
    '{"cookie":"[REDACTED]", "status":401}',
  );
});

test('Playwright 错误对象会在 reporter 读取前原地脱敏', () => {
  const info = { errors: [{ message: secretSamples[0], stack: secretSamples[2], snippet: secretSamples[5] }] };
  sanitizeStableSmokeTestInfo(info);
  assert.deepEqual(Object.values(info.errors[0]).every((value) => String(value).includes('[REDACTED]')), true);
});

test('真实 Playwright 失败经 afterEach 后，list 和 JSON reporter 均不泄漏无权限假密钥', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stsmk-reporter-contract-'));
  const e2e = resolve(import.meta.dirname, '../../e2e');
  const diagnostics = pathToFileURL(resolve(e2e, 'utils/stableSmokeDiagnostics.mjs')).href;
  // 正式脚本检查已安装 CDS 的 playwright；独立执行时可复用 e2e 的同一测试运行器。
  // 两处都未安装必须失败，不能 skip 后冒充 reporter 走通。
  let runner;
  let testModule;
  try {
    const require = createRequire(resolve(e2e, '../cds/package.json'));
    runner = resolve(dirname(require.resolve('playwright/package.json')), 'cli.js');
    testModule = require.resolve('playwright/test');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    const require = createRequire(resolve(e2e, 'package.json'));
    runner = require.resolve('@playwright/test/cli');
    testModule = require.resolve('@playwright/test');
  }
  const playwright = pathToFileURL(testModule).href;
  const jsonOutput = resolve(directory, 'results.json');
  const canary = 'no-permission-reporter-canary-only';
  try {
    writeFileSync(resolve(directory, 'canary.spec.mjs'), `
import playwright from ${JSON.stringify(playwright)};
const { test, expect } = playwright;
import { sanitizeStableSmokeTestInfo } from ${JSON.stringify(diagnostics)};
test.afterEach(({}, info) => sanitizeStableSmokeTestInfo(info));
test('controlled reporter failure without any browser or network', () => {
  const response = { endpoint: '/api/agent-api-keys', status: 503,
    data: { item: { id: 'public-test-key-id' }, apiKey: process.env.DIAGNOSTIC_CANARY } };
  expect(response).toEqual({ success: true });
});
`);
    writeFileSync(resolve(directory, 'playwright.config.mjs'), `
import { stableSmokeReporterConfig, stableSmokeTraceMode } from ${JSON.stringify(diagnostics)};
export default { testDir: ${JSON.stringify(directory)}, testMatch: 'canary.spec.mjs',
  outputDir: ${JSON.stringify(resolve(directory, 'artifacts'))}, retries: 0, workers: 1,
  reporter: stableSmokeReporterConfig({ jsonOutput: ${JSON.stringify(jsonOutput)}, stableRun: true }),
  use: { trace: stableSmokeTraceMode(true), video: 'off', screenshot: 'off' } };
`);
    const child = spawnSync(process.execPath,
      [runner, 'test', '--config', resolve(directory, 'playwright.config.mjs')],
      { cwd: directory, encoding: 'utf8', timeout: 30_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1', NO_COLOR: '1', DIAGNOSTIC_CANARY: canary } });
    assert.ifError(child.error);
    assert.equal(child.status, 1, '子进程应只有那一条故意失败，不得用空跑或跳过冒通过');
    const stdout = child.stdout + child.stderr;
    const json = readFileSync(jsonOutput, 'utf8');
    const result = JSON.parse(json);
    assert.equal(result.stats.unexpected, 1, JSON.stringify(result.errors));
    assert.equal(result.stats.skipped, 0);
    for (const retained of [stdout, json]) {
      assert.ok(!retained.includes(canary), '真实 reporter 输出中不能包含假密钥明文');
      assert.match(retained, /\[REDACTED\]/);
      assert.match(retained, /public-test-key-id/);
      assert.match(retained, /agent-api-keys/);
      assert.match(retained, /503/);
    }
    const scan = sanitizeStableSmokeArtifactTree(directory);
    assert.ok(scan.scanned >= 1);
    assert.equal(scan.changed, 0, 'reporter 产物应在写出前已脱敏，不能靠事后扫描补救');
    assert.deepEqual(sanitizeStableSmokeArtifactTree(directory), scan);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('REG-stsmk-diagnostic-api-key-001：真实签发响应字段和有限别名均脱敏且保留业务标识', () => {
  for (const name of ['apiKey', 'APIKEY', 'api_key', 'api-key']) {
    const response = { success: true, data: { item: { id: 'test-key-id' }, [name]: 'issued-api-key-marker' }, error: null };
    const output = redactStableSmokeDiagnosticText(JSON.stringify(response));
    assert.doesNotMatch(output, /issued-api-key-marker/);
    const decoded = JSON.parse(output);
    assert.equal(decoded.data[name], '[REDACTED]');
    assert.equal(decoded.data.item.id, 'test-key-id');
    assert.equal(decoded.success, true);
  }
  assert.equal(
    redactStableSmokeDiagnosticText('{ apiKey: \'object-dump-key-marker\', apiKeyId: \'public-key-id\' }'),
    '{ apiKey: \'[REDACTED]\', apiKeyId: \'public-key-id\' }',
  );
  assert.equal(redactStableSmokeDiagnosticText('api_key=assignment-key-marker'), 'api_key=[REDACTED]');
});

test('REG-stsmk-diagnostic-api-key-001：错误对象的真实响应数据在 reporter 序列化前脱敏', () => {
  const issued = { item: { id: 'test-key-id' }, apiKey: 'issued-api-key-marker', apiKeyId: 'public-key-id' };
  const info = { errors: [{ message: `签发响应与预期不符：${JSON.stringify(issued)}`, actual: { data: issued } }] };
  sanitizeStableSmokeTestInfo(info);
  assert.doesNotMatch(JSON.stringify(info), /issued-api-key-marker/);
  assert.equal(info.errors[0].actual.data.apiKey, '[REDACTED]');
  assert.equal(info.errors[0].actual.data.apiKeyId, 'public-key-id');
});

test('REG-stsmk-diagnostic-api-key-001：保留产物覆盖原始响应和 reporter 转义后的 JSON', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stsmk-api-key-redact-'));
  try {
    const issued = { item: { id: 'test-key-id' }, apiKey: 'issued-api-key-marker', apiKeyId: 'public-key-id' };
    writeFileSync(resolve(directory, 'response.json'), JSON.stringify({ success: true, data: issued }));
    writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ errors: [{ message: `响应：${JSON.stringify(issued)}` }] }));
    writeFileSync(resolve(directory, 'error-context.md'), `{ apiKey: 'issued-api-key-marker', apiKeyId: 'public-key-id' }`);
    writeFileSync(resolve(directory, 'worker.log'), 'api_key=issued-api-key-marker HTTP 503 /api/agent-api-keys');
    const result = sanitizeStableSmokeArtifactTree(directory);
    assert.deepEqual(result, { scanned: 4, changed: 4 });
    for (const name of ['response.json', 'results.json', 'error-context.md', 'worker.log']) {
      assert.doesNotMatch(readFileSync(resolve(directory, name), 'utf8'), /issued-api-key-marker/);
    }
    const persisted = JSON.parse(readFileSync(resolve(directory, 'response.json'), 'utf8'));
    assert.equal(persisted.data.item.id, 'test-key-id');
    assert.equal(persisted.data.apiKeyId, 'public-key-id');
    assert.equal(persisted.success, true);
    assert.match(readFileSync(resolve(directory, 'worker.log'), 'utf8'), /HTTP 503 \/api\/agent-api-keys/);
    assert.deepEqual(sanitizeStableSmokeArtifactTree(directory), { scanned: 4, changed: 0 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('REG-stsmk-diagnostic-api-key-001：中断截断的真实 reporter 转义层仍脱敏', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stsmk-api-key-truncated-'));
  try {
    const issued = { headers: { authorization: 'Bearer truncated-header-marker', 'x-ai-access-key': 'truncated-access-marker' },
      item: { id: 'test-key-id' }, apiKey: 'issued-api-key-marker' };
    const reporter = JSON.stringify({ errors: [{ message: 'HTTP 503 /api/agent-api-keys 响应：' + JSON.stringify(issued) }] });
    const samples = [
      reporter.slice(0, -2),
      reporter.slice(0, reporter.indexOf('issued-api-key-marker') + 'issued-api-key-marker'.length),
    ];
    for (const [index, sample] of samples.entries()) writeFileSync(resolve(directory, index + '.json'), sample);
    assert.deepEqual(sanitizeStableSmokeArtifactTree(directory), { scanned: 2, changed: 2 });
    for (const index of [0, 1]) {
      const retained = readFileSync(resolve(directory, index + '.json'), 'utf8');
      assert.doesNotMatch(retained, /issued-api-key-marker/);
      assert.doesNotMatch(retained, /truncated-header-marker|truncated-access-marker/);
      assert.match(retained, /\[REDACTED\]/);
      assert.match(retained, /test-key-id/);
      assert.match(retained, /HTTP 503 \/api\/agent-api-keys/);
    }
    assert.deepEqual(sanitizeStableSmokeArtifactTree(directory), { scanned: 2, changed: 0 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('稳定冒烟不生成 HTML 网络归档且关闭 trace', () => {
  assert.deepEqual(stableSmokeReporterConfig({ jsonOutput: '/tmp/results.json', htmlOutput: '/tmp/report', stableRun: true }), [
    ['list', {}],
    ['json', { outputFile: '/tmp/results.json' }],
  ]);
  assert.equal(stableSmokeTraceMode(true), 'off');
  assert.equal(stableSmokeTraceMode(false), 'on-first-retry');
});

test('产物树脱敏覆盖 JSON、Markdown 与日志且不改二进制文件', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stsmk-redact-'));
  try {
    writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ error: secretSamples[0] }));
    writeFileSync(resolve(directory, 'error-context.md'), secretSamples[2]);
    writeFileSync(resolve(directory, 'video.webm'), secretSamples[7]);
    const result = sanitizeStableSmokeArtifactTree(directory);
    assert.equal(result.scanned, 2);
    assert.equal(result.changed, 2);
    assert.doesNotMatch(readFileSync(resolve(directory, 'results.json'), 'utf8'), /header\.payload\.signature/);
    assert.doesNotMatch(readFileSync(resolve(directory, 'error-context.md'), 'utf8'), /request-signature-value/);
    assert.match(readFileSync(resolve(directory, 'video.webm'), 'utf8'), /short-lived-token/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
