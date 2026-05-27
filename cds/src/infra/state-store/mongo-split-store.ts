/**
 * MongoSplitStateBackingStore — PR_B.5 实现的多 collection 模式后端。
 *
 * 设计目标
 * --------
 * 单文档 `cds_state` 模式（MongoStateBackingStore）虽然简单，但所有项目
 * 共用一个文档 → 每次 save 写整份 state；未来按项目分库 / 异地双活时
 * 都得整体同步。本类把 hot 表拆成独立 collection，让"按项目区分"在 DB
 * 层就成立：
 *
 *   cds_projects        每个项目一个文档（_id = projectId）
 *   cds_branches        每个分支一个文档（_id = branchId, 含 projectId 索引字段）
 *   cds_global_state    剩余 root-level 字段（routingRules / customEnv / etc）
 *                       仍单文档存储 — 这部分量小，没必要每个再拆
 *
 * 接口契约保持同步：load() / save() / flush()，让 StateService 完全无感。
 *
 * Cache 策略
 * ----------
 * 同 MongoStateBackingStore：init() 拉一次全量 + 缓存内存；load() 同步返回
 * cache；save() 同步刷 cache + 异步链式 upsert。差异在 save 实现：
 * 把 state 拆成 (projects, branches, rest) 三块，分别 bulkWrite 到对应
 * collection，删除 cache 里不再存在的文档。
 *
 * 顺序保证
 * --------
 * 写入用单 flushChain 串行化，保证后写覆盖前写（与单文档版语义一致）。
 *
 * Fallback
 * --------
 * init() 失败 → 调用方应回退到 JsonStateBackingStore。同 mongo-backing-store
 * 的 fallback 逻辑（见 index.ts）。
 */

import type { CdsState, BranchEntry, Project } from '../../types.js';
import type { StateBackingStore } from './backing-store.js';

/** Mongo 集合最小接口 — 与 mongo-backing-store 风格一致，便于单测。 */
export interface ISplitMongoCollection<TDoc extends { _id: string }> {
  findOne(filter: { _id: string }): Promise<TDoc | null>;
  find(filter?: Record<string, unknown>): { toArray(): Promise<TDoc[]> };
  replaceOne(
    filter: { _id: string },
    doc: TDoc,
    options?: { upsert: boolean },
  ): Promise<unknown>;
  deleteOne(filter: { _id: string }): Promise<unknown>;
  bulkWrite(operations: Array<unknown>): Promise<unknown>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
  createIndex?(spec: Record<string, 1 | -1>, options?: { name?: string }): Promise<unknown>;
}

export interface ISplitMongoHandle {
  connect(): Promise<void>;
  globalCollection(): ISplitMongoCollection<{ _id: string; state: GlobalRest; updatedAt: string }>;
  projectsCollection(): ISplitMongoCollection<{ _id: string; doc: Project; updatedAt: string }>;
  branchesCollection(): ISplitMongoCollection<{ _id: string; projectId: string; doc: BranchEntry; updatedAt: string }>;
  close(): Promise<void>;
  ping(): Promise<boolean>;
}

export const GLOBAL_DOC_ID = 'global';

/**
 * "rest of CdsState" — 不含 projects 与 branches 的所有 root-level 字段。
 * 拆出来作为类型，方便 mongo 文档 schema 推导。
 */
export type GlobalRest = Omit<CdsState, 'projects' | 'branches'>;

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function globalRestOf(state: CdsState): GlobalRest {
  const restOfState: GlobalRest = { ...state } as CdsState;
  delete (restOfState as Partial<CdsState>).projects;
  delete (restOfState as Partial<CdsState>).branches;
  return restOfState;
}

export class MongoSplitStateBackingStore implements StateBackingStore {
  readonly kind = 'mongo-split' as const;
  private cache: CdsState | null = null;
  private persistedCache: CdsState | null = null;
  private initialized = false;
  private pendingSnapshot: CdsState | null = null;
  private pendingGeneration = 0;
  private writeInFlight = false;
  private writeGeneration = 0;
  private persistedGeneration = 0;
  private failedGeneration = 0;
  private lastWriteError: unknown = null;
  private flushWaiters: Array<{
    generation: number;
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];

  constructor(private readonly handle: ISplitMongoHandle) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.handle.connect();

    // 索引：cds_branches.projectId — per-project 查询是热路径。
    // createIndex 是 idempotent 安全 op，重复创建不会出错。
    try {
      await this.handle.branchesCollection().createIndex?.({ projectId: 1 }, { name: 'projectId_1' });
    } catch {
      // 如果 driver 不支持 createIndex 或权限不足，跳过 — 索引非功能必需。
    }

    const [globalDoc, projectDocs, branchDocs] = await Promise.all([
      this.handle.globalCollection().findOne({ _id: GLOBAL_DOC_ID }),
      this.handle.projectsCollection().find().toArray(),
      this.handle.branchesCollection().find().toArray(),
    ]);

    if (!globalDoc && projectDocs.length === 0 && branchDocs.length === 0) {
      // 全空 — fresh mongo, 让 StateService 走 emptyState + 跑 migration。
      this.cache = null;
    } else {
      // 重建 CdsState：global doc 提供主体，projects/branches 从 collection 拼回。
      const restOfState: GlobalRest = globalDoc
        ? globalDoc.state
        : ({} as GlobalRest);

      const branches: Record<string, BranchEntry> = {};
      for (const bd of branchDocs) branches[bd.doc.id] = bd.doc;

      this.cache = {
        ...restOfState,
        projects: projectDocs.map((pd) => pd.doc),
        branches,
      } as CdsState;
    }
    this.persistedCache = this.cache ? structuredClone(this.cache) : null;

    this.initialized = true;
  }

  load(): CdsState | null {
    return this.cache;
  }

  save(state: CdsState): void {
    // 同步刷 cache；异步写入时只保留最新快照。部署日志会高频 save(),
    // 如果每个快照都排队写 Mongo，后续 delete/stop 这种终止操作的
    // flush() 会被旧快照拖住，甚至误判持久化超时。
    this.cache = structuredClone(state);
    this.pendingSnapshot = this.cache;
    this.pendingGeneration = ++this.writeGeneration;
    this.drainWrites();
  }

  private async persistSnapshot(snapshot: CdsState, previous: CdsState | null): Promise<void> {
    const now = new Date().toISOString();

    // ── 1) Global rest（单文档，replaceOne 即可）──
    const restOfState = globalRestOf(snapshot);
    const previousRest = previous ? globalRestOf(previous) : null;
    if (!previousRest || stableJson(restOfState) !== stableJson(previousRest)) {
      await this.handle.globalCollection().replaceOne(
        { _id: GLOBAL_DOC_ID },
        { _id: GLOBAL_DOC_ID, state: restOfState, updatedAt: now },
        { upsert: true },
      );
    }

    // ── 2) Projects collection（bulkWrite + 单次 deleteMany 收尾）──
    const newProjectIds = new Set((snapshot.projects || []).map((p) => p.id));
    const previousProjectIds = new Set((previous?.projects || []).map((p) => p.id));
    const previousProjects = new Map((previous?.projects || []).map((p) => [p.id, p]));

    const projectOps: unknown[] = [];
    for (const project of snapshot.projects || []) {
      const previousProject = previousProjects.get(project.id);
      if (!previousProject || stableJson(project) !== stableJson(previousProject)) {
        projectOps.push({
          replaceOne: {
            filter: { _id: project.id },
            replacement: { _id: project.id, doc: project, updatedAt: now },
            upsert: true,
          },
        });
      }
    }
    for (const id of previousProjectIds) {
      if (newProjectIds.has(id)) continue;
      projectOps.push({ deleteOne: { filter: { _id: id } } });
    }
    if (projectOps.length > 0) {
      await this.handle.projectsCollection().bulkWrite(projectOps);
    }

    // ── 3) Branches collection（同样 bulkWrite）──
    const newBranchIds = new Set(Object.keys(snapshot.branches || {}));
    const previousBranchIds = new Set(Object.keys(previous?.branches || {}));

    const branchOps: unknown[] = [];
    for (const branch of Object.values(snapshot.branches || {})) {
      const previousBranch = previous?.branches?.[branch.id];
      if (!previousBranch || stableJson(branch) !== stableJson(previousBranch)) {
        branchOps.push({
          replaceOne: {
            filter: { _id: branch.id },
            replacement: {
              _id: branch.id,
              projectId: branch.projectId,
              doc: branch,
              updatedAt: now,
            },
            upsert: true,
          },
        });
      }
    }
    for (const id of previousBranchIds) {
      if (newBranchIds.has(id)) continue;
      branchOps.push({ deleteOne: { filter: { _id: id } } });
    }
    if (branchOps.length > 0) {
      await this.handle.branchesCollection().bulkWrite(branchOps);
    }
  }

  private drainWrites(): void {
    if (this.writeInFlight) return;
    this.writeInFlight = true;
    void (async () => {
      let generation = 0;
      try {
        while (this.pendingSnapshot) {
          const snapshot = this.pendingSnapshot;
          generation = this.pendingGeneration;
          this.pendingSnapshot = null;
          await this.persistSnapshot(snapshot, this.persistedCache);
          this.persistedCache = structuredClone(snapshot);
          this.persistedGeneration = generation;
          this.lastWriteError = null;
          this.resolveFlushWaiters();
        }
      } catch (err) {
        this.failedGeneration = Math.max(this.failedGeneration, generation);
        this.lastWriteError = err;
        this.rejectFlushWaiters(err);
      } finally {
        this.writeInFlight = false;
        if (this.pendingSnapshot) this.drainWrites();
      }
    })();
  }

  private resolveFlushWaiters(): void {
    const pending: typeof this.flushWaiters = [];
    for (const waiter of this.flushWaiters) {
      if (waiter.generation <= this.persistedGeneration) waiter.resolve();
      else pending.push(waiter);
    }
    this.flushWaiters = pending;
  }

  private rejectFlushWaiters(err: unknown): void {
    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    for (const waiter of waiters) waiter.reject(err);
  }

  async forceFullSave(state: CdsState): Promise<void> {
    this.cache = structuredClone(state);

    const snapshot = this.cache;
    const now = new Date().toISOString();

    await this.handle.globalCollection().replaceOne(
      { _id: GLOBAL_DOC_ID },
      { _id: GLOBAL_DOC_ID, state: globalRestOf(snapshot), updatedAt: now },
      { upsert: true },
    );

    const newProjectIds = new Set((snapshot.projects || []).map((p) => p.id));
    const existingProjects = await this.handle.projectsCollection().find().toArray();
    const projectOps: unknown[] = (snapshot.projects || []).map((project) => ({
      replaceOne: {
        filter: { _id: project.id },
        replacement: { _id: project.id, doc: project, updatedAt: now },
        upsert: true,
      },
    }));
    for (const id of existingProjects.map((d) => d._id)) {
      if (!newProjectIds.has(id)) projectOps.push({ deleteOne: { filter: { _id: id } } });
    }
    if (projectOps.length > 0) await this.handle.projectsCollection().bulkWrite(projectOps);

    const newBranchIds = new Set(Object.keys(snapshot.branches || {}));
    const existingBranches = await this.handle.branchesCollection().find().toArray();
    const branchOps: unknown[] = Object.values(snapshot.branches || {}).map(
      (branch) => ({
        replaceOne: {
          filter: { _id: branch.id },
          replacement: {
            _id: branch.id,
            projectId: branch.projectId,
            doc: branch,
            updatedAt: now,
          },
          upsert: true,
        },
      }),
    );
    for (const id of existingBranches.map((d) => d._id)) {
      if (!newBranchIds.has(id)) branchOps.push({ deleteOne: { filter: { _id: id } } });
    }
    if (branchOps.length > 0) await this.handle.branchesCollection().bulkWrite(branchOps);
    this.persistedCache = structuredClone(snapshot);
    this.persistedGeneration = this.writeGeneration;
  }

  async flush(): Promise<void> {
    const targetGeneration = this.writeGeneration;
    if (targetGeneration <= this.persistedGeneration) return;
    if (targetGeneration <= this.failedGeneration && this.lastWriteError) {
      throw this.lastWriteError;
    }
    await new Promise<void>((resolve, reject) => {
      this.flushWaiters.push({ generation: targetGeneration, resolve, reject });
      this.resolveFlushWaiters();
      this.drainWrites();
    });
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      await this.handle.close();
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      return await this.handle.ping();
    } catch {
      return false;
    }
  }

  /**
   * Seed utility: 把 JsonBackingStore 拿到的 state 一次性写入 split mongo。
   * 仅在 3 个集合都为空时执行，避免覆盖已迁数据。
   */
  async seedIfEmpty(state: CdsState): Promise<boolean> {
    const [globalCount, projectsCount, branchesCount] = await Promise.all([
      this.handle.globalCollection().countDocuments({ _id: GLOBAL_DOC_ID }),
      this.handle.projectsCollection().countDocuments(),
      this.handle.branchesCollection().countDocuments(),
    ]);
    if (globalCount > 0 || projectsCount > 0 || branchesCount > 0) return false;

    await this.forceFullSave(state);
    return true;
  }
}
