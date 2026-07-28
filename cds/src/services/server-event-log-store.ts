import { createHash, randomUUID } from 'node:crypto';
import { MongoClient, type Collection } from 'mongodb';
import { ensureIndexWithReconcile } from './mongo-index-reconcile.js';
import { maskSecrets } from './secret-masker.js';
import { getAgentOperationContext } from './agent-operation-context.js';
import type { AgentOperatorIdentitySummary } from '../types.js';

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
  agentIdentity?: AgentOperatorIdentitySummary;
  operationKind?: string | null;
  operationTrigger?: string | null;
  operationActor?: string | null;
  operationSource?: string | null;
  commitSha?: string | null;
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
  recordImmediate?(record: Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string }): Promise<void>;
  flush?(): Promise<void>;
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
    operationKind?: string;
    operationTrigger?: string;
    operationActor?: string;
    operationSource?: string;
    commitSha?: string;
    since?: Date | string;
  }): Promise<ServerEventRecord[]>;
}

const DEFAULT_COLLECTION = 'cds_server_events';
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_DOCUMENTS = 100_000;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_ERROR_MESSAGE = 1200;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_OBJECT_DEPTH = 8;
const SEVERITY_RANK: Record<ServerEventSeverity, number> = { info: 10, warn: 20, error: 30 };

function truncateUtf8(value: string, maxBytes: number): string {
  const masked = maskSecrets(value, { mask: true });
  const buf = Buffer.from(masked);
  if (buf.length <= maxBytes) return masked;
  const suffix = `\n[cds server event log truncated: original ${buf.length} bytes]`;
  const textBudget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  let text = buf.subarray(0, textBudget).toString('utf8');
  while (Buffer.byteLength(text, 'utf8') > textBudget) text = text.slice(0, -1);
  return `${text}${suffix}`;
}

export function compactServerEventValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return truncateUtf8(value, MAX_TEXT_BYTES);
  if (typeof value !== 'object') return value;
  if (depth >= MAX_OBJECT_DEPTH) return '[cds server event log truncated: max depth reached]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY_ITEMS).map((item) => compactServerEventValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      out.push(`[cds server event log truncated: ${value.length - MAX_ARRAY_ITEMS} array item(s) omitted]`);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, raw] of entries.slice(0, MAX_OBJECT_KEYS)) {
    if (/env|password|token|secret|credential|authorization|cookie/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = compactServerEventValue(raw, depth + 1);
    }
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    out.__cds_truncated_keys = `${entries.length - MAX_OBJECT_KEYS} object key(s) omitted`;
  }
  return out;
}

function resolveOperationId(record: { operationId?: string | null; details?: Record<string, unknown> }): string | null | undefined {
  if (typeof record.operationId === 'string' && record.operationId.trim()) return record.operationId.trim();
  const nested = record.details?.operationId;
  return typeof nested === 'string' && nested.trim() ? nested.trim() : record.operationId;
}

function resolveStringField(
  record: Record<string, unknown>,
  field: string,
  detailField = field,
): string | null | undefined {
  const direct = record[field];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const details = record.details;
  if (!details || typeof details !== 'object') return direct == null ? direct as null | undefined : undefined;
  const nested = (details as Record<string, unknown>)[detailField];
  return typeof nested === 'string' && nested.trim() ? nested.trim() : direct as null | undefined;
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
  operationKind?: string;
  operationTrigger?: string;
  operationActor?: string;
  operationSource?: string;
  commitSha?: string;
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
  if (filter.operationKind) query.operationKind = filter.operationKind;
  if (filter.operationTrigger) query.operationTrigger = filter.operationTrigger;
  if (filter.operationActor) query.operationActor = filter.operationActor;
  if (filter.operationSource) query.operationSource = filter.operationSource;
  if (filter.commitSha) query.commitSha = filter.commitSha;
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

export function enrichServerEventRecord(
  record: Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string },
): typeof record {
  const context = getAgentOperationContext();
  const identity = record.agentIdentity ?? context?.identity;
  return {
    ...record,
    requestId: record.requestId ?? context?.requestId,
    operationId: resolveOperationId(record) ?? context?.operationId,
    agentIdentity: identity ? compactServerEventValue(identity) as AgentOperatorIdentitySummary : undefined,
  };
}

export class ServerEventLogStore implements ServerEventLogSink {
  private client: MongoClient | null = null;
  private collection: Collection<ServerEventRecord> | null = null;
  /** 索引是否已建全；false 时由 scheduleIndexRetry 排程重试（不重连） */
  private indexesReady = false;
  private indexRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private indexRetryAttempt = 0;
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
    // 已连上但索引没建全（上次被 IndexOptionsConflict 之类挡住）→ 再试一次索引，
    // 不重连。否则「连上了但索引永远缺」会一直缺下去（Codex 九轮 P2）。
    if (this.client) {
      if (!this.indexesReady && this.collection) await this.tryEnsureIndexes(this.collection);
      return;
    }
    // 失败必须复位（Codex PR #1275 七轮 P2 同族）：先赋值再连，一旦 connect 抛错，
    // client 已挂在实例上而 collection 为空 —— init() 之后被 `if (this.client) return`
    // 永久短路，record() 又只在有 collection 时才写，于是这个日志库**静默死掉**。
    const client = new MongoClient(this.opts.uri, {
      serverSelectionTimeoutMS: this.connectTimeoutMs,
      connectTimeoutMS: this.connectTimeoutMs,
    });
    let collection: Collection<ServerEventRecord>;
    try {
      await client.connect();
      collection = client.db(this.databaseName).collection<ServerEventRecord>(this.collectionName);
    } catch (err) {
      await client.close().catch(() => undefined);
      this.client = null;
      this.collection = null;
      throw err;
    }
    // 连上就算可用：**索引失败不许把一个连得上的库判死**（Codex 九轮 P2）。
    // 典型场景是运维改了保留天数 —— 同名 ttl_ts 索引的 expireAfterSeconds 变了，
    // Mongo 报 IndexOptionsConflict。那是配置变更的正常后果，不是故障；若沿用
    // 「建索引失败即整体失败」，这个日志库会在改配置那天起静默死掉，而排障恰恰靠它。
    this.client = client;
    this.collection = collection;
    await this.tryEnsureIndexes(collection);
  }

  /**
   * 建索引，失败只告警不致命，并**自行排程重试**（Codex PR #1275 十轮 P2）。
   *
   * 只靠「下次 init() 会重试」是空头支票：index.ts / forwarder-main.ts 都只在启动时
   * 调一次 init()，进程活着期间不会再有第二次。于是索引失败后 indexesReady 永远是
   * false —— 尤其 TTL 对账已经 drop 掉旧索引、重建又失败时，**保留期在重启前一直
   * 是失效的**（日志无限增长，正是 2026-07-27 那类事故的燃料）。所以这里自己排一个
   * 退避重试，直到建成为止。
   *
   * 定时器 unref：这是服务起来之后的后台维护，不该仅凭它把进程钉在事件循环里
   *（与启动期那个**刻意不 unref** 的退避定时器相反 —— 那时没有别的 handle 撑着）。
   */
  private async tryEnsureIndexes(collection: Collection<ServerEventRecord>): Promise<void> {
    try {
      await this.ensureIndexes(collection);
      this.indexesReady = true;
      this.indexRetryAttempt = 0;
    } catch (err) {
      this.indexesReady = false;
      const delayMs = this.scheduleIndexRetry(collection);
      console.warn(
        `[server-event-log-store] 索引建立失败（库仍可写，${Math.round(delayMs / 1000)}s 后自动重试）: `
        + `${(err as Error)?.message || err}`,
      );
    }
  }

  /** 排一次索引重试（指数退避，30 分钟封顶）；返回本次的等待毫秒数。 */
  private scheduleIndexRetry(collection: Collection<ServerEventRecord>): number {
    this.indexRetryAttempt += 1;
    const delayMs = Math.min(30 * 60_000, 30_000 * 2 ** (this.indexRetryAttempt - 1));
    if (this.indexRetryTimer) clearTimeout(this.indexRetryTimer);
    const timer = setTimeout(() => {
      this.indexRetryTimer = null;
      if (this.collection) void this.tryEnsureIndexes(this.collection);
    }, delayMs);
    timer.unref?.();
    this.indexRetryTimer = timer;
    return delayMs;
  }

  private async ensureIndexes(collection: Collection<ServerEventRecord>): Promise<void> {
    // 逐条对账而非 Promise.all 直挂：一条索引冲突不该掩盖其余索引的结果，
    // 同名不同选项（改保留天数后的 ttl_ts）走 drop 再建（见 mongo-index-reconcile）。
    const results = await Promise.allSettled([
      ensureIndexWithReconcile(collection, { ts: -1 }, { name: 'ts_desc' }),
      ensureIndexWithReconcile(collection, { category: 1, ts: -1 }, { name: 'category_ts_desc' }),
      ensureIndexWithReconcile(collection, { severity: 1, ts: -1 }, { name: 'severity_ts_desc' }),
      ensureIndexWithReconcile(collection, { containerName: 1, ts: -1 }, { name: 'container_ts_desc' }),
      ensureIndexWithReconcile(collection, { branchId: 1, ts: -1 }, { name: 'branch_ts_desc' }),
      ensureIndexWithReconcile(collection, { profileId: 1, ts: -1 }, { name: 'profile_ts_desc', sparse: true }),
      ensureIndexWithReconcile(collection, { requestId: 1 }, { name: 'requestId_1', sparse: true }),
      ensureIndexWithReconcile(collection, { operationId: 1, ts: -1 }, { name: 'operationId_ts_desc', sparse: true }),
      ensureIndexWithReconcile(collection, { 'details.operationId': 1, ts: -1 }, { name: 'details_operationId_ts_desc', sparse: true }),
      ensureIndexWithReconcile(collection, { operationTrigger: 1, ts: -1 }, { name: 'operationTrigger_ts_desc', sparse: true }),
      ensureIndexWithReconcile(collection, { operationActor: 1, ts: -1 }, { name: 'operationActor_ts_desc', sparse: true }),
      ensureIndexWithReconcile(collection, { commitSha: 1, ts: -1 }, { name: 'commitSha_ts_desc', sparse: true }),
      ensureIndexWithReconcile(collection, { ts: 1 }, { name: 'ttl_ts', expireAfterSeconds: this.retentionDays * 86400 }),
    ]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length > 0) {
      throw new Error(`${failed.length} 个索引建立失败：${failed.map((f) => (f.reason as Error)?.message || f.reason).join('; ')}`);
    }
  }

  record(record: Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string }): void {
    if (!this.collection) return;
    const doc = this.buildDocument(record);

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

  async recordImmediate(record: Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string }): Promise<void> {
    if (!this.collection) return;
    await this.collection.insertOne(this.buildDocument(record));
    this.schedulePrune();
  }

  private buildDocument(record: Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string }): ServerEventRecord {
    const enriched = enrichServerEventRecord(record);
    return {
      ...enriched,
      _id: `${createServerEventId()}:${Date.now()}`,
      ts: enriched.ts ? new Date(enriched.ts) : new Date(),
      severity: enriched.severity,
      operationKind: resolveStringField(enriched as Record<string, unknown>, 'operationKind', 'kind'),
      operationTrigger: resolveStringField(enriched as Record<string, unknown>, 'operationTrigger', 'trigger'),
      operationActor: resolveStringField(enriched as Record<string, unknown>, 'operationActor', 'actor'),
      operationSource: resolveStringField(enriched as Record<string, unknown>, 'operationSource', 'source'),
      commitSha: resolveStringField(enriched as Record<string, unknown>, 'commitSha'),
      message: enriched.message ? truncateUtf8(enriched.message, MAX_TEXT_BYTES) : undefined,
      docker: enriched.docker ? compactServerEventValue(enriched.docker) as Record<string, unknown> : undefined,
      inspect: enriched.inspect ? compactServerEventValue(enriched.inspect) as Record<string, unknown> : undefined,
      details: enriched.details ? compactServerEventValue(enriched.details) as Record<string, unknown> : undefined,
      command: enriched.command
        ? {
          name: enriched.command.name,
          exitCode: enriched.command.exitCode,
          stdoutPreview: enriched.command.stdoutPreview ? truncateUtf8(enriched.command.stdoutPreview, MAX_TEXT_BYTES) : undefined,
          stderrPreview: enriched.command.stderrPreview ? truncateUtf8(enriched.command.stderrPreview, MAX_TEXT_BYTES) : undefined,
        }
        : undefined,
      logs: enriched.logs?.text
        ? {
          ...enriched.logs,
          text: truncateUtf8(enriched.logs.text, MAX_TEXT_BYTES),
        }
        : enriched.logs,
      error: enriched.error
        ? {
          code: enriched.error.code,
          message: enriched.error.message ? truncateUtf8(enriched.error.message, MAX_ERROR_MESSAGE) : undefined,
        }
        : undefined,
    };
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
    operationKind?: string;
    operationTrigger?: string;
    operationActor?: string;
    operationSource?: string;
    commitSha?: string;
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
    // 索引重试定时器必须一起收掉：它 unref 过不会钉住进程，但 close 之后
    // collection 已置空，留着只会在下一次 tick 空转。
    if (this.indexRetryTimer) { clearTimeout(this.indexRetryTimer); this.indexRetryTimer = null; }
    try {
      await this.flush();
    } finally {
      await this.client?.close();
      this.client = null;
      this.collection = null;
      this.indexesReady = false;
      this.indexRetryAttempt = 0;
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
