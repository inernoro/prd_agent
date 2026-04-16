/**
 * RealAuthMongoHandle — the production MongoDB driver wrapper for
 * the auth store (FU-02). Mirrors the pattern used by
 * `state-store/mongo-handle.ts` but exposes three typed collections
 * (users, sessions, workspaces) instead of one.
 *
 * Kept in its own file so `mongo-store.ts` unit tests can mock
 * `IAuthMongoHandle` without pulling in the real `mongodb` driver.
 */

import { MongoClient, type Db, type Collection } from 'mongodb';
import type { CdsUser, CdsSession, CdsWorkspace } from '../../domain/auth.js';

// ── Collection interface ──────────────────────────────────────────────────────

/**
 * Minimal MongoDB collection surface we need. Keeping the interface
 * small makes unit testing easy — tests mock this, not the real driver.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface IAuthCollection<T = any> {
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  find(filter: Record<string, unknown>): Promise<T[]>;
  insertOne(doc: T): Promise<void>;
  /**
   * Replace the first document matching filter with doc.
   * `upsert: true` inserts when no match exists.
   */
  replaceOne(
    filter: Record<string, unknown>,
    doc: T,
    options?: { upsert?: boolean },
  ): Promise<void>;
  /** Update specific fields on the first matching document. */
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<void>;
  deleteOne(filter: Record<string, unknown>): Promise<void>;
  /** Delete all matching documents; returns the count deleted. */
  deleteMany(filter: Record<string, unknown>): Promise<number>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
}

// ── Handle interface ──────────────────────────────────────────────────────────

export interface IAuthMongoHandle {
  /** Connect to the server and prepare collections. */
  connect(): Promise<void>;
  usersCollection(): IAuthCollection<CdsUser>;
  sessionsCollection(): IAuthCollection<CdsSession>;
  workspacesCollection(): IAuthCollection<CdsWorkspace>;
  /** Graceful shutdown — waits for any pending ops. */
  close(): Promise<void>;
  /** Health probe used by the Settings panel. */
  ping(): Promise<boolean>;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface AuthMongoHandleOptions {
  /** e.g. 'mongodb://localhost:27017' */
  uri: string;
  /** Database name. Defaults to 'cds_auth_db'. */
  databaseName?: string;
  /**
   * Max time the initial connect can take before throwing.
   * Keep short so startup fails fast when mongo is unreachable.
   */
  connectTimeoutMs?: number;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * Adapt a typed `mongodb.Collection<TDoc>` to `IAuthCollection<TEntity>`.
 * MongoDB stores a `_id` field; we map `entity.id` → `_id` so queries
 * against `id` behave consistently with in-memory store semantics.
 *
 * Mapping strategy:
 *   - insertOne: stores doc as-is (the entity's `id` field is also used
 *     as `_id` to enable fast by-id lookups).
 *   - replaceOne/updateOne/deleteOne: filters by arbitrary fields.
 *   - findOne/find: strips the mongo `_id` field from results so callers
 *     receive plain entity objects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adaptCollection<TEntity>(col: Collection<any>): IAuthCollection<TEntity> {
  function stripId(doc: Record<string, unknown>): TEntity {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, ...rest } = doc;
    return rest as TEntity;
  }

  return {
    async findOne(filter) {
      const doc = await col.findOne(filter);
      return doc ? stripId(doc as Record<string, unknown>) : null;
    },

    async find(filter) {
      const docs = await col.find(filter).toArray();
      return docs.map((d) => stripId(d as Record<string, unknown>));
    },

    async insertOne(entity) {
      // Use the entity's `id` (or `token` for sessions) as mongo `_id`
      // so we get O(1) point lookups for the most common access patterns.
      const e = entity as { id?: string; token?: string };
      const docId: string = e.id ?? e.token ?? Math.random().toString(36).slice(2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await col.insertOne({ _id: docId as any, ...entity });
    },

    async replaceOne(filter, entity, options) {
      const e = entity as { id?: string; token?: string };
      const docId = e.id ?? e.token;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc: any = docId ? { _id: docId, ...entity } : { ...entity };
      await col.replaceOne(filter, doc, options);
    },

    async updateOne(filter, update) {
      await col.updateOne(filter, update);
    },

    async deleteOne(filter) {
      await col.deleteOne(filter);
    },

    async deleteMany(filter) {
      const result = await col.deleteMany(filter);
      return result.deletedCount ?? 0;
    },

    async countDocuments(filter) {
      return col.countDocuments(filter ?? {});
    },
  };
}

// ── Real implementation ───────────────────────────────────────────────────────

export class RealAuthMongoHandle implements IAuthMongoHandle {
  private client: MongoClient | null = null;
  private db: Db | null = null;

  private readonly uri: string;
  private readonly databaseName: string;
  private readonly connectTimeoutMs: number;

  constructor(opts: AuthMongoHandleOptions) {
    this.uri = opts.uri;
    this.databaseName = opts.databaseName ?? 'cds_auth_db';
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.client = new MongoClient(this.uri, {
      serverSelectionTimeoutMS: this.connectTimeoutMs,
      connectTimeoutMS: this.connectTimeoutMs,
    });
    await this.client.connect();
    this.db = this.client.db(this.databaseName);
  }

  private requireDb(): Db {
    if (!this.db) throw new Error('AuthMongoHandle not connected — call connect() first');
    return this.db;
  }

  usersCollection(): IAuthCollection<CdsUser> {
    return adaptCollection<CdsUser>(
      this.requireDb().collection<Record<string, unknown>>('cds_users'),
    );
  }

  sessionsCollection(): IAuthCollection<CdsSession> {
    return adaptCollection<CdsSession>(
      this.requireDb().collection<Record<string, unknown>>('cds_sessions'),
    );
  }

  workspacesCollection(): IAuthCollection<CdsWorkspace> {
    return adaptCollection<CdsWorkspace>(
      this.requireDb().collection<Record<string, unknown>>('cds_workspaces'),
    );
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  async ping(): Promise<boolean> {
    try {
      if (!this.db) return false;
      await this.db.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }
}
