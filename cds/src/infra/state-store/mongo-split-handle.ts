/**
 * RealMongoSplitHandle — production impl of ISplitMongoHandle wrapping
 * the `mongodb` driver. 配 mongo-split-store.ts 使用，单独成文件方便单测
 * mock。
 *
 * Database 与 RealMongoHandle 共享（默认 'cds_state_db'），但使用 3 个
 * 独立 collection: cds_global_state / cds_projects / cds_branches。
 */

import { MongoClient, type Db, type Collection } from 'mongodb';
import type { BranchEntry, Project } from '../../types.js';
import type {
  GlobalRest,
  ISplitMongoCollection,
  ISplitMongoHandle,
} from './mongo-split-store.js';

export interface MongoSplitHandleOptions {
  uri: string;
  databaseName?: string;
  globalCollectionName?: string;
  projectsCollectionName?: string;
  branchesCollectionName?: string;
  connectTimeoutMs?: number;
}

interface GlobalDoc {
  _id: string;
  state: GlobalRest;
  updatedAt: string;
}

interface ProjectDoc {
  _id: string;
  doc: Project;
  updatedAt: string;
}

interface BranchDoc {
  _id: string;
  projectId: string;
  doc: BranchEntry;
  updatedAt: string;
}

export class RealMongoSplitHandle implements ISplitMongoHandle {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private globalCol: Collection<GlobalDoc> | null = null;
  private projectsCol: Collection<ProjectDoc> | null = null;
  private branchesCol: Collection<BranchDoc> | null = null;

  private readonly uri: string;
  private readonly databaseName: string;
  private readonly globalName: string;
  private readonly projectsName: string;
  private readonly branchesName: string;
  private readonly connectTimeoutMs: number;

  constructor(opts: MongoSplitHandleOptions) {
    this.uri = opts.uri;
    this.databaseName = opts.databaseName || 'cds_state_db';
    this.globalName = opts.globalCollectionName || 'cds_global_state';
    this.projectsName = opts.projectsCollectionName || 'cds_projects';
    this.branchesName = opts.branchesCollectionName || 'cds_branches';
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
    this.globalCol = this.db.collection<GlobalDoc>(this.globalName);
    this.projectsCol = this.db.collection<ProjectDoc>(this.projectsName);
    this.branchesCol = this.db.collection<BranchDoc>(this.branchesName);
  }

  globalCollection(): ISplitMongoCollection<GlobalDoc> {
    if (!this.globalCol) throw new Error('MongoSplitHandle not connected');
    return this.adaptCollection(this.globalCol);
  }

  projectsCollection(): ISplitMongoCollection<ProjectDoc> {
    if (!this.projectsCol) throw new Error('MongoSplitHandle not connected');
    return this.adaptCollection(this.projectsCol);
  }

  branchesCollection(): ISplitMongoCollection<BranchDoc> {
    if (!this.branchesCol) throw new Error('MongoSplitHandle not connected');
    return this.adaptCollection(this.branchesCol);
  }

  /** 把 mongo Collection 适配到我们的最小接口。 */
  private adaptCollection<T extends { _id: string }>(
    col: Collection<T>,
  ): ISplitMongoCollection<T> {
    return {
      async findOne(filter) {
        const doc = await col.findOne(filter as never);
        return (doc as T) ?? null;
      },
      find(filter) {
        const cursor = col.find((filter as never) || {});
        return {
          async toArray() {
            return (await cursor.toArray()) as unknown as T[];
          },
        };
      },
      async replaceOne(filter, doc, options) {
        await col.replaceOne(filter as never, doc as never, options);
      },
      async deleteOne(filter) {
        await col.deleteOne(filter as never);
      },
      async bulkWrite(operations) {
        await col.bulkWrite(operations as never);
      },
      async countDocuments(filter) {
        return await col.countDocuments((filter as never) || {});
      },
      async createIndex(spec, options) {
        return await col.createIndex(spec as never, options as never);
      },
    };
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.globalCol = null;
      this.projectsCol = null;
      this.branchesCol = null;
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
