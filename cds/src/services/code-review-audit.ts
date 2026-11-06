import { createHash } from 'node:crypto';

/** Bounded, redacted upstream evidence. Callers must persist each event with the CDS task. */
export interface CodeReviewAuditEvent {
  operation: string;
  url: string;
  method: string;
  startedAt: string;
  durationMs: number;
  outcome: 'success' | 'http_error' | 'network_error' | 'parse_error';
  status?: number;
  upstreamRequestId?: string;
  responseBytes?: number;
  evidence: string;
  truncated: boolean;
}

export type CodeReviewAudit = (event: CodeReviewAuditEvent) => Promise<void>;

export class CodeReviewUpstreamHttpError extends Error {
  constructor(operation: string, public readonly status: number) {
    super(`${operation} 失败（HTTP ${status}），请检查上游配置与授权`);
    this.name = 'CodeReviewUpstreamHttpError';
  }
}

export function redactReviewEvidence(value: string): string {
  return value
    .replace(/(?:Bearer|token)\s+[A-Za-z0-9_.~+/=-]+/gi, '[credential]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[credential]')
    .replace(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return '[url]'; }
    });
}

function safeSnapshot(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 10).map((entry) => safeSnapshot(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, entry]) => [key,
      /token|secret|password|cookie|authorization|email|code|snippet|content|prompt|description|suggestion|message|explanation/i.test(key)
        ? '[omitted private content]' : safeSnapshot(entry, depth + 1),
    ]));
  }
  return typeof value === 'string' ? redactReviewEvidence(value).slice(0, 300) : value;
}

export function reviewEvidence(value: unknown): { evidence: string; truncated: boolean } {
  const content = JSON.stringify(safeSnapshot(value)) ?? 'null';
  return { evidence: content.slice(0, 4096), truncated: content.length > 4096 };
}

export async function readReviewResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) throw new Error('上游响应超过允许大小');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maxBytes) throw new Error('上游响应超过允许大小');
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function reviewJsonRequest(
  operation: string, url: string, init: RequestInit,
  audit: CodeReviewAudit, fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const started = Date.now();
  const base = { operation, url: new URL(url).origin + new URL(url).pathname,
    method: init.method ?? 'GET', startedAt: new Date(started).toISOString() };
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error' });
  } catch (error) {
    await audit({ ...base, durationMs: Date.now() - started, outcome: 'network_error',
      evidence: '未收到响应', truncated: false });
    throw error;
  }
  let content: Buffer | undefined;
  let parsed: unknown;
  try {
    content = await readReviewResponse(response, 16 * 1024 * 1024);
    parsed = JSON.parse(content.toString('utf8'));
  } catch {
    await audit({ ...base, durationMs: Date.now() - started, outcome: 'parse_error', status: response.status,
      evidence: JSON.stringify({ reason: '响应不是允许大小内的 JSON',
        contentType: redactReviewEvidence(response.headers.get('content-type') ?? 'missing').slice(0, 120),
        bytes: content?.length, sha256: content ? createHash('sha256').update(content).digest('hex') : undefined }),
      truncated: true });
    throw new Error(`${operation} 返回无法解析的响应（HTTP ${response.status}）`);
  }
  await audit({ ...base, durationMs: Date.now() - started,
    outcome: response.ok ? 'success' : 'http_error', status: response.status,
    upstreamRequestId: response.headers.get('x-github-request-id') ?? response.headers.get('x-request-id') ?? undefined,
    responseBytes: content.length, ...reviewEvidence(parsed) });
  if (!response.ok) throw new CodeReviewUpstreamHttpError(operation, response.status);
  return parsed;
}
