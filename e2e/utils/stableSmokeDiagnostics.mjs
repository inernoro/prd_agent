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
  'apiKey',
  'api_key',
  'api-key',
  'ticket',
];
const sensitivePropertyNames = new Set([...sensitiveHeaderNames, ...sensitiveValueNames].map((name) => name.toLowerCase()));
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
  // 先处理 JSON、对象转储等带引号的完整 header value。Cookie 经常包含多个
  // `name=value`，中间以分号和空格分隔，不能只遮掉第一个非空白 token。
  output = output.replace(
    new RegExp(`(["']?(?:${headerPattern})["']?\\s*[:=]\\s*)(["'])((?:\\\\.|(?!\\2)[^\\\\\\r\\n])*)\\2`, 'gi'),
    `$1$2${redacted}$2`,
  );
  // 再处理 curl/Playwright 日志里的原始 header 行，以及不带引号的对象值。
  // 行形式允许 Cookie 内部出现逗号；对象形式以 JSON 分隔符为边界。
  output = output.replace(
    new RegExp(`(^|\\r?\\n)(\\s*(?:${headerPattern})\\s*:\\s*)(?:Bearer\\s+)?[^\\r\\n]*`, 'gim'),
    `$1$2${redacted}`,
  );
  output = output.replace(
    new RegExp(`(["']?(?:${headerPattern})["']?\\s*[:=]\\s*)(?!["'])(?:Bearer\\s+)?([^,}\\]\\r\\n]+)`, 'gi'),
    `$1${redacted}`,
  );
  const valuePattern = sensitiveValueNames.map(escapeRegExp).join('|');
  output = output.replace(
    new RegExp(`(["']?(?:${valuePattern})["']?\\s*[:=]\\s*)(["'])((?:\\\\.|(?!\\2)[^\\\\\\r\\n])*)\\2`, 'gi'),
    `$1$2${redacted}$2`,
  );
  output = output.replace(
    /(["']code["']\s*:\s*)(["'])((?:\\.|(?!\2)[^\\\r\n])*)\2/gi,
    (match, prefix, quote, code) => (/^[A-Z][A-Z0-9_]{2,}$/.test(code)
      ? match
      : `${prefix}${quote}${redacted}${quote}`),
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
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  let changed = false;
  for (const key of Object.keys(value)) {
    try {
      if (typeof value[key] === 'string') {
        const original = value[key];
        const sanitized = sensitivePropertyNames.has(key.toLowerCase()) ? redacted : redactStableSmokeDiagnosticText(original);
        if (original !== sanitized) {
          value[key] = sanitized;
          changed = true;
        }
      } else {
        changed = redactMutable(value[key], seen) || changed;
      }
    } catch {
      // Playwright 未来若把某个诊断字段改为只读，继续清理其余可写字段。
    }
  }
  return changed;
}

function redactInterruptedReporterText(value) {
  const names = [...sensitivePropertyNames].map(escapeRegExp).join('|');
  // JSON reporter 的 message 只有这一层已证实的 JSON 转义。
  // 闭引号或文件末尾均收敛，进程中断在敏感值内部也不能留下明文。
  const quote = '(?<!\\\\)\\\\"';
  const pattern = new RegExp('(' + quote + '(?:' + names + ')' + quote + '\\s*:\\s*' + quote
    + ')[\\s\\S]*?(?=' + quote + '|$)', 'gi');
  return value.replace(pattern, '$1' + redacted);
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
  let sanitized = original;
  if (extname(path).toLowerCase() === '.json') {
    try {
      // reporter 会再次转义 message 里的 JSON；先按实际结构脱敏，再处理文本。
      // 没有变化时保留原格式，重复扫描不会制造无意义的产物改写。
      const data = JSON.parse(original);
      if (redactMutable(data)) sanitized = `${JSON.stringify(data, null, 2)}\n`;
    } catch {
      // 保留 reporter 的真实转义层，截断 JSON 也不漏凭据。
      sanitized = redactInterruptedReporterText(original);
    }
  }
  sanitized = redactStableSmokeDiagnosticText(sanitized);
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
