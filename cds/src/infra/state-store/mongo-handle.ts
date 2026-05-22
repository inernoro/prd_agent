/**
 * RealMongoHandle — the production impl of IMongoHandle that wraps
 * the `mongodb` package. Kept in its own file so the backing-store
 * unit tests can mock IMongoHandle without pulling the real driver
 * into the test runner.
 */

import { MongoClient, type Db, type Collection } from 'mongodb';
import type { CdsState } from '../../types.js';
import type { IMongoHandle, IMongoCollection, StateFragmentDoc, StateLogRecordDoc } from './mongo-backing-store.js';

export interface MongoHandleOptions {
  /** e.g. 'mongodb://localhost:27017' or a full SRV URL. */
  uri: string;
  /** Database name to use. Defaults to 'cds_state_db'. */
  databaseName?: string;
  /** Collection name. Defaults to 'cds_state'. */
  collectionName?: string;
  /**
   * Max time the initial connect is allowed to take before the
   * handle gives up and throws. Surfacing this as an option lets
   * the "auto" startup mode fall back to JSON quickly when mongo
   * is unreachable instead of blocking boot for minutes.
   */
  connectTimeoutMs?: number;
}

interface StateDoc {
  _id: string;
  state: CdsState;
  updatedAt?: string;
}

export class RealMongoHandle implements IMongoHandle {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collection: Collection<StateDoc> | null = null;
  private fragmentCollectionRef: Collection<StateFragmentDoc> | null = null;
  private logRecordCollectionRef: Collection<StateLogRecordDoc> | null = null;
  private readonly databaseName: string;
  private readonly collectionName: string;
  private readonly fragmentCollectionName: string;
  private readonly logRecordCollectionName: string;
  private readonly connectTimeoutMs: number;
  private readonly uri: string;

  constructor(opts: MongoHandleOptions) {
    this.uri = opts.uri;
    this.databaseName = opts.databaseName || 'cds_state_db';
    this.collectionName = opts.collectionName || 'cds_state';
    this.fragmentCollectionName = `${this.collectionName}_fragments`;
    this.logRecordCollectionName = `${this.collectionName}_log_records`;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    // P4 Part 18 Phase D: keep timeouts short so the 'auto' startup
    // mode fails fast and falls back to JSON when mongo is offline.
    // The default mongo driver retries for 30s which feels like a
    // hung startup to users.
    this.client = new MongoClient(this.uri, {
      serverSelectionTimeoutMS: this.connectTimeoutMs,
      connectTimeoutMS: this.connectTimeoutMs,
    });
    await this.client.connect();
    this.db = this.client.db(this.databaseName);
    this.collection = this.db.collection<StateDoc>(this.collectionName);
    this.fragmentCollectionRef = this.db.collection<StateFragmentDoc>(this.fragmentCollectionName);
    this.logRecordCollectionRef = this.db.collection<StateLogRecordDoc>(this.logRecordCollectionName);
  }

  stateCollection(): IMongoCollection<StateDoc> {
    if (!this.collection) {
      throw new Error('MongoHandle not connected — call connect() first');
    }
    const col = this.collection;
    // Adapt the typed mongodb Collection to IMongoCollection. We
    // ignore the mongo driver's return metadata shape because the
    // backing store doesn't need it.
    return {
      async findOne(filter) {
        const doc = await col.findOne(filter);
        if (!doc) return null;
        return { _id: doc._id, state: doc.state };
      },
      async replaceOne(filter, doc, options) {
        await col.replaceOne(filter, doc, options);
      },
      async countDocuments(filter) {
        return await col.countDocuments(filter || {});
      },
    };
  }

  stateFragmentCollection(): IMongoCollection<StateFragmentDoc> {
    if (!this.fragmentCollectionRef) {
      throw new Error('MongoHandle not connected — call connect() first');
    }
    const col = this.fragmentCollectionRef;
    return {
      async findOne(filter) {
        return await col.findOne(filter) as StateFragmentDoc | null;
      },
      async find(filter) {
        return await col.find(filter || {}).toArray() as StateFragmentDoc[];
      },
      async replaceOne(filter, doc, options) {
        await col.replaceOne(filter, doc, options);
      },
      async deleteMany(filter) {
        await col.deleteMany(filter || {});
      },
      async countDocuments(filter) {
        return await col.countDocuments(filter || {});
      },
    };
  }

  stateLogRecordCollection(): IMongoCollection<StateLogRecordDoc> {
    if (!this.logRecordCollectionRef) {
      throw new Error('MongoHandle not connected — call connect() first');
    }
    const col = this.logRecordCollectionRef;
    return {
      async findOne(filter) {
        return await col.findOne(filter) as StateLogRecordDoc | null;
      },
      async find(filter) {
        return await col.find(filter || {}).toArray() as StateLogRecordDoc[];
      },
      async replaceOne(filter, doc, options) {
        await col.replaceOne(filter, doc, options);
      },
      async deleteMany(filter) {
        await col.deleteMany(filter || {});
      },
      async countDocuments(filter) {
        return await col.countDocuments(filter || {});
      },
    };
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.collection = null;
      this.fragmentCollectionRef = null;
      this.logRecordCollectionRef = null;
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
