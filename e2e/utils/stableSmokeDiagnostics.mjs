import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const redacted = '[REDACTED]';
const sensitiveHeaderNames = [
  'authorization',
  'proxy-authorization',
  'x-ai-access-key',
  'x-stable-smoke-signature',
  'x-stable-smoke-nonce',
  'cookie',
  'set-cookie',
];
const sensitiveValueNames = [
  'accessToken',
  'refreshToken',
  'token',
  'password',
  'privateKey',
  'signingPrivateKey',
  'aiAccessKey',
  'ticket',
];
const textArtifactExtensions = new Set(['.json', '.md', '.txt', '.log', '.xml', '.trx']);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactStableSmokeDiagnosticText(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  let output = value;
  output = output.replace(
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
    redacted,
  );
  const headerPattern = sensitiveHeaderNames.map(escapeRegExp).join('|');
  output = output.replace(
    new RegExp(`(["']?(?:${headerPattern})["']?\\s*[:=]\\s*["']?)(?:Bearer\\s+)?([^"'\\s,}\\]\\r\\n]+)`, 'gi'),
    `$1${redacted}`,
  );
  const valuePattern = sensitiveValueNames.map(escapeRegExp).join('|');
  output = output.replace(
    new RegExp(`(["'](?:${valuePattern})["']\\s*:\\s*["'])([^"']+)(["'])`, 'gi'),
    `$1${redacted}$3`,
  );
  output = output.replace(
    /(["']code["']\s*:\s*["'])([^"']+)(["'])/gi,
    (match, prefix, code, suffix) => (/^[A-Z][A-Z0-9_]{2,}$/.test(code) ? match : `${prefix}${redacted}${suffix}`),
  );
  output = output.replace(
    new RegExp(`(\\b(?:${valuePattern})\\b\\s*=\\s*)([^\\s&"'<>]+)`, 'gi'),
    `$1${redacted}`,
  );
  output = output.replace(
    /([?#&](?:code|token|ticket|access_token|refresh_token)=)[^&\s"'<>]+/gi,
    `$1${redacted}`,
  );
  return output;
}

function redactMutable(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const key of Object.keys(value)) {
    try {
      if (typeof value[key] === 'string') value[key] = redactStableSmokeDiagnosticText(value[key]);
      else redactMutable(value[key], seen);
    } catch {
      // Playwright 未来若把某个诊断字段改为只读，继续清理其余可写字段。
    }
  }
}

export function sanitizeStableSmokeTestInfo(testInfo) {
  for (const error of testInfo?.errors || []) redactMutable(error);
}

export function stableSmokeDiagnosticIndicatesInfrastructureTimeout(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  return /apiRequestContext\.(?:get|post|put|patch|delete|fetch):\s*Timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|SSL_ERROR_SYSCALL|network socket disconnected/i.test(text);
}

export async function probeStableSmokeReadiness(request, timeoutMs = 20_000) {
  try {
    const response = await request.get('/api/health/ready', { timeout: timeoutMs, failOnStatusCode: false });
    if (!response.ok()) return false;
    const body = await response.json();
    return body?.status === 'healthy'
      && Array.isArray(body.components)
      && body.components.length > 0
      && body.components.every((component) => component?.ready === true);
  } catch {
    return false;
  }
}

function stableSmokeCircuitPath(outputDirectory) {
  return resolve(outputDirectory, 'infrastructure-circuit.json');
}

export function readStableSmokeInfrastructureCircuit(outputDirectory) {
  const path = stableSmokeCircuitPath(outputDirectory);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value?.reason !== 'string' || typeof value?.lastProbeAt !== 'number') return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function writeStableSmokeInfrastructureCircuit(outputDirectory, circuit) {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(stableSmokeCircuitPath(outputDirectory), `${JSON.stringify(circuit)}\n`, 'utf8');
}

export function clearStableSmokeInfrastructureCircuit(outputDirectory) {
  rmSync(stableSmokeCircuitPath(outputDirectory), { force: true });
}

export function stableSmokeReporterConfig({ jsonOutput, htmlOutput, stableRun }) {
  if (!jsonOutput) return undefined;
  const reporters = [
    ['list', {}],
    ['json', { outputFile: jsonOutput }],
  ];
  if (!stableRun) reporters.push(['html', { open: 'never', outputFolder: htmlOutput }]);
  return reporters;
}

export function stableSmokeTraceMode(stableRun) {
  return stableRun ? 'off' : 'on-first-retry';
}

export function sanitizeStableSmokeArtifactFile(path) {
  if (!existsSync(path) || !statSync(path).isFile() || !textArtifactExtensions.has(extname(path).toLowerCase())) {
    return { scanned: 0, changed: 0 };
  }
  const original = readFileSync(path, 'utf8');
  const sanitized = redactStableSmokeDiagnosticText(original);
  if (sanitized === original) return { scanned: 1, changed: 0 };
  writeFileSync(path, sanitized, 'utf8');
  return { scanned: 1, changed: 1 };
}

export function sanitizeStableSmokeArtifactTree(root) {
  if (!root || !existsSync(root)) return { scanned: 0, changed: 0 };
  const stats = statSync(root);
  if (stats.isFile()) return sanitizeStableSmokeArtifactFile(root);
  if (!stats.isDirectory()) return { scanned: 0, changed: 0 };
  let scanned = 0;
  let changed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const result = entry.isDirectory()
      ? sanitizeStableSmokeArtifactTree(resolve(root, entry.name))
      : sanitizeStableSmokeArtifactFile(resolve(root, entry.name));
    scanned += result.scanned;
    changed += result.changed;
  }
  return { scanned, changed };
}
