import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { MongoClient, type Collection, type Sort } from 'mongodb';

export interface HttpLogRecord {
  _id: string;
  ts: Date;
  layer: 'master' | 'master-proxy' | 'forwarder';
  requestKind?: HttpRequestKind;
  requestId: string;
  method: string;
  protocol?: string;
  host?: string;
  path: string;
  status: number;
  durationMs: number;
  outcome: 'ok' | 'client-error' | 'server-error' | 'upstream-error' | 'timeout';
  remoteAddr?: string;
  branchId?: string | null;
  profileId?: string | null;
  upstream?: string | null;
  request: {
    headers?: Record<string, string>;
    bodyPreview?: string;
    bodyBytes?: number;
  };
  response: {
    headers?: Record<string, string>;
    bodyPreview?: string;
    bodyBytes?: number;
  };
  error?: {
    code?: string;
    message?: string;
  };
}

export type HttpRequestKind = 'user-traffic' | 'control-plane' | 'deploy' | 'container-op' | 'polling' | 'sse';

export const HTTP_LOG_LAYERS = ['master', 'master-proxy', 'forwarder'] as const satisfies readonly HttpLogRecord['layer'][];
export const HTTP_REQUEST_KINDS = ['user-traffic', 'control-plane', 'deploy', 'container-op', 'polling', 'sse'] as const satisfies readonly HttpRequestKind[];

export interface ActiveHttpRequestRecord {
  id: string;
  startedAt: Date;
  ageMs: number;
  layer: HttpLogRecord['layer'];
  requestKind: HttpRequestKind;
  requestId: string;
  method: string;
  protocol?: string;
  host?: string;
  path: string;
  remoteAddr?: string;
  branchId?: string | null;
  profileId?: string | null;
  upstream?: string | null;
  request: HttpLogRecord['request'];
}

export interface HttpActiveRequestFilter {
  limit?: number;
  requestId?: string;
  host?: string;
  layer?: HttpLogRecord['layer'];
  method?: string;
  pathContains?: string;
  branchId?: string;
  profileId?: string;
  requestKind?: HttpRequestKind;
  minAgeMs?: number;
  sort?: 'started' | 'age';
}

export interface HttpRecentLogFilter {
  limit?: number;
  requestId?: string;
  host?: string;
  layer?: HttpLogRecord['layer'];
  minStatus?: number;
  method?: string;
  pathContains?: string;
  branchId?: string;
  profileId?: string;
  requestKind?: HttpRequestKind;
  since?: string | Date;
  until?: string | Date;
  minDurationMs?: number;
  sort?: 'recent' | 'duration';
}

export interface HttpLogStoreOptions {
  uri: string;
  databaseName?: string;
  collectionName?: string;
  retentionDays?: number;
  maxDocuments?: number;
  connectTimeoutMs?: number;
}

export interface HttpLogSink {
  record(record: Omit<HttpLogRecord, '_id' | 'ts'> & { ts?: Date | string }): void;
  beginActive?(record: Omit<ActiveHttpRequestRecord, 'id' | 'startedAt' | 'ageMs'> & { startedAt?: Date | string }): string;
  completeActive?(id: string): void;
  findActive?(filter?: HttpActiveRequestFilter): ActiveHttpRequestRecord[];
  findRecent?(filter?: HttpRecentLogFilter): Promise<HttpLogRecord[]>;
}

const DEFAULT_COLLECTION = 'cds_http_logs';
const DEFAULT_RETENTION_DAYS = 3;
const DEFAULT_MAX_DOCUMENTS = 50_000;
const HEADER_DENY = /^(authorization|cookie|set-cookie|x-ai-access-key|ai-access-key|x-cds-ai-token|x-cds-project-key)$/i;
const HEADER_SECRET = /(token|secret|password|passwd|api[-_]?key|access[-_]?key|session|jwt|credential)/i;
// `authoriz` 覆盖 authorizationKey(被动授权一次性交付的 cdsp_ 明文)等字段 ——
// 否则一次性密钥会落进 cds_http_logs 的 response body 预览、被 /api/http-logs 取回,
// 破坏「明文只交付一次」。redactor 只动日志副本,不影响真实 HTTP 响应。
const BODY_SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|access[-_]?key|authoriz|session|jwt|credential)/i;
const MAX_HEADER_VALUE = 300;
const MAX_BODY_PREVIEW_BYTES = 8 * 1024;
const MAX_ERROR_MESSAGE = 1200;
const MAX_REDACT_DEPTH = 8;
const OMITTED_BINARY_BODY_PREVIEW = '[cds http log omitted binary body]';
const API_BRANCH_DEPLOY_PATH = /^(?:\/_cds)?\/api\/branches\/[^/]+\/deploy(?:\/[^/]+)?$/;
const API_BRANCH_CONTAINER_OP_PATH = /^(?:\/_cds)?\/api\/branches\/[^/]+\/(stop|restart|pull|container-logs|container-exec|container-env|logs)$/;

export function parseHttpLogLayer(value: unknown): HttpLogRecord['layer'] | undefined {
  return typeof value === 'string' && (HTTP_LOG_LAYERS as readonly string[]).includes(value)
    ? value as HttpLogRecord['layer']
    : undefined;
}

export function parseHttpRequestKindValue(value: unknown): HttpRequestKind | undefined {
  return typeof value === 'string' && (HTTP_REQUEST_KINDS as readonly string[]).includes(value)
    ? value as HttpRequestKind
    : undefined;
}

export function classifyHttpRequestKind(input: {
  layer?: HttpLogRecord['layer'];
  method?: string;
  path?: string;
  headers?: Record<string, unknown> | IncomingHttpHeaders;
}): HttpRequestKind {
  const method = (input.method || 'GET').toUpperCase();
  const pathValue = (input.path || '').split('?')[0] || '/';
  const headers = input.headers || {};
  const accept = String((headers as Record<string, unknown>).accept || '').toLowerCase();

  if (String((headers as Record<string, unknown>)['x-cds-poll'] || '').toLowerCase() === 'true') return 'polling';
  if (API_BRANCH_DEPLOY_PATH.test(pathValue)) return 'deploy';
  if (API_BRANCH_CONTAINER_OP_PATH.test(pathValue)) return 'container-op';
  if (accept.includes('text/event-stream') || pathValue.endsWith('/stream') || pathValue.includes('/stream/')) return 'sse';
  if (pathValue.startsWith('/api/')
    || pathValue.startsWith('/_cds/api/')
    || pathValue.startsWith('/api/branches/')
    || pathValue.startsWith('/api/projects/')
    || pathValue.startsWith('/api/executors/')
    || pathValue.startsWith('/api/cluster/')
    || pathValue.startsWith('/api/github/')
    || pathValue.startsWith('/api/server-events')
    || (input.layer === 'master' && method !== 'GET')) {
    return 'control-plane';
  }
  return 'user-traffic';
}

export function filterActiveHttpRequests(
  requests: ActiveHttpRequestRecord[],
  filter: HttpActiveRequestFilter = {},
): ActiveHttpRequestRecord[] {
  const pathContains = filter.pathContains?.trim().toLowerCase();
  const minAgeMs = Number.isFinite(filter.minAgeMs) ? Math.max(0, Math.floor(filter.minAgeMs || 0)) : 0;
  const rows = requests
    .filter((request) => {
      if (filter.requestId && request.requestId !== filter.requestId) return false;
      if (filter.host && request.host !== filter.host) return false;
      if (filter.layer && request.layer !== filter.layer) return false;
      if (filter.method && request.method.toUpperCase() !== filter.method.toUpperCase()) return false;
      if (filter.branchId && request.branchId !== filter.branchId) return false;
      if (filter.profileId && request.profileId !== filter.profileId) return false;
      if (filter.requestKind && request.requestKind !== filter.requestKind) return false;
      if (pathContains && !request.path.toLowerCase().includes(pathContains)) return false;
      if (minAgeMs > 0 && request.ageMs < minAgeMs) return false;
      return true;
    });
  const limit = Math.max(1, Math.min(filter.limit ?? 200, 5000));
  return rows
    .sort((left, right) => filter.sort === 'started'
      ? new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime()
      : right.ageMs - left.ageMs)
    .slice(0, limit);
}

function normalizeContentType(value: unknown): string {
  if (Array.isArray(value)) return normalizeContentType(value[0]);
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function parseContentLength(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(raw || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function isTextualContentType(value: unknown): boolean {
  const type = normalizeContentType(value);
  if (!type) return true;
  if (type.startsWith('text/')) return true;
  if (type === 'application/json') return true;
  if (type.endsWith('+json') || type.endsWith('/json')) return true;
  if (type === 'application/javascript' || type === 'application/x-javascript') return true;
  if (type === 'application/xml' || type.endsWith('+xml')) return true;
  if (type === 'application/x-www-form-urlencoded') return true;
  if (type === 'application/graphql') return true;
  if (type === 'application/graphql-response+json') return true;
  if (type === 'application/problem+json') return true;
  if (type === 'application/x-ndjson') return true;
  return false;
}

export function isBinaryContentType(value: unknown): boolean {
  const type = normalizeContentType(value);
  if (!type) return false;
  if (type.startsWith('image/')) return true;
  if (type.startsWith('audio/')) return true;
  if (type.startsWith('video/')) return true;
  if (type.startsWith('font/')) return true;
  if (type === 'multipart/form-data') return true;
  if (type === 'application/octet-stream') return true;
  if (type === 'application/pdf') return true;
  if (type === 'application/zip') return true;
  if (type === 'application/gzip') return true;
  if (type === 'application/x-gzip') return true;
  if (type === 'application/x-tar') return true;
  if (type === 'application/x-7z-compressed') return true;
  if (type === 'application/x-rar-compressed') return true;
  if (type === 'application/wasm') return true;
  return !isTextualContentType(type);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function coerceDate(value: string | Date | undefined): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value);
  if (buf.length <= maxBytes) return value;
  let text = buf.subarray(0, maxBytes).toString('utf8');
  while (Buffer.byteLength(text, 'utf8') > maxBytes) text = text.slice(0, -1);
  return `${text}\n[cds http log truncated: original ${buf.length} bytes]`;
}

function redactStructuredValue(value: unknown, key = '', depth = 0, seen = new WeakSet<object>()): unknown {
  if (key && BODY_SECRET_KEY.test(key)) return '[redacted]';
  if (value == null || typeof value !== 'object') return value;
  if (depth >= MAX_REDACT_DEPTH) return '[cds http log redaction depth limit]';
  if (seen.has(value)) return '[cds http log circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactStructuredValue(item, '', depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = redactStructuredValue(childValue, childKey, depth + 1, seen);
  }
  return out;
}

function redactJsonText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.stringify(redactStructuredValue(JSON.parse(trimmed)));
  } catch {
    return null;
  }
}

export function redactBodyText(value: string): string {
  const jsonRedacted = redactJsonText(value);
  if (jsonRedacted != null) return jsonRedacted;

  let out = value;
  out = out.replace(
    /(^|[?&\s])([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|session|jwt|credential)[A-Za-z0-9_.-]*=)[^&\s]{1,300}/gi,
    (_match, prefix: string, key: string) => `${prefix}${key}[redacted]`,
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [redacted]');
  return out;
}

function sanitizePayload(payload: HttpLogRecord['request'] | HttpLogRecord['response']): typeof payload {
  const contentType = payload.headers?.['content-type'];
  if (isBinaryContentType(contentType)) {
    const declaredBytes = parseContentLength(payload.headers?.['content-length']);
    const observedBytes = payload.bodyBytes ?? 0;
    const bodyBytes = declaredBytes != null
      ? Math.max(observedBytes, declaredBytes)
      : payload.bodyBytes;
    return {
      ...payload,
      bodyBytes,
      bodyPreview: bodyBytes ? OMITTED_BINARY_BODY_PREVIEW : undefined,
    };
  }
  const preview = payload.bodyPreview
    ? redactBodyText(truncateUtf8(payload.bodyPreview, MAX_BODY_PREVIEW_BYTES))
    : payload.bodyPreview;
  return {
    ...payload,
    bodyPreview: preview ? truncateUtf8(preview, MAX_BODY_PREVIEW_BYTES) : preview,
  };
}

export function createRequestId(): string {
  return randomUUID().slice(0, 8);
}

export function redactHeaders(headers: IncomingHttpHeaders | Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawValue == null) continue;
    const key = rawKey.toLowerCase();
    if (HEADER_DENY.test(key) || HEADER_SECRET.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
    out[key] = truncateUtf8(value, MAX_HEADER_VALUE);
  }
  return out;
}

export function bodyPreviewFromUnknown(value: unknown, contentType?: unknown): { bodyPreview?: string; bodyBytes?: number } {
  if (value == null) return {};
  if (Buffer.isBuffer(value)) {
    return {
      bodyPreview: isBinaryContentType(contentType) && value.length > 0 ? OMITTED_BINARY_BODY_PREVIEW : truncateUtf8(redactBodyText(value.toString('utf8').replace(/\0/g, '')), MAX_BODY_PREVIEW_BYTES),
      bodyBytes: value.length,
    };
  }
  if (isBinaryContentType(contentType)) {
    let bodyBytes: number | undefined;
    if (typeof value === 'string') bodyBytes = Buffer.byteLength(value, 'utf8');
    else {
      try { bodyBytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { bodyBytes = undefined; }
    }
    return { bodyPreview: bodyBytes ? OMITTED_BINARY_BODY_PREVIEW : undefined, bodyBytes };
  }
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(redactStructuredValue(value));
    } catch {
      text = String(value);
    }
  }
  const preview = truncateUtf8(text, MAX_BODY_PREVIEW_BYTES);
  return {
    bodyPreview: truncateUtf8(redactBodyText(preview), MAX_BODY_PREVIEW_BYTES),
    bodyBytes: Buffer.byteLength(text, 'utf8'),
  };
}

export function createBodyCapture(maxBytes = MAX_BODY_PREVIEW_BYTES, contentType?: unknown): {
  onChunk(chunk: Buffer | string): void;
  snapshot(contentTypeOverride?: unknown): { bodyPreview?: string; bodyBytes: number };
} {
  let bodyBytes = 0;
  let capturedBytes = 0;
  const chunks: Buffer[] = [];
  const shouldCapturePreview = (type?: unknown) => !isBinaryContentType(type ?? contentType);
  return {
    onChunk(chunk) {
      if (Buffer.isBuffer(chunk)) {
        bodyBytes += chunk.length;
        if (shouldCapturePreview() && capturedBytes < maxBytes) {
          const part = chunk.subarray(0, maxBytes - capturedBytes);
          chunks.push(part);
          capturedBytes += part.length;
        }
        return;
      }

      const text = String(chunk);
      bodyBytes += Buffer.byteLength(text, 'utf8');
      if (!shouldCapturePreview()) return;
      if (capturedBytes >= maxBytes) return;

      // Do not Buffer.from() the full response string. Some JSON endpoints
      // return large strings in a single res.end(); copying the whole body
      // just to keep an 8KB preview can spike the master heap under polling.
      let part = Buffer.from(text.slice(0, maxBytes - capturedBytes), 'utf8');
      while (capturedBytes + part.length > maxBytes) {
        part = part.subarray(0, maxBytes - capturedBytes);
      }
      chunks.push(part);
      capturedBytes += part.length;
    },
    snapshot(contentTypeOverride?: unknown) {
      if (isBinaryContentType(contentTypeOverride ?? contentType)) {
        return {
          bodyPreview: bodyBytes > 0 ? OMITTED_BINARY_BODY_PREVIEW : undefined,
          bodyBytes,
        };
      }
      const preview = redactBodyText(Buffer.concat(chunks).toString('utf8').replace(/\0/g, ''));
      return {
        bodyPreview: preview ? truncateUtf8(preview, maxBytes) : undefined,
        bodyBytes,
      };
    },
  };
}

export class HttpLogStore {
  private client: MongoClient | null = null;
  private collection: Collection<HttpLogRecord> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private activeRequests = new Map<string, Omit<ActiveHttpRequestRecord, 'ageMs'>>();
  private writesSincePrune = 0;
  private lastPruneAt = 0;
  private readonly databaseName: string;
  private readonly collectionName: string;
  private readonly retentionDays: number;
  private readonly maxDocuments: number;
  private readonly connectTimeoutMs: number;

  constructor(private readonly opts: HttpLogStoreOptions) {
    this.databaseName = opts.databaseName || 'cds_state_db';
    this.collectionName = opts.collectionName || DEFAULT_COLLECTION;
    this.retentionDays = Math.max(1, opts.retentionDays ?? DEFAULT_RETENTION_DAYS);
    this.maxDocuments = Math.max(1000, opts.maxDocuments ?? DEFAULT_MAX_DOCUMENTS);
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
  }

  async init(): Promise<void> {
    if (this.client) return;
    this.client = new MongoClient(this.opts.uri, {
      serverSelectionTimeoutMS: this.connectTimeoutMs,
      connectTimeoutMS: this.connectTimeoutMs,
    });
    await this.client.connect();
    this.collection = this.client.db(this.databaseName).collection<HttpLogRecord>(this.collectionName);
    await Promise.all([
      this.collection.createIndex({ ts: -1 }, { name: 'ts_desc' }),
      this.collection.createIndex({ requestId: 1 }, { name: 'requestId_1' }),
      this.collection.createIndex({ host: 1, ts: -1 }, { name: 'host_ts_desc' }),
      this.collection.createIndex({ status: 1, ts: -1 }, { name: 'status_ts_desc' }),
      this.collection.createIndex({ requestKind: 1, durationMs: -1, ts: -1 }, { name: 'kind_duration_ts_desc' }),
      this.collection.createIndex({ durationMs: -1, ts: -1 }, { name: 'duration_ts_desc' }),
      this.collection.createIndex({ ts: 1 }, { name: 'ttl_ts', expireAfterSeconds: this.retentionDays * 86400 }),
    ]);
  }

  record(record: Omit<HttpLogRecord, '_id' | 'ts'> & { ts?: Date | string }): void {
    if (!this.collection) return;
    if (!this.shouldPersist(record)) return;
    const doc: HttpLogRecord = {
      ...record,
      requestKind: record.requestKind || classifyHttpRequestKind({
        layer: record.layer,
        method: record.method,
        path: record.path,
        headers: record.request?.headers,
      }),
      _id: `${record.requestId}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      ts: record.ts ? new Date(record.ts) : new Date(),
      request: sanitizePayload(record.request),
      response: sanitizePayload(record.response),
      error: record.error
        ? {
          code: record.error.code,
          message: record.error.message ? truncateUtf8(record.error.message, MAX_ERROR_MESSAGE) : undefined,
        }
        : undefined,
    };
    this.chain = this.chain
      .catch(() => { /* keep chain alive */ })
      .then(async () => {
        await this.collection!.insertOne(doc);
        this.schedulePrune();
      })
      .catch((err) => {
        // Logging must never break request handling.
        console.warn(`[http-log] write failed: ${(err as Error).message}`);
      });
  }

  beginActive(record: Omit<ActiveHttpRequestRecord, 'id' | 'startedAt' | 'ageMs'> & { startedAt?: Date | string }): string {
    const startedAt = record.startedAt ? new Date(record.startedAt) : new Date();
    const id = `${record.requestId}:${startedAt.getTime()}:${Math.random().toString(16).slice(2)}`;
    this.activeRequests.set(id, {
      ...record,
      requestKind: record.requestKind || classifyHttpRequestKind({
        layer: record.layer,
        method: record.method,
        path: record.path,
        headers: record.request?.headers,
      }),
      id,
      startedAt,
    });
    return id;
  }

  completeActive(id: string): void {
    if (!id) return;
    this.activeRequests.delete(id);
  }

  findActive(filter: HttpActiveRequestFilter = {}): ActiveHttpRequestRecord[] {
    const now = Date.now();
    const rows = [...this.activeRequests.values()]
      .map((request) => ({
        ...request,
        ageMs: Math.max(0, now - new Date(request.startedAt).getTime()),
      }));
    return filterActiveHttpRequests(rows, filter);
  }

  private shouldPersist(record: Omit<HttpLogRecord, '_id' | 'ts'> & { ts?: Date | string }): boolean {
    if (record.status >= 400) return true;
    const path = (record.path || '').split('?')[0];
    const method = (record.method || 'GET').toUpperCase();
    if (method === 'GET' && (path === '/healthz' || path === '/readyz' || path === '/__forwarder/healthz')) {
      return false;
    }
    if (method === 'GET' && (path === '/api/http-logs' || path === '/api/server-events')) {
      return false;
    }
    return true;
  }

  async findRecent(filter: HttpRecentLogFilter = {}): Promise<HttpLogRecord[]> {
    if (!this.collection) return [];
    const query: Record<string, unknown> = {};
    if (filter.requestId) query.requestId = filter.requestId;
    if (filter.host) query.host = filter.host;
    if (filter.layer) query.layer = filter.layer;
    if (filter.minStatus) query.status = { $gte: filter.minStatus };
    if (filter.method) query.method = filter.method.toUpperCase();
    if (filter.branchId) query.branchId = filter.branchId;
    if (filter.profileId) query.profileId = filter.profileId;
    if (filter.requestKind) query.requestKind = filter.requestKind;
    if (typeof filter.minDurationMs === 'number' && Number.isFinite(filter.minDurationMs) && filter.minDurationMs > 0) {
      query.durationMs = { $gte: Math.floor(filter.minDurationMs) };
    }
    const pathContains = filter.pathContains?.trim();
    if (pathContains) {
      query.path = { $regex: escapeRegExp(pathContains.slice(0, 200)), $options: 'i' };
    }
    const since = coerceDate(filter.since);
    const until = coerceDate(filter.until);
    if (since || until) {
      query.ts = {
        ...(since ? { $gte: since } : {}),
        ...(until ? { $lte: until } : {}),
      };
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 5000));
    const sort: Sort = filter.sort === 'duration'
      ? { durationMs: -1 as const, ts: -1 as const }
      : { ts: -1 as const };
    return await this.collection.find(query).sort(sort).limit(limit).toArray();
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      await this.client?.close();
      this.client = null;
      this.collection = null;
    }
  }

  private schedulePrune(): void {
    this.writesSincePrune += 1;
    const now = Date.now();
    if (this.writesSincePrune < 500 && now - this.lastPruneAt < 60_000) return;
    this.writesSincePrune = 0;
    this.lastPruneAt = now;
    void this.pruneByCount();
  }

  private async pruneByCount(): Promise<void> {
    if (!this.collection) return;
    try {
      const count = await this.collection.countDocuments();
      if (count <= this.maxDocuments) return;
      const overflow = count - this.maxDocuments;
      const old = await this.collection
        .find({}, { projection: { _id: 1 } })
        .sort({ ts: 1 })
        .limit(overflow)
        .toArray();
      if (old.length > 0) {
        await this.collection.deleteMany({ _id: { $in: old.map((doc) => doc._id) } });
      }
    } catch (err) {
      console.warn(`[http-log] prune failed: ${(err as Error).message}`);
    }
  }
}

export function httpLogStoreFromEnv(): HttpLogStore | null {
  if (process.env.CDS_HTTP_LOGS_ENABLED === '0') return null;
  const uri = process.env.CDS_MONGO_URI;
  if (!uri) return null;
  return new HttpLogStore({
    uri,
    databaseName: process.env.CDS_MONGO_DB || 'cds_state_db',
    collectionName: process.env.CDS_HTTP_LOG_COLLECTION || DEFAULT_COLLECTION,
    retentionDays: Number.parseInt(process.env.CDS_HTTP_LOG_RETENTION_DAYS || '', 10) || DEFAULT_RETENTION_DAYS,
    maxDocuments: Number.parseInt(process.env.CDS_HTTP_LOG_MAX_DOCS || '', 10) || DEFAULT_MAX_DOCUMENTS,
  });
}
