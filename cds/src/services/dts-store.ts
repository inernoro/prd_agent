import { MongoClient, type Collection, type Document } from 'mongodb';
import { dtsReject } from './dts-policy.js';

/** Dedicated, project-scoped documents keep task history out of the global 16 MiB state record. */
export class DtsStore {
  private client?: MongoClient;
  private opening?: Promise<void>;
  constructor(private readonly uri: string | undefined, private readonly database = 'cds_state_db') {}
  configured() { return Boolean(this.uri); }
  private async open(): Promise<void> {
    if (!this.uri) dtsReject('dts_store_unavailable', '同步任务存储尚未配置，请联系系统管理员', 503);
    if (!this.opening) {
      const client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 5_000, maxPoolSize: 4 });
      this.opening = client.connect().then(async () => {
        const db = client.db(this.database);
        await db.collection('cds_dts_runs').createIndex({ projectId: 1, idempotencyKey: 1 }, { unique: true });
        await db.collection('cds_dts_runs').createIndex({ projectId: 1, status: 1 });
        await db.collection('cds_dts_plans').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
        for (const name of ['connections', 'plans', 'runs', 'policies']) await db.collection(`cds_dts_${name}`).createIndex({ projectId: 1, createdAt: -1 });
        this.client = client;
      }).catch(async () => {
        await client.close().catch(() => undefined); this.client = undefined; this.opening = undefined;
        dtsReject('dts_store_unavailable', '同步任务存储暂时不可用，请稍后重试', 503);
      });
    }
    await this.opening;
  }
  async collection(name: 'connections' | 'plans' | 'runs' | 'policies' | 'engines' | 'locks'): Promise<Collection<Document>> {
    await this.open(); return this.client!.db(this.database).collection(`cds_dts_${name}`);
  }
  async put<T extends { id: string; projectId: string }>(kind: Parameters<DtsStore['collection']>[0], value: T): Promise<void> {
    const rows = await this.collection(kind);
    await rows.replaceOne({ _id: value.id as never, projectId: value.projectId }, { _id: value.id, ...value, ...(kind === 'plans' ? { expireAt: new Date((value as T & { expiresAt: string }).expiresAt) } : {}) }, { upsert: true });
  }
  async get<T>(kind: Parameters<DtsStore['collection']>[0], projectId: string, id: string): Promise<T | undefined> {
    const row = await (await this.collection(kind)).findOne({ _id: id as never, projectId });
    if (!row) return undefined;
    const { _id: _, expireAt: _expiry, ...value } = row; return value as T;
  }
  async list<T>(kind: Parameters<DtsStore['collection']>[0], projectId: string, limit = 100): Promise<T[]> {
    const rows = await (await this.collection(kind)).find({ projectId }).sort({ createdAt: -1 }).limit(limit).toArray();
    return rows.map(({ _id: _, expireAt: _expiry, ...row }) => row as T);
  }
  async activeRuns<T>(projectId: string): Promise<T[]> {
    const rows = await (await this.collection('runs')).find({ projectId, status: { $nin: ['completed', 'failed', 'cancelled', 'paused'] } }).toArray();
    return rows.map(({ _id: _, ...value }) => value as T);
  }
  async byIdempotency<T>(projectId: string, key: string): Promise<T | undefined> {
    const row = await (await this.collection('runs')).findOne({ projectId, idempotencyKey: key });
    if (!row) return undefined;
    const { _id: _, expireAt: _expiry, ...value } = row; return value as T;
  }
  /** A lost heartbeat is NOT permission to replace an unconfirmed native writer. */
  async acquire(target: string, projectId: string, runId: string): Promise<boolean> {
    try {
      await (await this.collection('locks')).insertOne({ _id: target as never, projectId, runId, createdAt: new Date().toISOString() });
      return true;
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      return Boolean(await (await this.collection('locks')).findOne({ _id: target as never, projectId, runId }));
    }
  }
  async release(target: string, runId: string): Promise<void> {
    await (await this.collection('locks')).deleteOne({ _id: target as never, runId });
  }
  async close() { await this.opening?.catch(() => undefined); await this.client?.close(); this.client = undefined; this.opening = undefined; }
}
