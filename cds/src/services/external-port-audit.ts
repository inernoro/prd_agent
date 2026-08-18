import http from 'node:http';
import https from 'node:https';

export const REQUIRED_PUBLIC_TCP_PORTS = [22, 80, 443] as const;

export type ExternalPortAuditFamily = 'ipv4' | 'ipv6';

export interface ExternalPortAuditResult {
  family: ExternalPortAuditFamily;
  checkedAt: string;
  openPorts: number[];
  unexpectedOpenPorts: number[];
  missingRequiredPorts: number[];
  passed: boolean;
  durationMs?: number;
}

interface ScanResponse {
  status?: string;
  ports_open?: Array<{ port?: number }>;
  duration_ms?: number;
  fail_reason?: string;
}

interface JsonResponse {
  statusCode: number;
  retryAfterSeconds?: number;
  body: ScanResponse;
}

export interface ExternalPortAuditConfig {
  baseUrl: string;
  intervalMs: number;
}

export function externalPortAuditConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ExternalPortAuditConfig | null {
  const baseUrl = String(env.CDS_EXTERNAL_PORT_AUDIT_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) return null;
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('CDS_EXTERNAL_PORT_AUDIT_BASE_URL 必须使用 HTTP 或 HTTPS');
  }
  const rawHours = Number(env.CDS_EXTERNAL_PORT_AUDIT_INTERVAL_HOURS || '24');
  const intervalHours = Number.isFinite(rawHours) ? Math.max(1, Math.min(168, rawHours)) : 24;
  return { baseUrl, intervalMs: intervalHours * 60 * 60_000 };
}

export function evaluateExternalPortAudit(
  family: ExternalPortAuditFamily,
  openPorts: readonly number[],
  checkedAt = new Date(),
  durationMs?: number,
): ExternalPortAuditResult {
  const normalized = [...new Set(openPorts)]
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65_535)
    .sort((a, b) => a - b);
  const allowed = new Set<number>(REQUIRED_PUBLIC_TCP_PORTS);
  const open = new Set<number>(normalized);
  const unexpectedOpenPorts = normalized.filter((port) => !allowed.has(port));
  const missingRequiredPorts = REQUIRED_PUBLIC_TCP_PORTS.filter((port) => !open.has(port));
  return {
    family,
    checkedAt: checkedAt.toISOString(),
    openPorts: normalized,
    unexpectedOpenPorts,
    missingRequiredPorts,
    passed: unexpectedOpenPorts.length === 0 && missingRequiredPorts.length === 0,
    durationMs,
  };
}

function requestJson(url: URL, method: 'GET' | 'POST', family: ExternalPortAuditFamily): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method,
      family: family === 'ipv4' ? 4 : 6,
      headers: { accept: 'application/json' },
      timeout: 30_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const body = raw ? JSON.parse(raw) as ScanResponse : {};
          const retryAfter = Number(res.headers['retry-after'] || '');
          resolve({
            statusCode: res.statusCode || 0,
            retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
            body,
          });
        } catch (err) {
          reject(new Error(`外部端口扫描返回了不可解析的响应：${(err as Error).message}`));
        }
      });
    });
    req.once('timeout', () => req.destroy(new Error('外部端口扫描请求超时')));
    req.once('error', reject);
    req.end();
  });
}

export async function runExternalPortAudit(opts: {
  config: ExternalPortAuditConfig;
  family: ExternalPortAuditFamily;
  now?: () => Date;
  request?: typeof requestJson;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
}): Promise<ExternalPortAuditResult> {
  const now = opts.now ?? (() => new Date());
  const request = opts.request ?? requestJson;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
  const endpoint = new URL(`${opts.config.baseUrl}/v1/deep`);
  const startedAt = now().getTime();
  const start = await request(endpoint, 'POST', opts.family);
  if (start.statusCode < 200 || start.statusCode >= 300) {
    throw new Error(`外部端口扫描启动失败（HTTP ${start.statusCode}）`);
  }

  while (now().getTime() - startedAt <= maxWaitMs) {
    const polled = await request(endpoint, 'GET', opts.family);
    if (polled.statusCode === 429) {
      await sleep(Math.max(1, polled.retryAfterSeconds || 5) * 1000);
      continue;
    }
    if (polled.statusCode < 200 || polled.statusCode >= 300) {
      throw new Error(`外部端口扫描回读失败（HTTP ${polled.statusCode}）`);
    }
    if (polled.body.status === 'complete') {
      const ports = (polled.body.ports_open || []).map((item) => Number(item.port));
      return evaluateExternalPortAudit(opts.family, ports, now(), polled.body.duration_ms);
    }
    if (polled.body.status === 'failed') {
      throw new Error(`外部端口扫描未完成：${polled.body.fail_reason || '未知原因'}`);
    }
    await sleep(5_000);
  }
  throw new Error('外部端口扫描超过最大等待时间');
}
