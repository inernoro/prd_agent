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

export class MongoSplitStateBackingStore implements StateBackingStore {
  readonly kind = 'mongo' as const;
  private cache: CdsState | null = null;
  private initialized = false;
  private flushChain: Promise<void> = Promise.resolve();

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

    this.initialized = true;
  }

  load(): CdsState | null {
    return this.cache;
  }

  save(state: CdsState): void {
    // 同步刷 cache，异步分发到 3 个 collection。
    this.cache = structuredClone(state);

    const snapshot = this.cache;
    const now = new Date().toISOString();

    this.flushChain = this.flushChain
      .catch(() => { /* 旧错误吞掉,链路继续 */ })
      .then(async () => {
        // ── 1) Global rest ──
        const restOfState: GlobalRest = { ...snapshot } as CdsState;
        // 从 rest 里把 projects / branches 拆出来 — 它们各有 collection。
        delete (restOfState as Partial<CdsState>).projects;
        delete (restOfState as Partial<CdsState>).branches;
        await this.handle.globalCollection().replaceOne(
          { _id: GLOBAL_DOC_ID },
          { _id: GLOBAL_DOC_ID, state: restOfState, updatedAt: now },
          { upsert: true },
        );

        // ── 2) Projects collection ──
        const newProjectIds = new Set((snapshot.projects || []).map((p) => p.id));
        const existingProjects = await this.handle.projectsCollection().find().toArray();
        const existingProjectIds = new Set(existingProjects.map((d) => d._id));

        // 写入新增 / 更新
        for (const project of snapshot.projects || []) {
          await this.handle.projectsCollection().replaceOne(
            { _id: project.id },
            { _id: project.id, doc: project, updatedAt: now },
            { upsert: true },
          );
        }
        // 删除已不存在的 (project deleted in memory)
        for (const id of existingProjectIds) {
          if (!newProjectIds.has(id)) {
            await this.handle.projectsCollection().deleteOne({ _id: id });
          }
        }

        // ── 3) Branches collection ──
        const newBranchIds = new Set(Object.keys(snapshot.branches || {}));
        const existingBranches = await this.handle.branchesCollection().find().toArray();
        const existingBranchIds = new Set(existingBranches.map((d) => d._id));

        for (const branch of Object.values(snapshot.branches || {})) {
          await this.handle.branchesCollection().replaceOne(
            { _id: branch.id },
            {
              _id: branch.id,
              projectId: branch.projectId,
              doc: branch,
              updatedAt: now,
            },
            { upsert: true },
          );
        }
        for (const id of existingBranchIds) {
          if (!newBranchIds.has(id)) {
            await this.handle.branchesCollection().deleteOne({ _id: id });
          }
        }
      });
  }

  async flush(): Promise<void> {
    await this.flushChain;
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

    // 直接走 save() 的写入逻辑，确保 schema 一致。
    this.cache = structuredClone(state);
    this.save(state);
    await this.flush();
    return true;
  }
}
