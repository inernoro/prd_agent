import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  clearStableSmokeInfrastructureCircuit,
  probeStableSmokeReadiness,
  readStableSmokeInfrastructureCircuit,
  redactStableSmokeDiagnosticText,
  sanitizeStableSmokeArtifactTree,
  sanitizeStableSmokeTestInfo,
  stableSmokeDiagnosticIndicatesInfrastructureTimeout,
  stableSmokeReporterConfig,
  stableSmokeTraceMode,
  writeStableSmokeInfrastructureCircuit,
} from '../../e2e/utils/stableSmokeDiagnostics.mjs';

const secretSamples = [
  'Authorization: Bearer header.payload.signature',
  'X-AI-Access-Key: access-key-value',
  'X-Stable-Smoke-Signature: request-signature-value',
  'X-Stable-Smoke-Nonce: one-time-nonce',
  'Cookie: session=private-cookie',
  '"accessToken":"short-lived-token"',
  '"refreshToken":"refresh-secret"',
  '"privateKey":"private-key-value"',
  '"code":"one-time-body-code"',
  'https://example.test/synthetic-login#code=one-time-code',
  '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----',
];

test('稳定冒烟诊断脱敏保留端点与状态并移除全部凭据形态', () => {
  const source = `apiRequestContext.post: Timeout 30000ms exceeded\nPOST /api/v1/auth/synthetic/ticket\nHTTP 504\n${secretSamples.join('\n')}`;
  const output = redactStableSmokeDiagnosticText(source);
  assert.match(output, /POST \/api\/v1\/auth\/synthetic\/ticket/);
  assert.match(output, /HTTP 504/);
  assert.match(output, /\[REDACTED\]/);
  for (const value of ['header.payload.signature', 'access-key-value', 'request-signature-value', 'one-time-nonce', 'private-cookie', 'short-lived-token', 'refresh-secret', 'private-key-value', 'one-time-body-code', 'one-time-code', 'private-material']) {
    assert.doesNotMatch(output, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(redactStableSmokeDiagnosticText('{"code":"AUTH_DENIED"}'), '{"code":"AUTH_DENIED"}');
});

test('Playwright 错误对象会在 reporter 读取前原地脱敏', () => {
  const info = { errors: [{ message: secretSamples[0], stack: secretSamples[2], snippet: secretSamples[5] }] };
  sanitizeStableSmokeTestInfo(info);
  assert.deepEqual(Object.values(info.errors[0]).every((value) => String(value).includes('[REDACTED]')), true);
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
    writeFileSync(resolve(directory, 'video.webm'), secretSamples[5]);
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

test('仅 API 网络故障打开环境熔断，普通页面等待超时不误判', async () => {
  assert.equal(stableSmokeDiagnosticIndicatesInfrastructureTimeout('apiRequestContext.get: Timeout 10000ms exceeded'), true);
  assert.equal(stableSmokeDiagnosticIndicatesInfrastructureTimeout('locator.click: Timeout 10000ms exceeded'), false);
  assert.equal(await probeStableSmokeReadiness({ get: async () => ({ ok: () => true }) }, 5), true);
  assert.equal(await probeStableSmokeReadiness({ get: async () => { throw new Error('socket hang up'); } }, 5), false);
});

test('环境熔断状态跨 Playwright worker 重启持久化并可在恢复后清除', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stsmk-circuit-'));
  try {
    const circuit = { reason: '环境未恢复', lastProbeAt: 123 };
    writeStableSmokeInfrastructureCircuit(directory, circuit);
    assert.deepEqual(readStableSmokeInfrastructureCircuit(directory), circuit);
    clearStableSmokeInfrastructureCircuit(directory);
    assert.equal(readStableSmokeInfrastructureCircuit(directory), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
