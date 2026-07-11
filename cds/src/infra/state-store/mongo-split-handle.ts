/**
 * RealMongoSplitHandle — production impl of ISplitMongoHandle wrapping
 * the `mongodb` driver. 配 mongo-split-store.ts 使用，单独成文件方便单测
 * mock。
 *
 * Database 与 RealMongoHandle 共享（默认 'cds_state_db'），独立 collection:
 * cds_global_state / cds_projects / cds_branches / cds_self_update_history /
 * cds_webhook_deliveries / cds_activity_logs。
 */

import { MongoClient, type Db, type Collection } from 'mongodb';
import type {
  BranchEntry,
  DeploymentRun,
  DeploymentVersion,
  GithubWebhookDelivery,
  Project,
  ProjectActivityLog,
  SelfUpdateRecord,
} from '../../types.js';
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
  selfUpdateHistoryCollectionName?: string;
  deploymentRunsCollectionName?: string;
  deploymentVersionsCollectionName?: string;
  webhookDeliveriesCollectionName?: string;
  activityLogsCollectionName?: string;
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

interface SelfUpdateHistoryDoc {
  _id: string;
  ts: string;
  doc: SelfUpdateRecord;
  updatedAt: string;
}

interface DeploymentRunDoc {
  _id: string;
  projectId: string;
  branchId: string;
  doc: DeploymentRun;
  updatedAt: string;
}

interface DeploymentVersionDoc {
  _id: string;
  projectId: string;
  doc: DeploymentVersion;
  updatedAt: string;
}

interface WebhookDeliveryDoc {
  _id: string;
  receivedAt: string;
  doc: GithubWebhookDelivery;
  updatedAt: string;
}

interface ActivityLogDoc {
  _id: string;
  projectId: string;
  at: string;
  doc: ProjectActivityLog;
  updatedAt: string;
}

export class RealMongoSplitHandle implements ISplitMongoHandle {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private globalCol: Collection<GlobalDoc> | null = null;
  private projectsCol: Collection<ProjectDoc> | null = null;
  private branchesCol: Collection<BranchDoc> | null = null;
  private selfUpdateHistoryCol: Collection<SelfUpdateHistoryDoc> | null = null;
  private deploymentRunsCol: Collection<DeploymentRunDoc> | null = null;
  private deploymentVersionsCol: Collection<DeploymentVersionDoc> | null = null;
  private webhookDeliveriesCol: Collection<WebhookDeliveryDoc> | null = null;
  private activityLogsCol: Collection<ActivityLogDoc> | null = null;

  private readonly uri: string;
  private readonly databaseName: string;
  private readonly globalName: string;
  private readonly projectsName: string;
  private readonly branchesName: string;
  private readonly selfUpdateHistoryName: string;
  private readonly deploymentRunsName: string;
  private readonly deploymentVersionsName: string;
  private readonly webhookDeliveriesName: string;
  private readonly activityLogsName: string;
  private readonly connectTimeoutMs: number;

  constructor(opts: MongoSplitHandleOptions) {
    this.uri = opts.uri;
    this.databaseName = opts.databaseName || 'cds_state_db';
    this.globalName = opts.globalCollectionName || 'cds_global_state';
    this.projectsName = opts.projectsCollectionName || 'cds_projects';
    this.branchesName = opts.branchesCollectionName || 'cds_branches';
    this.selfUpdateHistoryName = opts.selfUpdateHistoryCollectionName || 'cds_self_update_history';
    this.deploymentRunsName = opts.deploymentRunsCollectionName || 'cds_deployment_runs';
    this.deploymentVersionsName = opts.deploymentVersionsCollectionName || 'cds_deployment_versions';
    this.webhookDeliveriesName = opts.webhookDeliveriesCollectionName || 'cds_webhook_deliveries';
    this.activityLogsName = opts.activityLogsCollectionName || 'cds_activity_logs';
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
    this.selfUpdateHistoryCol = this.db.collection<SelfUpdateHistoryDoc>(this.selfUpdateHistoryName);
    this.deploymentRunsCol = this.db.collection<DeploymentRunDoc>(this.deploymentRunsName);
    this.deploymentVersionsCol = this.db.collection<DeploymentVersionDoc>(this.deploymentVersionsName);
    this.webhookDeliveriesCol = this.db.collection<WebhookDeliveryDoc>(this.webhookDeliveriesName);
    this.activityLogsCol = this.db.collection<ActivityLogDoc>(this.activityLogsName);
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

  selfUpdateHistoryCollection(): ISplitMongoCollection<SelfUpdateHistoryDoc> {
    if (!this.selfUpdateHistoryCol) throw new Error('MongoSplitHandle not connected');
    return this.adaptCollection(this.selfUpdateHistoryCol);
  }

  deploymentRunsCollection(): ISplitMongoCollection<DeploymentRunDoc> {
    if (!this.deploymentRunsCol) throw new Error('MongoSplitHandle not connected');
    return this.adaptCollection(this.deploymentRunsCol);
  }

  deploymentVersionsCollection(): ISplitMongoCollection<DeploymentVersionDoc> {
    if (!this.deploymentVersionsCol) throw new Error('MongoSplitHandle not connected');
    return this.adaptCollection(this.deploymentVersionsCol);
  }

  webhookDeliveriesCollection(): ISplitMongoCollection<WebhookDeliveryDoc> {
    if (!this.webhookDeliveriesCol) throw new Error('MongoSplitHandle not connected');
    return this.adaptCollection(this.webhookDeliveriesCol);
  }

  activityLogsCollection(): ISplitMongoCollection<ActivityLogDoc> {
    if (!this.activityLogsCol) throw new Error('MongoSplitHandle not connected');
    return this.adaptCollection(this.activityLogsCol);
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
      this.selfUpdateHistoryCol = null;
      this.deploymentRunsCol = null;
      this.deploymentVersionsCol = null;
      this.webhookDeliveriesCol = null;
      this.activityLogsCol = null;
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
