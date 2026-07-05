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
 *   cds_self_update_history
 *                       CDS 自更新历史。steps/error 属日志类字段，必须从
 *                       global 单文档拆出，避免自更新重启前 flush 被超大
 *                       global document 拖失败。
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

import type {
  CdsState,
  BranchEntry,
  ContainerLogArchiveEntry,
  OperationLog,
  OperationLogContainerSnapshot,
  OperationLogEvent,
  Project,
  ProjectActivityLog,
  ReleaseRun,
  SelfUpdateRecord,
  ServiceDeployment,
  ServiceDeploymentLogEntry,
} from '../../types.js';
import type { StateBackingStore } from './backing-store.js';
import { pruneWebhookDeliveries } from '../../services/webhook-delivery-retention.js';

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
  selfUpdateHistoryCollection(): ISplitMongoCollection<{ _id: string; ts: string; doc: SelfUpdateRecord; updatedAt: string }>;
  close(): Promise<void>;
  ping(): Promise<boolean>;
}

export const GLOBAL_DOC_ID = 'global';

/**
 * "rest of CdsState" — 不含 projects 与 branches 的所有 root-level 字段。
 * 拆出来作为类型，方便 mongo 文档 schema 推导。
 */
export type GlobalRest = Omit<CdsState, 'projects' | 'branches'>;

const MAX_LOGS_PER_BRANCH = 5;
const MAX_EVENTS_PER_OPERATION_LOG = 5;
const MAX_CONTAINER_ARCHIVES_PER_BRANCH = 3;
const MAX_ACTIVITY_LOGS_PER_PROJECT = 200;
// webhook 投递保留改走 pruneWebhookDeliveries（按分支保留，SSOT 在
// services/webhook-delivery-retention.ts）。历史上这里写死全局 200，比 state.ts 的
// 1000 还小，迁到 split 存储后把那次修复悄悄回退了，导致「main webhook 只剩 1 条」。
const MAX_SELF_UPDATE_HISTORY = 20;
const MAX_SELF_UPDATE_STEPS = 25;
const MAX_SERVICE_DEPLOYMENT_LOGS = 100;
const MAX_EVENT_TEXT_BYTES = 4 * 1024;
const MAX_CONTAINER_SNAPSHOT_LOG_BYTES = 8 * 1024;
const MAX_CONTAINER_ARCHIVE_LOG_BYTES = 16 * 1024;
const MAX_SERVICE_DEPLOYMENT_LOG_BYTES = 4 * 1024;
const MAX_SELF_UPDATE_ERROR_BYTES = 8 * 1024;
const MAX_SELF_UPDATE_STEP_TEXT_BYTES = 2 * 1024;
const MAX_GLOBAL_REST_BYTES = 12 * 1024 * 1024;

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function trimBufferTailToUtf8(buffer: Buffer, maxBytes: number): string {
  let text = buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString('utf8');
  while (Buffer.byteLength(text, 'utf8') > maxBytes) text = text.slice(1);
  return text;
}

function truncateTail(value: string | undefined, maxBytes: number): string | undefined {
  if (!value) return value;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) return value;
  const prefix = `[cds persisted tail: original ${bytes} bytes]\n`;
  const tailBudget = Math.max(0, maxBytes - Buffer.byteLength(prefix, 'utf8'));
  return `${prefix}${trimBufferTailToUtf8(Buffer.from(value), tailBudget)}`;
}

function sanitizeEvent(event: OperationLogEvent): OperationLogEvent {
  return {
    ...event,
    log: truncateTail(event.log, MAX_EVENT_TEXT_BYTES),
    chunk: truncateTail(event.chunk, MAX_EVENT_TEXT_BYTES),
  };
}

function sanitizeContainerSnapshot(snapshot: OperationLogContainerSnapshot): OperationLogContainerSnapshot {
  return {
    ...snapshot,
    logs: truncateTail(snapshot.logs, MAX_CONTAINER_SNAPSHOT_LOG_BYTES) || '',
  };
}

function sanitizeOperationLog(log: OperationLog): OperationLog {
  return {
    ...log,
    events: (log.events || []).slice(-MAX_EVENTS_PER_OPERATION_LOG).map(sanitizeEvent),
    containerLogSnapshots: (log.containerLogSnapshots || []).slice(-2).map(sanitizeContainerSnapshot),
  };
}

function sanitizeContainerArchive(entry: ContainerLogArchiveEntry): ContainerLogArchiveEntry {
  return {
    ...entry,
    logs: truncateTail(entry.logs, MAX_CONTAINER_ARCHIVE_LOG_BYTES) || '',
  };
}

function sanitizeServiceDeploymentLog(entry: ServiceDeploymentLogEntry): ServiceDeploymentLogEntry {
  return {
    ...entry,
    message: truncateTail(entry.message, MAX_SERVICE_DEPLOYMENT_LOG_BYTES) || '',
  };
}

function sanitizeServiceDeployment(deployment: ServiceDeployment): ServiceDeployment {
  return {
    ...deployment,
    logs: (deployment.logs || []).slice(-MAX_SERVICE_DEPLOYMENT_LOGS).map(sanitizeServiceDeploymentLog),
  };
}

function sanitizeSelfUpdateRecord(record: SelfUpdateRecord): SelfUpdateRecord {
  return {
    ...record,
    error: truncateTail(record.error, MAX_SELF_UPDATE_ERROR_BYTES),
    steps: record.steps?.slice(-MAX_SELF_UPDATE_STEPS).map((step) => ({
      ...step,
      text: truncateTail(step.text, MAX_SELF_UPDATE_STEP_TEXT_BYTES) || '',
    })),
  };
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function takeLastRecordEntries<T>(record: Record<string, T> | undefined, maxEntries: number): Record<string, T> {
  if (!record || maxEntries <= 0) return {};
  const entries = Object.entries(record);
  if (entries.length <= maxEntries) return record;
  return Object.fromEntries(entries.slice(-maxEntries)) as Record<string, T>;
}

function compactReleaseRuns(
  runs: Record<string, ReleaseRun> | undefined,
  maxEntries: number,
  maxLogsPerRun: number,
): Record<string, ReleaseRun> {
  const kept = takeLastRecordEntries(runs, maxEntries);
  return Object.fromEntries(Object.entries(kept).map(([id, run]) => [
    id,
    {
      ...run,
      logs: (run.logs || []).slice(-maxLogsPerRun).map((log) => ({
        ...log,
        message: truncateTail(log.message, MAX_SERVICE_DEPLOYMENT_LOG_BYTES) || '',
      })),
    },
  ]));
}

function compactGlobalRestToFit(restOfState: GlobalRest): GlobalRest {
  if (jsonByteLength(restOfState) <= MAX_GLOBAL_REST_BYTES) return restOfState;

  // These fields are diagnostic/history data. They must never make the
  // control-plane state unflushable; projects/branches already live in split
  // collections and stay intact.
  const retentionSteps = [200, 100, 50, 20, 10, 5, 0];
  for (const maxEntries of retentionSteps) {
    restOfState.logs = takeLastRecordEntries(restOfState.logs, maxEntries);
    restOfState.containerLogArchives = takeLastRecordEntries(restOfState.containerLogArchives, maxEntries);
    restOfState.serviceDeployments = takeLastRecordEntries(restOfState.serviceDeployments, maxEntries);
    restOfState.releaseRuns = compactReleaseRuns(restOfState.releaseRuns, maxEntries, Math.min(20, Math.max(0, maxEntries)));
    restOfState.activityLogs = Object.fromEntries(
      Object.entries(restOfState.activityLogs || {}).map(([projectId, logs]) => [
        projectId,
        (logs || []).slice(-Math.min(50, Math.max(0, maxEntries))) as ProjectActivityLog[],
      ]),
    );
    if (jsonByteLength(restOfState) <= MAX_GLOBAL_REST_BYTES) return restOfState;
  }

  return restOfState;
}

function globalRestOf(state: CdsState): GlobalRest {
  const restOfState: GlobalRest = { ...state } as CdsState;
  delete (restOfState as Partial<CdsState>).projects;
  delete (restOfState as Partial<CdsState>).branches;
  restOfState.logs = Object.fromEntries(
    Object.entries(state.logs || {}).map(([branchId, logs]) => [
      branchId,
      (logs || []).slice(-MAX_LOGS_PER_BRANCH).map(sanitizeOperationLog),
    ]),
  );
  restOfState.containerLogArchives = Object.fromEntries(
    Object.entries(state.containerLogArchives || {}).map(([branchId, archives]) => [
      branchId,
      (archives || []).slice(-MAX_CONTAINER_ARCHIVES_PER_BRANCH).map(sanitizeContainerArchive),
    ]),
  );
  restOfState.activityLogs = Object.fromEntries(
    Object.entries(state.activityLogs || {}).map(([projectId, logs]) => [
      projectId,
      (logs || []).slice(-MAX_ACTIVITY_LOGS_PER_PROJECT) as ProjectActivityLog[],
    ]),
  );
  restOfState.githubWebhookDeliveries = pruneWebhookDeliveries(state.githubWebhookDeliveries || []);
  delete (restOfState as Partial<CdsState>).selfUpdateHistory;
  restOfState.serviceDeployments = Object.fromEntries(
    Object.entries(state.serviceDeployments || {}).map(([deploymentId, deployment]) => [
      deploymentId,
      sanitizeServiceDeployment(deployment),
    ]),
  );
  // executor.runningContainers 是运行期派生字段（executor-registry 每次心跳重算，
  // 读取处以 `?? branches.length` 兜底），绝不应进入持久化文档。broadcastState
  // （唯一的 onSave 监听器）会在 save() 之后同步把它重新戳到 live state 上；写入
  // 合并把 structuredClone 推迟到 tick 末，故这个戳会被快照捕获。在持久化投影里
  // 剥掉它：既杜绝瞬态 runtime 数据落库（修复 PR #871 Codex P2「Preserve
  // save-call snapshot before deferring writes」），也让 runningContainers 抖动
  // 不再触发全局文档写。新增 onSave 监听器一律不得 mutate 会被持久化的字段。
  if (state.executors) {
    restOfState.executors = Object.fromEntries(
      Object.entries(state.executors).map(([id, node]) => {
        if (node.runningContainers === undefined) return [id, node];
        const { runningContainers: _dropped, ...rest } = node;
        return [id, rest];
      }),
    ) as CdsState['executors'];
  }
  return compactGlobalRestToFit(restOfState);
}

function selfUpdateRecordId(record: SelfUpdateRecord, index: number): string {
  const parts = [
    record.ts || `idx-${index}`,
    record.branch || 'current',
    record.fromSha || 'none',
    record.toSha || 'none',
    record.trigger || 'manual',
    record.status || 'unknown',
  ].map((part) => String(part).replace(/[^a-zA-Z0-9._:-]+/g, '-').slice(0, 80));
  return parts.join('__');
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
  // 写入合并（2026-06-21 性能修复）：高频 save() 不再每次都同步
  // structuredClone(整个 state)。那是 CDS master 事件循环被部署日志/调和器
  // save 风暴堵死的根因——网页 524、就绪探测超时、容器被误判部署失败而清理，
  // 都源于此。改为只记最新 live 引用 + 每个事件循环 tick 最多做一次快照克隆 +
  // 落盘。flush() 会强制立即快照，保证 delete/stop 等终止操作的持久化语义不变。
  private dirtyState: CdsState | null = null;
  private dirtyGeneration = 0;
  private snapshotScheduled = false;

  constructor(private readonly handle: ISplitMongoHandle) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.handle.connect();

    // 索引：cds_branches.projectId — per-project 查询是热路径。
    // createIndex 是 idempotent 安全 op，重复创建不会出错。
    try {
      await this.handle.branchesCollection().createIndex?.({ projectId: 1 }, { name: 'projectId_1' });
      await this.handle.selfUpdateHistoryCollection().createIndex?.({ ts: -1 }, { name: 'ts_-1' });
    } catch {
      // 如果 driver 不支持 createIndex 或权限不足，跳过 — 索引非功能必需。
    }

    const [globalDoc, projectDocs, branchDocs, selfUpdateDocs] = await Promise.all([
      this.handle.globalCollection().findOne({ _id: GLOBAL_DOC_ID }),
      this.handle.projectsCollection().find().toArray(),
      this.handle.branchesCollection().find().toArray(),
      this.handle.selfUpdateHistoryCollection().find().toArray(),
    ]);

    if (!globalDoc && projectDocs.length === 0 && branchDocs.length === 0 && selfUpdateDocs.length === 0) {
      // 全空 — fresh mongo, 让 StateService 走 emptyState + 跑 migration。
      this.cache = null;
    } else {
      // 重建 CdsState：global doc 提供主体，projects/branches 从 collection 拼回。
      const restOfState: GlobalRest = globalDoc
        ? globalDoc.state
        : ({} as GlobalRest);

      const branches: Record<string, BranchEntry> = {};
      for (const bd of branchDocs) branches[bd.doc.id] = bd.doc;
      const splitSelfUpdateHistory = selfUpdateDocs
        .map((doc) => doc.doc)
        .sort((a, b) => Date.parse(a.ts || '') - Date.parse(b.ts || ''))
        .filter(Boolean);
      const legacySelfUpdateHistory = restOfState.selfUpdateHistory || [];

      this.cache = {
        ...restOfState,
        selfUpdateHistory: (splitSelfUpdateHistory.length > 0 ? splitSelfUpdateHistory : legacySelfUpdateHistory)
          .slice(-MAX_SELF_UPDATE_HISTORY)
          .map(sanitizeSelfUpdateRecord),
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
    // load() 立即看到最新（引用，不克隆——克隆推迟到本 tick 末的 takeSnapshot）。
    this.cache = state;
    // 记最新 live 引用 + 逻辑代次；本 tick 内多次 save 只在末尾克隆一次。
    this.dirtyState = state;
    this.dirtyGeneration = ++this.writeGeneration;
    if (!this.snapshotScheduled) {
      this.snapshotScheduled = true;
      // setImmediate：把一连串同步 save（部署日志 append 风暴 / 调和器遍历分支）
      // 合并成本 tick 末的一次克隆 + 落盘，事件循环不再被反复同步阻塞。
      setImmediate(() => this.takeSnapshot());
    }
  }

  /**
   * 把当前 dirty 的 live state 克隆成不可变快照并入写队列（每 tick 至多一次）。
   * 异步写盘期间 live state 仍会被业务代码 mutate，故写入必须基于此刻的不可变快照。
   */
  private takeSnapshot(): void {
    this.snapshotScheduled = false;
    const live = this.dirtyState;
    if (!live) return;
    const generation = this.dirtyGeneration;
    this.dirtyState = null;
    const snapshot = structuredClone(live);
    this.cache = snapshot;
    this.pendingSnapshot = snapshot;
    this.pendingGeneration = generation;
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

    // ── 4) Self-update history collection（日志类字段独立落库）──
    const selfUpdateHistory = (snapshot.selfUpdateHistory || [])
      .slice(-MAX_SELF_UPDATE_HISTORY)
      .map(sanitizeSelfUpdateRecord);
    const previousSelfUpdateHistory = (previous?.selfUpdateHistory || [])
      .slice(-MAX_SELF_UPDATE_HISTORY)
      .map(sanitizeSelfUpdateRecord);
    const newHistoryIds = new Set(selfUpdateHistory.map((record, index) => selfUpdateRecordId(record, index)));
    const previousHistoryIds = new Set(previousSelfUpdateHistory.map((record, index) => selfUpdateRecordId(record, index)));
    const previousHistoryById = new Map(previousSelfUpdateHistory.map((record, index) => [selfUpdateRecordId(record, index), record]));
    const historyOps: unknown[] = [];
    selfUpdateHistory.forEach((record, index) => {
      const id = selfUpdateRecordId(record, index);
      const previousRecord = previousHistoryById.get(id);
      if (!previousRecord || stableJson(record) !== stableJson(previousRecord)) {
        historyOps.push({
          replaceOne: {
            filter: { _id: id },
            replacement: { _id: id, ts: record.ts || '', doc: record, updatedAt: now },
            upsert: true,
          },
        });
      }
    });
    for (const id of previousHistoryIds) {
      if (newHistoryIds.has(id)) continue;
      historyOps.push({ deleteOne: { filter: { _id: id } } });
    }
    if (historyOps.length > 0) {
      await this.handle.selfUpdateHistoryCollection().bulkWrite(historyOps);
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
    // 全量写覆盖任何挂起的增量快照，避免 takeSnapshot 再做一次冗余落盘。
    this.dirtyState = null;
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

    const history = (snapshot.selfUpdateHistory || [])
      .slice(-MAX_SELF_UPDATE_HISTORY)
      .map(sanitizeSelfUpdateRecord);
    const newHistoryIds = new Set(history.map((record, index) => selfUpdateRecordId(record, index)));
    const existingHistory = await this.handle.selfUpdateHistoryCollection().find().toArray();
    const historyOps: unknown[] = history.map((record, index) => {
      const id = selfUpdateRecordId(record, index);
      return {
        replaceOne: {
          filter: { _id: id },
          replacement: { _id: id, ts: record.ts || '', doc: record, updatedAt: now },
          upsert: true,
        },
      };
    });
    for (const id of existingHistory.map((d) => d._id)) {
      if (!newHistoryIds.has(id)) historyOps.push({ deleteOne: { filter: { _id: id } } });
    }
    if (historyOps.length > 0) await this.handle.selfUpdateHistoryCollection().bulkWrite(historyOps);
    this.persistedCache = structuredClone(snapshot);
    this.persistedGeneration = this.writeGeneration;
  }

  async flush(): Promise<void> {
    // 有未落盘的 dirty live state 时，先强制做一次快照入队——否则合并写推迟了
    // structuredClone，flush 等的 generation 永远进不了写管线、会一直挂起。
    if (this.dirtyState) this.takeSnapshot();
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
    const [globalCount, projectsCount, branchesCount, historyCount] = await Promise.all([
      this.handle.globalCollection().countDocuments({ _id: GLOBAL_DOC_ID }),
      this.handle.projectsCollection().countDocuments(),
      this.handle.branchesCollection().countDocuments(),
      this.handle.selfUpdateHistoryCollection().countDocuments(),
    ]);
    if (globalCount > 0 || projectsCount > 0 || branchesCount > 0 || historyCount > 0) return false;

    await this.forceFullSave(state);
    return true;
  }
}
