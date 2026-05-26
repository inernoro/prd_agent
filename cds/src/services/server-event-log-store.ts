import { createHash, randomUUID } from 'node:crypto';
import { MongoClient, type Collection } from 'mongodb';
import { maskSecrets } from './secret-masker.js';

export type ServerEventCategory = 'container' | 'docker' | 'system';
export type ServerEventSeverity = 'info' | 'warn' | 'error';

export interface ServerEventRecord {
  _id: string;
  ts: Date;
  category: ServerEventCategory;
  severity: ServerEventSeverity;
  source: string;
  action: string;
  message?: string;
  projectId?: string | null;
  branchId?: string | null;
  profileId?: string | null;
  serviceId?: string | null;
  containerName?: string | null;
  status?: string | null;
  exitCode?: number | null;
  oomKilled?: boolean | null;
  upstream?: string | null;
  requestId?: string | null;
  operationId?: string | null;
  docker?: Record<string, unknown>;
  inspect?: Record<string, unknown>;
  command?: {
    name?: string;
    exitCode?: number;
    stdoutPreview?: string;
    stderrPreview?: string;
  };
  logs?: {
    tailLines?: number;
    text?: string;
    byteLength?: number;
    lineCount?: number;
    sha256?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
  details?: Record<string, unknown>;
}

export interface ServerEventLogStoreOptions {
  uri: string;
  databaseName?: string;
  collectionName?: string;
  retentionDays?: number;
  maxDocuments?: number;
  connectTimeoutMs?: number;
}

export interface ServerEventLogSink {
  record(record: Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string }): void;
  findRecent?(filter?: {
    limit?: number;
    category?: ServerEventCategory;
    severity?: ServerEventSeverity;
    minSeverity?: ServerEventSeverity;
    source?: string;
    action?: string;
    containerName?: string;
    branchId?: string;
    profileId?: string;
    projectId?: string;
    requestId?: string;
    operationId?: string;
    since?: Date | string;
  }): Promise<ServerEventRecord[]>;
}

const DEFAULT_COLLECTION = 'cds_server_events';
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_DOCUMENTS = 100_000;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_ERROR_MESSAGE = 1200;
const SEVERITY_RANK: Record<ServerEventSeverity, number> = { info: 10, warn: 20, error: 30 };

function truncateUtf8(value: string, maxBytes: number): string {
  const masked = maskSecrets(value, { mask: true });
  const buf = Buffer.from(masked);
  if (buf.length <= maxBytes) return masked;
  let text = buf.subarray(0, maxBytes).toString('utf8');
  while (Buffer.byteLength(text, 'utf8') > maxBytes) text = text.slice(0, -1);
  return `${text}\n[cds server event log truncated: original ${buf.length} bytes]`;
}

function compactObject(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return truncateUtf8(value, MAX_TEXT_BYTES);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(compactObject);
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/env|password|token|secret|credential|authorization|cookie/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = compactObject(raw);
    }
  }
  return out;
}

function resolveOperationId(record: { operationId?: string | null; details?: Record<string, unknown> }): string | null | undefined {
  if (typeof record.operationId === 'string' && record.operationId.trim()) return record.operationId.trim();
  const nested = record.details?.operationId;
  return typeof nested === 'string' && nested.trim() ? nested.trim() : record.operationId;
}

export function buildServerEventQuery(filter: {
  category?: ServerEventCategory;
  severity?: ServerEventSeverity;
  minSeverity?: ServerEventSeverity;
  source?: string;
  action?: string;
  containerName?: string;
  branchId?: string;
  profileId?: string;
  projectId?: string;
  requestId?: string;
  operationId?: string;
  since?: Date | string;
} = {}): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  if (filter.category) query.category = filter.category;
  if (filter.severity) query.severity = filter.severity;
  if (filter.source) query.source = filter.source;
  if (filter.action) query.action = filter.action;
  if (filter.containerName) query.containerName = filter.containerName;
  if (filter.branchId) query.branchId = filter.branchId;
  if (filter.profileId) query.profileId = filter.profileId;
  if (filter.projectId) query.projectId = filter.projectId;
  if (filter.requestId) query.requestId = filter.requestId;
  if (filter.operationId) {
    query.$or = [
      { operationId: filter.operationId },
      { 'details.operationId': filter.operationId },
    ];
  }
  if (filter.since) query.ts = { $gte: new Date(filter.since) };
  if (filter.minSeverity) {
    const min = SEVERITY_RANK[filter.minSeverity];
    query.severity = { $in: Object.entries(SEVERITY_RANK).filter(([, rank]) => rank >= min).map(([sev]) => sev) };
  }
  return query;
}

export function createServerEventId(): string {
  return randomUUID().slice(0, 12);
}

export function normalizeLogText(text: string, tailLines?: number): ServerEventRecord['logs'] {
  const masked = truncateUtf8(text || '', MAX_TEXT_BYTES);
  return {
    tailLines,
    text: masked || undefined,
    byteLength: Buffer.byteLength(text || '', 'utf8'),
    lineCount: text ? text.split(/\r?\n/).length : 0,
    sha256: createHash('sha256').update(text || '').digest('hex'),
  };
}

export class ServerEventLogStore implements ServerEventLogSink {
  private client: MongoClient | null = null;
  private collection: Collection<ServerEventRecord> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private writesSincePrune = 0;
  private lastPruneAt = 0;
  private readonly databaseName: string;
  private readonly collectionName: string;
  private readonly retentionDays: number;
  private readonly maxDocuments: number;
  private readonly connectTimeoutMs: number;

  constructor(private readonly opts: ServerEventLogStoreOptions) {
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
    this.collection = this.client.db(this.databaseName).collection<ServerEventRecord>(this.collectionName);
    await Promise.all([
      this.collection.createIndex({ ts: -1 }, { name: 'ts_desc' }),
      this.collection.createIndex({ category: 1, ts: -1 }, { name: 'category_ts_desc' }),
      this.collection.createIndex({ severity: 1, ts: -1 }, { name: 'severity_ts_desc' }),
      this.collection.createIndex({ containerName: 1, ts: -1 }, { name: 'container_ts_desc' }),
      this.collection.createIndex({ branchId: 1, ts: -1 }, { name: 'branch_ts_desc' }),
      this.collection.createIndex({ profileId: 1, ts: -1 }, { name: 'profile_ts_desc', sparse: true }),
      this.collection.createIndex({ requestId: 1 }, { name: 'requestId_1', sparse: true }),
      this.collection.createIndex({ operationId: 1, ts: -1 }, { name: 'operationId_ts_desc', sparse: true }),
      this.collection.createIndex({ 'details.operationId': 1, ts: -1 }, { name: 'details_operationId_ts_desc', sparse: true }),
      this.collection.createIndex({ ts: 1 }, { name: 'ttl_ts', expireAfterSeconds: this.retentionDays * 86400 }),
    ]);
  }

  record(record: Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string }): void {
    if (!this.collection) return;
    const doc: ServerEventRecord = {
      ...record,
      _id: `${createServerEventId()}:${Date.now()}`,
      ts: record.ts ? new Date(record.ts) : new Date(),
      severity: record.severity,
      operationId: resolveOperationId(record),
      message: record.message ? truncateUtf8(record.message, MAX_TEXT_BYTES) : undefined,
      docker: record.docker ? compactObject(record.docker) as Record<string, unknown> : undefined,
      inspect: record.inspect ? compactObject(record.inspect) as Record<string, unknown> : undefined,
      details: record.details ? compactObject(record.details) as Record<string, unknown> : undefined,
      command: record.command
        ? {
          name: record.command.name,
          exitCode: record.command.exitCode,
          stdoutPreview: record.command.stdoutPreview ? truncateUtf8(record.command.stdoutPreview, MAX_TEXT_BYTES) : undefined,
          stderrPreview: record.command.stderrPreview ? truncateUtf8(record.command.stderrPreview, MAX_TEXT_BYTES) : undefined,
        }
        : undefined,
      logs: record.logs?.text
        ? {
          ...record.logs,
          text: truncateUtf8(record.logs.text, MAX_TEXT_BYTES),
        }
        : record.logs,
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
        console.warn(`[server-event-log] write failed: ${(err as Error).message}`);
      });
  }

  async findRecent(filter: {
    limit?: number;
    category?: ServerEventCategory;
    severity?: ServerEventSeverity;
    minSeverity?: ServerEventSeverity;
    source?: string;
    action?: string;
    containerName?: string;
    branchId?: string;
    profileId?: string;
    projectId?: string;
    requestId?: string;
    operationId?: string;
    since?: Date | string;
  } = {}): Promise<ServerEventRecord[]> {
    if (!this.collection) return [];
    const query = buildServerEventQuery(filter);
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
      const old = await this.collection
        .find({}, { projection: { _id: 1 } })
        .sort({ ts: 1 })
        .limit(count - this.maxDocuments)
        .toArray();
      if (old.length > 0) await this.collection.deleteMany({ _id: { $in: old.map((doc) => doc._id) } });
    } catch (err) {
      console.warn(`[server-event-log] prune failed: ${(err as Error).message}`);
    }
  }
}

export function serverEventLogStoreFromEnv(): ServerEventLogStore | null {
  if (process.env.CDS_SERVER_EVENT_LOGS_ENABLED === '0') return null;
  const uri = process.env.CDS_MONGO_URI;
  if (!uri) return null;
  return new ServerEventLogStore({
    uri,
    databaseName: process.env.CDS_MONGO_DB || 'cds_state_db',
    collectionName: process.env.CDS_SERVER_EVENT_LOG_COLLECTION || DEFAULT_COLLECTION,
    retentionDays: Number.parseInt(process.env.CDS_SERVER_EVENT_LOG_RETENTION_DAYS || '', 10) || DEFAULT_RETENTION_DAYS,
    maxDocuments: Number.parseInt(process.env.CDS_SERVER_EVENT_LOG_MAX_DOCS || '', 10) || DEFAULT_MAX_DOCUMENTS,
  });
}
