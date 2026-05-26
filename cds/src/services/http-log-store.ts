import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { MongoClient, type Collection } from 'mongodb';

export interface HttpLogRecord {
  _id: string;
  ts: Date;
  layer: 'master' | 'master-proxy' | 'forwarder';
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
  findRecent?(filter?: {
    limit?: number;
    requestId?: string;
    host?: string;
    layer?: HttpLogRecord['layer'];
    minStatus?: number;
    method?: string;
    pathContains?: string;
    branchId?: string;
    profileId?: string;
    since?: string | Date;
    until?: string | Date;
  }): Promise<HttpLogRecord[]>;
}

const DEFAULT_COLLECTION = 'cds_http_logs';
const DEFAULT_RETENTION_DAYS = 3;
const DEFAULT_MAX_DOCUMENTS = 50_000;
const HEADER_DENY = /^(authorization|cookie|set-cookie|x-ai-access-key|ai-access-key|x-cds-ai-token|x-cds-project-key)$/i;
const HEADER_SECRET = /(token|secret|password|passwd|api[-_]?key|access[-_]?key|session|jwt|credential)/i;
const BODY_SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|access[-_]?key|session|jwt|credential)/i;
const MAX_HEADER_VALUE = 300;
const MAX_BODY_PREVIEW_BYTES = 8 * 1024;
const MAX_ERROR_MESSAGE = 1200;

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

function redactBodyText(value: string): string {
  let out = value.replace(
    /(["'])([^"']{0,120}?)(["'])\s*:\s*(["'])(?:\\.|(?!\4).){0,200}\4/g,
    (match, openKey: string, key: string, closeKey: string, quote: string) => {
      if (!BODY_SECRET_KEY.test(key)) return match;
      return `${openKey}${key}${closeKey}:${quote}[redacted]${quote}`;
    },
  );
  out = out.replace(
    /(^|[?&\s])([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|session|jwt|credential)[A-Za-z0-9_.-]*=)[^&\s]{1,300}/gi,
    (_match, prefix: string, key: string) => `${prefix}${key}[redacted]`,
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [redacted]');
  return out;
}

function sanitizePayload(payload: HttpLogRecord['request'] | HttpLogRecord['response']): typeof payload {
  return {
    ...payload,
    bodyPreview: payload.bodyPreview
      ? truncateUtf8(redactBodyText(payload.bodyPreview), MAX_BODY_PREVIEW_BYTES)
      : payload.bodyPreview,
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

export function bodyPreviewFromUnknown(value: unknown): { bodyPreview?: string; bodyBytes?: number } {
  if (value == null) return {};
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return {
    bodyPreview: truncateUtf8(redactBodyText(text), MAX_BODY_PREVIEW_BYTES),
    bodyBytes: Buffer.byteLength(text, 'utf8'),
  };
}

export function createBodyCapture(maxBytes = MAX_BODY_PREVIEW_BYTES): {
  onChunk(chunk: Buffer | string): void;
  snapshot(): { bodyPreview?: string; bodyBytes: number };
} {
  let bodyBytes = 0;
  let capturedBytes = 0;
  const chunks: Buffer[] = [];
  return {
    onChunk(chunk) {
      if (Buffer.isBuffer(chunk)) {
        bodyBytes += chunk.length;
        if (capturedBytes < maxBytes) {
          const part = chunk.subarray(0, maxBytes - capturedBytes);
          chunks.push(part);
          capturedBytes += part.length;
        }
        return;
      }

      const text = String(chunk);
      bodyBytes += Buffer.byteLength(text, 'utf8');
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
    snapshot() {
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
      this.collection.createIndex({ ts: 1 }, { name: 'ttl_ts', expireAfterSeconds: this.retentionDays * 86400 }),
    ]);
  }

  record(record: Omit<HttpLogRecord, '_id' | 'ts'> & { ts?: Date | string }): void {
    if (!this.collection) return;
    if (!this.shouldPersist(record)) return;
    const doc: HttpLogRecord = {
      ...record,
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

  async findRecent(filter: {
    limit?: number;
    requestId?: string;
    host?: string;
    layer?: HttpLogRecord['layer'];
    minStatus?: number;
    method?: string;
    pathContains?: string;
    branchId?: string;
    profileId?: string;
    since?: string | Date;
    until?: string | Date;
  } = {}): Promise<HttpLogRecord[]> {
    if (!this.collection) return [];
    const query: Record<string, unknown> = {};
    if (filter.requestId) query.requestId = filter.requestId;
    if (filter.host) query.host = filter.host;
    if (filter.layer) query.layer = filter.layer;
    if (filter.minStatus) query.status = { $gte: filter.minStatus };
    if (filter.method) query.method = filter.method.toUpperCase();
    if (filter.branchId) query.branchId = filter.branchId;
    if (filter.profileId) query.profileId = filter.profileId;
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
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
    return await this.collection.find(query).sort({ ts: -1 }).limit(limit).toArray();
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
