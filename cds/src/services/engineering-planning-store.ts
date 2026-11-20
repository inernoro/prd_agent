import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MongoClient, type Collection } from 'mongodb';
import type {
  PlanningDebt, PlanningDecision, PlanningEvent, PlanningPlan, PlanningProposal, PlanningReceipt,
} from '../shared/engineering-planning.js';
import type { PlanningPullRequestSnapshot } from './engineering-planning-pull-requests.js';
import type { PlanningNoticeRecord } from './engineering-planning-checkup.js';

export type PlanningEvidenceAsset = { id: string; mime: string; base64?: string };
export type EngineeringPlanningCommandRequest = { key: string; fingerprint: string; receipt: PlanningReceipt };

export interface EngineeringPlanningCommit {
  projectId: string;
  revision: number;
  request?: EngineeringPlanningCommandRequest | { key: string; internal: true };
  debts: PlanningDebt[];
  decisions: PlanningDecision[];
  plans: PlanningPlan[];
  proposals: PlanningProposal[];
  events: PlanningEvent[];
  assets?: PlanningEvidenceAsset[];
  pullRequests?: PlanningPullRequestSnapshot[];
  notices?: PlanningNoticeRecord[];
  duplicateBaselineRevision?: number;
  reportedDuplicatePairs?: string[];
}

/** A revision publishes a command receipt or a GitHub observation together with changes. */
export interface EngineeringPlanningStore {
  read(projectId: string, after: number): Promise<EngineeringPlanningCommit[]>;
  append(commit: EngineeringPlanningCommit): Promise<boolean>;
  readAsset?(projectId: string, revision: number, id: string): Promise<PlanningEvidenceAsset | undefined>;
  close?(): Promise<void>;
}

const directoryKey = (projectId: string) => createHash('sha256').update(projectId).digest('hex');
const revisionName = (revision: number) => String(revision).padStart(16, '0') + '.json';

export class FileEngineeringPlanningStore implements EngineeringPlanningStore {
  constructor(private readonly directory: string) {}

  async read(projectId: string, after: number): Promise<EngineeringPlanningCommit[]> {
    const directory = path.join(this.directory, directoryKey(projectId));
    let names: string[];
    try { names = await readdir(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const files = names.filter(name => /^\d{16}\.json$/.test(name) && name > revisionName(after)).sort();
    const commits: EngineeringPlanningCommit[] = [];
    for (let offset = 0; offset < files.length; offset += 32) {
      const batch = await Promise.all(files.slice(offset, offset + 32).map(async name => {
        const commit = JSON.parse(await readFile(path.join(directory, name), 'utf8')) as EngineeringPlanningCommit;
        if (commit.assets) commit.assets = commit.assets.map(({ id, mime }) => ({ id, mime }));
        return commit;
      }));
      commits.push(...batch);
    }
    return commits;
  }

  async readAsset(projectId: string, revision: number, id: string) {
    const file = path.join(this.directory, directoryKey(projectId), revisionName(revision));
    const commit = JSON.parse(await readFile(file, 'utf8')) as EngineeringPlanningCommit;
    return commit.projectId === projectId && commit.revision === revision ? commit.assets?.find(asset => asset.id === id) : undefined;
  }

  async append(commit: EngineeringPlanningCommit): Promise<boolean> {
    const directory = path.join(this.directory, directoryKey(commit.projectId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `pending-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(commit));
        await file.sync();
      } finally {
        await file.close();
      }
      // A hard link publishes the complete immutable revision and refuses to replace a winner.
      try { await link(temporary, path.join(directory, revisionName(commit.revision))); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      return true;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

type MongoCommit = EngineeringPlanningCommit & { _id: string };

export class MongoEngineeringPlanningStore implements EngineeringPlanningStore {
  private connection?: Promise<Collection<MongoCommit>>;
  private client?: MongoClient;
  constructor(private readonly uri: string, private readonly database: string) {}

  private collection() {
    if (this.connection) return this.connection;
    const client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 4, writeConcern: { w: 'majority' } });
    this.client = client;
    this.connection = client.connect().then(async () => {
      const commits = client.db(this.database).collection<MongoCommit>('cds_engineering_planning_commits');
      await commits.createIndex({ projectId: 1, revision: 1 }, { unique: true });
      return commits;
    }).catch(async error => {
      await client.close().catch(() => undefined);
      this.client = undefined;
      this.connection = undefined;
      throw error;
    });
    return this.connection;
  }

  async read(projectId: string, after: number) {
    const collection = await this.collection();
    return collection.find({ projectId, revision: { $gt: after } }, { projection: { 'assets.base64': 0 } }).sort({ revision: 1 }).toArray();
  }

  async readAsset(projectId: string, revision: number, id: string) {
    const collection = await this.collection();
    const commit = await collection.findOne({ projectId, revision, 'assets.id': id }, { projection: { assets: { $elemMatch: { id } } } });
    return commit?.assets?.[0];
  }

  async append(commit: EngineeringPlanningCommit) {
    const collection = await this.collection();
    try {
      await collection.insertOne({ ...commit, _id: `${directoryKey(commit.projectId)}:${commit.revision}` });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  }

  async close() {
    await this.connection?.catch(() => undefined);
    await this.client?.close();
  }
}
