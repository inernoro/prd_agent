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
 * 增量快照 + 序列化缓存（2026-07-21）
 * ----------------------------------
 * save() 可带 StateSaveHint 声明脏范围：同一 tick 内全部带 hint 时只克隆被
 * 点名的 kind/实体（部分快照），否则退化为全量快照。diff 侧不再保留整份
 * persistedCache state，改为按实体 id 缓存「上次落库时的 stableJson 字符串」，
 * 每次只 stringify 当前侧与缓存比较——全量 state 的两次 structuredClone 与
 * previous 侧 stringify 全部消失。详见类内 dirty/persistedJson 字段注释。
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
  DeploymentRun,
  DeploymentRunEvent,
  DeploymentVersion,
  GithubWebhookDelivery,
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
import type { StateBackingStore, StateDirtyKind, StateSaveHint } from './backing-store.js';
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
  deploymentRunsCollection(): ISplitMongoCollection<{ _id: string; projectId: string; branchId: string; doc: DeploymentRun; updatedAt: string }>;
  deploymentVersionsCollection(): ISplitMongoCollection<{ _id: string; projectId: string; doc: DeploymentVersion; updatedAt: string }>;
  selfUpdateHistoryCollection(): ISplitMongoCollection<{ _id: string; ts: string; doc: SelfUpdateRecord; updatedAt: string }>;
  // 2026-07-09（debt.cds.state-json #1/#2）：webhook 投递与项目活动流从 global
  // 单文档拆独立 collection——消灭「每追加一条日志就重写整个 global doc」的写放大。
  webhookDeliveriesCollection(): ISplitMongoCollection<{ _id: string; receivedAt: string; doc: GithubWebhookDelivery; updatedAt: string }>;
  activityLogsCollection(): ISplitMongoCollection<{ _id: string; projectId: string; at: string; doc: ProjectActivityLog; updatedAt: string }>;
  close(): Promise<void>;
  ping(): Promise<boolean>;
}

export const GLOBAL_DOC_ID = 'global';

/**
 * "rest of CdsState" — 不含 projects 与 branches 的所有 root-level 字段。
 * 拆出来作为类型，方便 mongo 文档 schema 推导。
 */
export type GlobalRest = Omit<CdsState, 'projects' | 'branches' | 'deploymentRuns' | 'deploymentVersions'>;

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
const MAX_DEPLOYMENT_RUN_EVENTS = 500;
const MAX_EVENT_TEXT_BYTES = 4 * 1024;
const MAX_CONTAINER_SNAPSHOT_LOG_BYTES = 8 * 1024;
const MAX_CONTAINER_ARCHIVE_LOG_BYTES = 16 * 1024;
const MAX_SERVICE_DEPLOYMENT_LOG_BYTES = 4 * 1024;
const MAX_DEPLOYMENT_RUN_EVENT_BYTES = 8 * 1024;
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

function sanitizeDeploymentRunEvent(event: DeploymentRunEvent): DeploymentRunEvent {
  return {
    ...event,
    message: truncateTail(event.message, MAX_DEPLOYMENT_RUN_EVENT_BYTES) || '',
    evidenceRefs: event.evidenceRefs?.slice(0, 20),
  };
}

function sanitizeDeploymentRun(run: DeploymentRun): DeploymentRun {
  const events = (run.events || []).slice(-MAX_DEPLOYMENT_RUN_EVENTS).map(sanitizeDeploymentRunEvent);
  return {
    ...run,
    events,
    firstEventSeq: events[0]?.seq || run.seq,
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
    if (jsonByteLength(restOfState) <= MAX_GLOBAL_REST_BYTES) return restOfState;
  }

  return restOfState;
}

function globalRestOf(state: CdsState): GlobalRest {
  const restOfState: GlobalRest = { ...state } as CdsState;
  delete (restOfState as Partial<CdsState>).projects;
  delete (restOfState as Partial<CdsState>).branches;
  delete (restOfState as Partial<CdsState>).deploymentRuns;
  delete (restOfState as Partial<CdsState>).deploymentVersions;
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
  // 2026-07-09（debt.cds.state-json #1/#2）：这两类日志字段已拆独立 collection
  // （cds_activity_logs / cds_webhook_deliveries），global doc 不再携带——追加一条
  // 日志不再重写整份 global 文档。
  delete (restOfState as Partial<CdsState>).activityLogs;
  delete (restOfState as Partial<CdsState>).githubWebhookDeliveries;
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

/** cds_webhook_deliveries 的 _id — delivery.id 全局唯一（github delivery guid）。 */
function webhookDeliveryDocId(delivery: GithubWebhookDelivery): string {
  return String(delivery.id || '').replace(/[^a-zA-Z0-9._:-]+/g, '-').slice(0, 120) || 'unknown';
}

/**
 * cds_activity_logs 的复合 _id — log.id（`<projectId>:<seq>`）的 seq 是每项目
 * 递增但**非持久**（重启后可能从头计数），单用 log.id 会在重启后撞 _id。
 * 复合上 at 时间戳后实践上唯一。
 */
function activityLogDocId(projectId: string, log: ProjectActivityLog): string {
  const parts = [projectId, log.at || '', log.id || ''].map((part) =>
    String(part).replace(/[^a-zA-Z0-9._:-]+/g, '-').slice(0, 80),
  );
  return parts.join('__');
}

/** 重建 activityLogs 内存序：按时间升序，同一时刻按 log.id 里的 seq 升序。 */
function activityLogSortKey(log: ProjectActivityLog): [number, number] {
  const ts = Date.parse(log.at || '');
  const seq = Number.parseInt(String(log.id || '').split(':').pop() || '', 10);
  return [Number.isNaN(ts) ? 0 : ts, Number.isNaN(seq) ? 0 : seq];
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

/** save() hint 可以按实体 id 收窄的 kind（其余 kind 只支持 kind 级脏标记）。 */
const ENTITY_SCOPED_KINDS: ReadonlySet<StateDirtyKind> = new Set([
  'projects',
  'branches',
  'deploymentRuns',
  'deploymentVersions',
]);

/**
 * 部分快照里单个 kind 的切片。ids 是该 kind 此刻的**完整** id 集 —— 删除检测
 * 只需要 id 集不需要实体内容，所以哪怕 hint 只点名一个实体，同 kind 内的
 * prune/删除也能被正确落库。entities 只含本 tick 被点名克隆的实体。
 */
interface EntitySlice<T> {
  ids: Set<string>;
  entities: Map<string, T>;
}

/** 一次待落盘的写入。full 非空 = 全量快照路径，忽略所有切片字段。 */
interface PendingWrite {
  generation: number;
  full: CdsState | null;
  projects?: EntitySlice<Project>;
  branches?: EntitySlice<BranchEntry>;
  deploymentRuns?: EntitySlice<DeploymentRun>;
  deploymentVersions?: EntitySlice<DeploymentVersion>;
  selfUpdateHistory?: SelfUpdateRecord[];
  webhookDeliveries?: GithubWebhookDelivery[];
  activityLogs?: Record<string, ProjectActivityLog[]>;
  globalRest?: GlobalRest;
}

/** 把 record 型 state 切片按脏 id 集克隆成 EntitySlice（dirtyIds=null 表示整 kind 克隆）。 */
function sliceEntities<T>(source: Record<string, T>, dirtyIds: Set<string> | null): EntitySlice<T> {
  const ids = new Set(Object.keys(source));
  const entities = new Map<string, T>();
  if (dirtyIds === null) {
    for (const [id, value] of Object.entries(source)) entities.set(id, structuredClone(value));
  } else {
    for (const id of dirtyIds) {
      const value = source[id];
      if (value !== undefined) entities.set(id, structuredClone(value));
    }
  }
  return { ids, entities };
}

/**
 * 合并两个部分快照（仅当写入在途、上一个 partial 还没被消费时发生）。
 * 实体切片：id 集取新值（删除检测要看最新全集），实体克隆做并集、新值覆盖旧值
 * —— 旧克隆里已被删除的实体会在 persist 时被「id 集为准」的守卫跳过。
 * 列表/global 切片整体以新值替换（它们本身就是整 kind 克隆）。
 */
function mergePendingPartials(target: PendingWrite, next: PendingWrite): PendingWrite {
  const mergeSlice = <T>(a: EntitySlice<T> | undefined, b: EntitySlice<T> | undefined): EntitySlice<T> | undefined => {
    if (!b) return a;
    if (!a) return b;
    return { ids: b.ids, entities: new Map([...a.entities, ...b.entities]) };
  };
  return {
    generation: next.generation,
    full: null,
    projects: mergeSlice(target.projects, next.projects),
    branches: mergeSlice(target.branches, next.branches),
    deploymentRuns: mergeSlice(target.deploymentRuns, next.deploymentRuns),
    deploymentVersions: mergeSlice(target.deploymentVersions, next.deploymentVersions),
    selfUpdateHistory: next.selfUpdateHistory ?? target.selfUpdateHistory,
    webhookDeliveries: next.webhookDeliveries ?? target.webhookDeliveries,
    activityLogs: next.activityLogs ?? target.activityLogs,
    globalRest: next.globalRest ?? target.globalRest,
  };
}

/** self-update 历史 → (docId, 已裁剪/清洗记录) 候选对，与落库口径一致。 */
function selfUpdateCandidates(list: SelfUpdateRecord[] | undefined): Array<[string, SelfUpdateRecord]> {
  return (list || [])
    .slice(-MAX_SELF_UPDATE_HISTORY)
    .map(sanitizeSelfUpdateRecord)
    .map((record, index): [string, SelfUpdateRecord] => [selfUpdateRecordId(record, index), record]);
}

/** webhook 投递 → (docId, 投递) 候选对（先过保留策略，与落库口径一致）。 */
function webhookDeliveryCandidates(list: GithubWebhookDelivery[] | undefined): Array<[string, GithubWebhookDelivery]> {
  return pruneWebhookDeliveries(list || []).map(
    (delivery): [string, GithubWebhookDelivery] => [webhookDeliveryDocId(delivery), delivery],
  );
}

/** 项目活动流 → (docId, {projectId, log}) 候选对（每项目 ring buffer 裁剪后）。 */
function activityLogCandidates(
  logs: Record<string, ProjectActivityLog[]> | undefined,
): Array<[string, { projectId: string; log: ProjectActivityLog }]> {
  const out: Array<[string, { projectId: string; log: ProjectActivityLog }]> = [];
  for (const [projectId, list] of Object.entries(logs || {})) {
    for (const log of (list || []).slice(-MAX_ACTIVITY_LOGS_PER_PROJECT)) {
      out.push([activityLogDocId(projectId, log), { projectId, log }]);
    }
  }
  return out;
}

export class MongoSplitStateBackingStore implements StateBackingStore {
  readonly kind = 'mongo-split' as const;
  private cache: CdsState | null = null;
  private initialized = false;
  private pendingWrite: PendingWrite | null = null;
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
  //
  // 增量快照（2026-07-21 性能重构）：在写入合并之上再加两层，消除 O(state)
  // 全量成本（state 随部署历史增长到几十 MB 后，每 tick 一次全量 clone + 双侧
  // stringify 依然会轮番冻结事件循环）：
  //   1. 脏范围追踪 —— save() 可带 StateSaveHint；同一 tick 内所有 save 都带
  //      hint 时，takeSnapshot 只克隆被点名的 kind/实体（部分快照），不再
  //      structuredClone 整个 state。任何一次无 hint 的 save 让该 tick 退化为
  //      全量快照，保正确性。
  //   2. 序列化缓存 —— 按实体 id 缓存「上次落库时的 stableJson 字符串」，diff
  //      只 stringify 当前侧再与缓存字符串比较；persistedCache 整份 state 的
  //      第二次 structuredClone（旧 drainWrites 尾部）随之删除。
  private dirtyState: CdsState | null = null;
  // 最近一次 save/forceFullSave 传入的 live state 引用(与 dirtyState 不同,
  // takeSnapshot 后不清空)。写失败恢复路径用它就地重建全量快照,见 drainWrites catch。
  private liveStateRef: CdsState | null = null;
  private dirtyGeneration = 0;
  private dirtyAll = false;
  private dirtyKinds = new Set<StateDirtyKind>();
  private dirtyIds = new Map<StateDirtyKind, Set<string> | null>();
  private snapshotScheduled = false;
  // 一次（可能部分成功的）写入失败后，被丢弃的 pending 内容无法靠后续 hint
  // 快照找回 —— 置位后下一次 takeSnapshot 强制全量，重新与序列化缓存对账。
  private needFullResync = false;
  // 序列化缓存本体：每实体一条「上次成功落库时的 stableJson」。bulkWrite 成功
  // 后才更新，失败时缓存仍反映 DB 真实内容，重试会重新 diff（崩溃一致性不变）。
  private persistedJson = {
    projects: new Map<string, string>(),
    branches: new Map<string, string>(),
    deploymentRuns: new Map<string, string>(),
    deploymentVersions: new Map<string, string>(),
    selfUpdateHistory: new Map<string, string>(),
    webhookDeliveries: new Map<string, string>(),
    activityLogs: new Map<string, string>(),
  };
  private persistedGlobalJson: string | null = null;
  // init() 从 global doc 的 legacy 内嵌字段（selfUpdateHistory / 两类日志）回退读过
  // 数据时置位：下一次 persistSnapshot 必须强制重写 global doc 一次，把 legacy
  // 字段从 DB 里剥掉——否则 diff 看不到差异（两侧投影都已 delete 这些字段），
  // 陈旧的大日志会永远赖在 global 单文档里。
  private forceGlobalRewrite = false;

  constructor(private readonly handle: ISplitMongoHandle) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.handle.connect();

    // 索引：cds_branches.projectId — per-project 查询是热路径。
    // createIndex 是 idempotent 安全 op，重复创建不会出错。
    try {
      await this.handle.branchesCollection().createIndex?.({ projectId: 1 }, { name: 'projectId_1' });
      await this.handle.deploymentRunsCollection().createIndex?.({ projectId: 1, branchId: 1 }, { name: 'projectId_1_branchId_1' });
      await this.handle.deploymentVersionsCollection().createIndex?.({ projectId: 1 }, { name: 'projectId_1' });
      await this.handle.selfUpdateHistoryCollection().createIndex?.({ ts: -1 }, { name: 'ts_-1' });
      // 2026-07-09 拆分出的两个日志 collection：按项目/时间的读路径索引。
      // 沿用本文件既有惯例（split store 自建自己的索引，idempotent），CDS 运维
      // 不依赖 DBA 手动执行；guide.platform.mongodb-indexes.md CDS 段仅作记录备查。
      await this.handle.activityLogsCollection().createIndex?.({ projectId: 1, at: -1 }, { name: 'projectId_1_at_-1' });
      await this.handle.webhookDeliveriesCollection().createIndex?.({ receivedAt: -1 }, { name: 'receivedAt_-1' });
    } catch {
      // 如果 driver 不支持 createIndex 或权限不足，跳过 — 索引非功能必需。
    }

    const [
      globalDoc,
      projectDocs,
      branchDocs,
      deploymentRunDocs,
      deploymentVersionDocs,
      selfUpdateDocs,
      deliveryDocs,
      activityDocs,
    ] = await Promise.all([
      this.handle.globalCollection().findOne({ _id: GLOBAL_DOC_ID }),
      this.handle.projectsCollection().find().toArray(),
      this.handle.branchesCollection().find().toArray(),
      this.handle.deploymentRunsCollection().find().toArray(),
      this.handle.deploymentVersionsCollection().find().toArray(),
      this.handle.selfUpdateHistoryCollection().find().toArray(),
      this.handle.webhookDeliveriesCollection().find().toArray(),
      this.handle.activityLogsCollection().find().toArray(),
    ]);

    if (
      !globalDoc &&
      projectDocs.length === 0 &&
      branchDocs.length === 0 &&
      deploymentRunDocs.length === 0 &&
      deploymentVersionDocs.length === 0 &&
      selfUpdateDocs.length === 0 &&
      deliveryDocs.length === 0 &&
      activityDocs.length === 0
    ) {
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

      // webhook 投递 / 活动流：优先读独立 collection；空则回退 global doc 里的
      // legacy 字段（升级首启零迁移——首次落盘即写入新 collection 并从 global 剥离）。
      const splitDeliveries = deliveryDocs
        .map((doc) => doc.doc)
        .filter(Boolean)
        .sort((a, b) => {
          const diff = Date.parse(a.receivedAt || '') - Date.parse(b.receivedAt || '');
          return diff !== 0 ? diff : String(a.id).localeCompare(String(b.id));
        });
      const legacyDeliveries = restOfState.githubWebhookDeliveries || [];

      const splitActivityLogs: Record<string, ProjectActivityLog[]> = {};
      for (const doc of activityDocs) {
        if (!doc.doc) continue;
        (splitActivityLogs[doc.projectId] ||= []).push(doc.doc);
      }
      for (const logs of Object.values(splitActivityLogs)) {
        logs.sort((a, b) => {
          const [ta, sa] = activityLogSortKey(a);
          const [tb, sb] = activityLogSortKey(b);
          return ta !== tb ? ta - tb : sa - sb;
        });
      }
      const legacyActivityLogs = restOfState.activityLogs || {};

      if (
        restOfState.selfUpdateHistory !== undefined ||
        restOfState.githubWebhookDeliveries !== undefined ||
        restOfState.activityLogs !== undefined
      ) {
        this.forceGlobalRewrite = true;
      }

      const rebuilt = {
        ...restOfState,
        selfUpdateHistory: (splitSelfUpdateHistory.length > 0 ? splitSelfUpdateHistory : legacySelfUpdateHistory)
          .slice(-MAX_SELF_UPDATE_HISTORY)
          .map(sanitizeSelfUpdateRecord),
        githubWebhookDeliveries: pruneWebhookDeliveries(
          splitDeliveries.length > 0 ? splitDeliveries : legacyDeliveries,
        ),
        activityLogs: Object.fromEntries(
          Object.entries(activityDocs.length > 0 ? splitActivityLogs : legacyActivityLogs).map(
            ([projectId, logs]) => [projectId, (logs || []).slice(-MAX_ACTIVITY_LOGS_PER_PROJECT)],
          ),
        ),
        projects: projectDocs.map((pd) => pd.doc),
        branches,
        deploymentRuns: Object.fromEntries(deploymentRunDocs.map((record) => [record.doc.id, sanitizeDeploymentRun(record.doc)])),
        deploymentVersions: Object.fromEntries(deploymentVersionDocs.map((record) => [record.doc.id, record.doc])),
      } as CdsState;
      this.cache = rebuilt;

      // 序列化缓存必须表示「split collection 里现在真的有什么」。legacy 回退
      // 读进内存的数据尚未写入 split collection——对应 kind 的缓存保持为空，
      // 首次持久化的 diff 才会把 legacy 数据 upsert 搬家，而不是「diff 无变化 +
      // global 被剥离」造成迁移丢数据。
      this.rebuildSerializedCaches(rebuilt, {
        includeSelfUpdate: splitSelfUpdateHistory.length > 0,
        includeDeliveries: splitDeliveries.length > 0,
        includeActivity: activityDocs.length > 0,
      });
      this.initialized = true;
      return;
    }
    // fresh mongo：缓存保持空，首次持久化即全量 upsert。
    this.initialized = true;
  }

  /**
   * 用给定 state 重建序列化缓存（init / forceFullSave 之后调用）。
   * 各 kind 的字符串口径与持久化路径完全一致（同一 sanitize/裁剪 + stableJson），
   * 保证后续 diff 的字符串比较不产生假差异。
   */
  private rebuildSerializedCaches(
    state: CdsState,
    opts: { includeSelfUpdate: boolean; includeDeliveries: boolean; includeActivity: boolean },
  ): void {
    this.persistedJson.projects = new Map(
      (state.projects || []).map((project): [string, string] => [project.id, stableJson(project)]),
    );
    this.persistedJson.branches = new Map(
      Object.values(state.branches || {}).map((branch): [string, string] => [branch.id, stableJson(branch)]),
    );
    this.persistedJson.deploymentRuns = new Map(
      Object.entries(state.deploymentRuns || {}).map(
        ([id, run]): [string, string] => [id, stableJson(sanitizeDeploymentRun(run))],
      ),
    );
    this.persistedJson.deploymentVersions = new Map(
      Object.entries(state.deploymentVersions || {}).map(
        ([id, version]): [string, string] => [id, stableJson(version)],
      ),
    );
    this.persistedJson.selfUpdateHistory = opts.includeSelfUpdate
      ? new Map(selfUpdateCandidates(state.selfUpdateHistory).map(
          ([id, record]): [string, string] => [id, stableJson(record)],
        ))
      : new Map();
    this.persistedJson.webhookDeliveries = opts.includeDeliveries
      ? new Map(webhookDeliveryCandidates(state.githubWebhookDeliveries).map(
          ([id, delivery]): [string, string] => [id, stableJson(delivery)],
        ))
      : new Map();
    this.persistedJson.activityLogs = opts.includeActivity
      ? new Map(activityLogCandidates(state.activityLogs).map(
          ([id, entry]): [string, string] => [id, stableJson(entry.log)],
        ))
      : new Map();
    this.persistedGlobalJson = stableJson(globalRestOf(state));
  }

  load(): CdsState | null {
    return this.cache;
  }

  save(state: CdsState, hints?: StateSaveHint[]): void {
    // load() 立即看到最新（引用，不克隆——克隆推迟到本 tick 末的 takeSnapshot）。
    this.cache = state;
    // 记最新 live 引用 + 逻辑代次；本 tick 内多次 save 只在末尾克隆一次。
    this.dirtyState = state;
    this.liveStateRef = state;
    this.dirtyGeneration = ++this.writeGeneration;
    if (!hints || hints.length === 0) {
      // 无 hint = 调用方没有（或无法）声明改动范围 → 本 tick 退化为全量快照。
      this.dirtyAll = true;
    } else if (!this.dirtyAll) {
      for (const hint of hints) this.noteHint(hint);
    }
    if (!this.snapshotScheduled) {
      this.snapshotScheduled = true;
      // setImmediate：把一连串同步 save（部署日志 append 风暴 / 调和器遍历分支）
      // 合并成本 tick 末的一次克隆 + 落盘，事件循环不再被反复同步阻塞。
      setImmediate(() => this.takeSnapshot());
    }
  }

  /** 累积一条脏范围声明（实体级 kind 支持按 id 收窄，重复声明自动并集）。 */
  private noteHint(hint: StateSaveHint): void {
    this.dirtyKinds.add(hint.kind);
    if (!ENTITY_SCOPED_KINDS.has(hint.kind)) return;
    const existing = this.dirtyIds.get(hint.kind);
    if (existing === null) return; // 已整 kind 脏
    if (!hint.id) {
      this.dirtyIds.set(hint.kind, null);
      return;
    }
    if (existing) existing.add(hint.id);
    else this.dirtyIds.set(hint.kind, new Set([hint.id]));
  }

  /**
   * 把当前 dirty 的 live state 固化成不可变待写内容并入写队列（每 tick 至多一次）。
   * 异步写盘期间 live state 仍会被业务代码 mutate，故写入必须基于此刻的克隆：
   * 全量路径克隆整个 state；hint 路径只克隆被点名的 kind/实体（部分快照）。
   */
  private takeSnapshot(): void {
    this.snapshotScheduled = false;
    const live = this.dirtyState;
    if (!live) return;
    const generation = this.dirtyGeneration;
    this.dirtyState = null;
    // 队列里若还挂着一个全量快照（写入被慢 IO 拖住时可能发生），部分快照无法
    // 与它合并出正确语义 —— 直接升级为新的全量快照整体替换（live ⊇ 一切 pending）。
    const useFull = this.dirtyAll || this.needFullResync || this.pendingWrite?.full != null;
    const kinds = this.dirtyKinds;
    const idMap = this.dirtyIds;
    this.dirtyAll = false;
    this.dirtyKinds = new Set();
    this.dirtyIds = new Map();
    if (useFull) {
      this.needFullResync = false;
      const snapshot = structuredClone(live);
      this.cache = snapshot;
      this.pendingWrite = { generation, full: snapshot };
    } else {
      const partial = this.buildPartial(live, kinds, idMap, generation);
      this.pendingWrite = this.pendingWrite
        ? mergePendingPartials(this.pendingWrite, partial)
        : partial;
    }
    this.drainWrites();
  }

  /** 按脏范围构建部分快照：只克隆被点名的 kind/实体，id 集用于删除检测。 */
  private buildPartial(
    live: CdsState,
    kinds: Set<StateDirtyKind>,
    idMap: Map<StateDirtyKind, Set<string> | null>,
    generation: number,
  ): PendingWrite {
    const pending: PendingWrite = { generation, full: null };
    // init 从 legacy 内嵌字段回退读过数据时必须尽快重写 global doc 剥离 legacy
    // 字段——哪怕后续 save 全是非 global 的 hint。
    if (this.forceGlobalRewrite) kinds.add('global');
    for (const kind of kinds) {
      const dirtyIds = idMap.get(kind) ?? null;
      switch (kind) {
        case 'projects':
          pending.projects = sliceEntities(
            Object.fromEntries((live.projects || []).map((project) => [project.id, project])),
            dirtyIds,
          );
          break;
        case 'branches':
          pending.branches = sliceEntities(live.branches || {}, dirtyIds);
          break;
        case 'deploymentRuns':
          pending.deploymentRuns = sliceEntities(live.deploymentRuns || {}, dirtyIds);
          break;
        case 'deploymentVersions':
          pending.deploymentVersions = sliceEntities(live.deploymentVersions || {}, dirtyIds);
          break;
        case 'selfUpdateHistory':
          pending.selfUpdateHistory = structuredClone(live.selfUpdateHistory || []);
          break;
        case 'webhookDeliveries':
          pending.webhookDeliveries = structuredClone(live.githubWebhookDeliveries || []);
          break;
        case 'activityLogs':
          pending.activityLogs = structuredClone(live.activityLogs || {});
          break;
        case 'global':
          // globalRestOf 的投影是浅拷贝（与 live 共享深层对象），克隆后才能安全
          // 地在异步写盘期间使用。
          pending.globalRest = structuredClone(globalRestOf(live));
          break;
      }
    }
    return pending;
  }

  /**
   * 通用「候选实体 vs 序列化缓存」同步：只 stringify 当前侧，与缓存的上次落库
   * 字符串比较；删除检测 = 缓存 key 集 − 当前 id 集。bulkWrite 成功后才更新缓存。
   */
  private async syncCollection<T>(input: {
    collection: { bulkWrite(operations: Array<unknown>): Promise<unknown> };
    cache: Map<string, string>;
    currentIds: ReadonlySet<string>;
    candidates: Iterable<[string, T]>;
    serialize: (id: string, entity: T) => { json: string; replacement: Record<string, unknown> };
  }): Promise<void> {
    const ops: unknown[] = [];
    const upserts: Array<[string, string]> = [];
    const removals: string[] = [];
    for (const [id, entity] of input.candidates) {
      // 合并期间可能残留「已被删除实体」的旧克隆——以最新 id 集为准跳过。
      if (!input.currentIds.has(id)) continue;
      const { json, replacement } = input.serialize(id, entity);
      if (input.cache.get(id) === json) continue;
      ops.push({ replaceOne: { filter: { _id: id }, replacement, upsert: true } });
      upserts.push([id, json]);
    }
    for (const id of input.cache.keys()) {
      if (input.currentIds.has(id)) continue;
      ops.push({ deleteOne: { filter: { _id: id } } });
      removals.push(id);
    }
    if (ops.length === 0) return;
    await input.collection.bulkWrite(ops);
    for (const [id, json] of upserts) input.cache.set(id, json);
    for (const id of removals) input.cache.delete(id);
  }

  private async persistProjects(currentIds: ReadonlySet<string>, candidates: Iterable<[string, Project]>, now: string): Promise<void> {
    await this.syncCollection({
      collection: this.handle.projectsCollection(),
      cache: this.persistedJson.projects,
      currentIds,
      candidates,
      serialize: (id, project) => ({
        json: stableJson(project),
        replacement: { _id: id, doc: project, updatedAt: now },
      }),
    });
  }

  private async persistBranches(currentIds: ReadonlySet<string>, candidates: Iterable<[string, BranchEntry]>, now: string): Promise<void> {
    await this.syncCollection({
      collection: this.handle.branchesCollection(),
      cache: this.persistedJson.branches,
      currentIds,
      candidates,
      serialize: (id, branch) => ({
        json: stableJson(branch),
        replacement: { _id: id, projectId: branch.projectId, doc: branch, updatedAt: now },
      }),
    });
  }

  private async persistDeploymentRuns(currentIds: ReadonlySet<string>, candidates: Iterable<[string, DeploymentRun]>, now: string): Promise<void> {
    await this.syncCollection({
      collection: this.handle.deploymentRunsCollection(),
      cache: this.persistedJson.deploymentRuns,
      currentIds,
      candidates,
      serialize: (id, run) => {
        const sanitized = sanitizeDeploymentRun(run);
        return {
          json: stableJson(sanitized),
          replacement: {
            _id: id,
            projectId: sanitized.projectId,
            branchId: sanitized.branchId,
            doc: sanitized,
            updatedAt: now,
          },
        };
      },
    });
  }

  private async persistDeploymentVersions(currentIds: ReadonlySet<string>, candidates: Iterable<[string, DeploymentVersion]>, now: string): Promise<void> {
    await this.syncCollection({
      collection: this.handle.deploymentVersionsCollection(),
      cache: this.persistedJson.deploymentVersions,
      currentIds,
      candidates,
      serialize: (id, version) => ({
        json: stableJson(version),
        replacement: { _id: id, projectId: version.projectId, doc: version, updatedAt: now },
      }),
    });
  }

  private async persistSelfUpdateHistory(list: SelfUpdateRecord[] | undefined, now: string): Promise<void> {
    const candidates = selfUpdateCandidates(list);
    await this.syncCollection({
      collection: this.handle.selfUpdateHistoryCollection(),
      cache: this.persistedJson.selfUpdateHistory,
      currentIds: new Set(candidates.map(([id]) => id)),
      candidates,
      serialize: (id, record) => ({
        json: stableJson(record),
        replacement: { _id: id, ts: record.ts || '', doc: record, updatedAt: now },
      }),
    });
  }

  private async persistWebhookDeliveries(list: GithubWebhookDelivery[] | undefined, now: string): Promise<void> {
    const candidates = webhookDeliveryCandidates(list);
    await this.syncCollection({
      collection: this.handle.webhookDeliveriesCollection(),
      cache: this.persistedJson.webhookDeliveries,
      currentIds: new Set(candidates.map(([id]) => id)),
      candidates,
      serialize: (id, delivery) => ({
        json: stableJson(delivery),
        replacement: { _id: id, receivedAt: delivery.receivedAt || '', doc: delivery, updatedAt: now },
      }),
    });
  }

  private async persistActivityLogs(logs: Record<string, ProjectActivityLog[]> | undefined, now: string): Promise<void> {
    const candidates = activityLogCandidates(logs);
    await this.syncCollection({
      collection: this.handle.activityLogsCollection(),
      cache: this.persistedJson.activityLogs,
      currentIds: new Set(candidates.map(([id]) => id)),
      candidates,
      serialize: (id, entry) => ({
        json: stableJson(entry.log),
        replacement: { _id: id, projectId: entry.projectId, at: entry.log.at || '', doc: entry.log, updatedAt: now },
      }),
    });
  }

  /** global rest 单文档：字符串级 diff（缓存上次落库的 stableJson），命中即零写。 */
  private async persistGlobalRest(restOfState: GlobalRest, now: string): Promise<void> {
    const json = stableJson(restOfState);
    if (!this.forceGlobalRewrite && this.persistedGlobalJson === json) return;
    await this.handle.globalCollection().replaceOne(
      { _id: GLOBAL_DOC_ID },
      { _id: GLOBAL_DOC_ID, state: restOfState, updatedAt: now },
      { upsert: true },
    );
    this.persistedGlobalJson = json;
    this.forceGlobalRewrite = false;
  }

  /** 全量快照落库：所有 kind 走同一套「当前侧 stringify vs 序列化缓存」diff。 */
  private async persistFull(snapshot: CdsState): Promise<void> {
    const now = new Date().toISOString();
    const projects = snapshot.projects || [];
    await this.persistProjects(
      new Set(projects.map((project) => project.id)),
      projects.map((project): [string, Project] => [project.id, project]),
      now,
    );
    await this.persistBranches(
      new Set(Object.keys(snapshot.branches || {})),
      Object.entries(snapshot.branches || {}),
      now,
    );
    await this.persistDeploymentRuns(
      new Set(Object.keys(snapshot.deploymentRuns || {})),
      Object.entries(snapshot.deploymentRuns || {}),
      now,
    );
    await this.persistDeploymentVersions(
      new Set(Object.keys(snapshot.deploymentVersions || {})),
      Object.entries(snapshot.deploymentVersions || {}),
      now,
    );
    await this.persistSelfUpdateHistory(snapshot.selfUpdateHistory, now);
    await this.persistWebhookDeliveries(snapshot.githubWebhookDeliveries, now);
    await this.persistActivityLogs(snapshot.activityLogs, now);
    // global 刻意放最后：legacy 迁移首启时先把日志类数据 upsert 进 split
    // collection，再从 global doc 剥离，中途崩溃也不丢。
    await this.persistGlobalRest(globalRestOf(snapshot), now);
  }

  /** 部分快照落库：只处理本次被标脏的 kind，顺序与全量路径一致（global 最后）。 */
  private async persistPartial(pending: PendingWrite): Promise<void> {
    const now = new Date().toISOString();
    if (pending.projects) await this.persistProjects(pending.projects.ids, pending.projects.entities, now);
    if (pending.branches) await this.persistBranches(pending.branches.ids, pending.branches.entities, now);
    if (pending.deploymentRuns) await this.persistDeploymentRuns(pending.deploymentRuns.ids, pending.deploymentRuns.entities, now);
    if (pending.deploymentVersions) await this.persistDeploymentVersions(pending.deploymentVersions.ids, pending.deploymentVersions.entities, now);
    if (pending.selfUpdateHistory) await this.persistSelfUpdateHistory(pending.selfUpdateHistory, now);
    if (pending.webhookDeliveries) await this.persistWebhookDeliveries(pending.webhookDeliveries, now);
    if (pending.activityLogs) await this.persistActivityLogs(pending.activityLogs, now);
    if (pending.globalRest) await this.persistGlobalRest(pending.globalRest, now);
  }

  private drainWrites(): void {
    if (this.writeInFlight) return;
    this.writeInFlight = true;
    void (async () => {
      let generation = 0;
      try {
        while (this.pendingWrite) {
          const pending = this.pendingWrite;
          generation = pending.generation;
          this.pendingWrite = null;
          if (pending.full) await this.persistFull(pending.full);
          else await this.persistPartial(pending);
          this.persistedGeneration = generation;
          this.lastWriteError = null;
          this.resolveFlushWaiters();
        }
      } catch (err) {
        this.failedGeneration = Math.max(this.failedGeneration, generation);
        this.lastWriteError = err;
        // 失败的 pending 已被消费丢弃，其中的变更无法靠后续 hint 快照找回；
        // 序列化缓存只在写成功后更新、仍反映 DB 真实内容，下一次 takeSnapshot
        // 强制全量即可把丢失的变更重新 diff 回来。
        this.needFullResync = true;
        // Codex P1(PR #1213)：写失败期间若已有下一笔 partial 排队，finally 会
        // 立即把它以 partial 落库 → persistedGeneration 越过失败代次，flush()
        // 谎报成功而失败变更仍缺失，要等下一次无关 save 才被全量对账补回。
        // 修复：把排队中的 partial 就地升级为全量快照 —— live state 包含全部
        // 业务变更，序列化缓存仍反映 DB 真相，全量 diff 会把被丢弃的变更一并
        // 找回（排队中的本就是 full 则它自身即对账，两种情况都消费 needFullResync）。
        const queued = this.pendingWrite;
        if (queued && !queued.full && this.liveStateRef) {
          const snapshot = structuredClone(this.liveStateRef);
          this.cache = snapshot;
          this.pendingWrite = { generation: queued.generation, full: snapshot };
          this.needFullResync = false;
        } else if (queued?.full) {
          this.needFullResync = false;
        }
        this.rejectFlushWaiters(err);
      } finally {
        this.writeInFlight = false;
        if (this.pendingWrite) this.drainWrites();
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
    this.liveStateRef = state;
    this.dirtyState = null;
    this.dirtyAll = false;
    this.dirtyKinds = new Set();
    this.dirtyIds = new Map();
    this.pendingWrite = null;
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

    const runs = Object.values(snapshot.deploymentRuns || {}).map(sanitizeDeploymentRun);
    const newRunIds = new Set(runs.map((run) => run.id));
    const existingRuns = await this.handle.deploymentRunsCollection().find().toArray();
    const runOps: unknown[] = runs.map((run) => ({
      replaceOne: {
        filter: { _id: run.id },
        replacement: {
          _id: run.id,
          projectId: run.projectId,
          branchId: run.branchId,
          doc: run,
          updatedAt: now,
        },
        upsert: true,
      },
    }));
    for (const id of existingRuns.map((record) => record._id)) {
      if (!newRunIds.has(id)) runOps.push({ deleteOne: { filter: { _id: id } } });
    }
    if (runOps.length > 0) await this.handle.deploymentRunsCollection().bulkWrite(runOps);

    const versions = Object.values(snapshot.deploymentVersions || {});
    const newVersionIds = new Set(versions.map((version) => version.id));
    const existingVersions = await this.handle.deploymentVersionsCollection().find().toArray();
    const versionOps: unknown[] = versions.map((version) => ({
      replaceOne: {
        filter: { _id: version.id },
        replacement: {
          _id: version.id,
          projectId: version.projectId,
          doc: version,
          updatedAt: now,
        },
        upsert: true,
      },
    }));
    for (const id of existingVersions.map((record) => record._id)) {
      if (!newVersionIds.has(id)) versionOps.push({ deleteOne: { filter: { _id: id } } });
    }
    if (versionOps.length > 0) await this.handle.deploymentVersionsCollection().bulkWrite(versionOps);

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

    // Webhook deliveries：全量 upsert + 清掉 collection 里已不在快照中的文档。
    const deliveries = pruneWebhookDeliveries(snapshot.githubWebhookDeliveries || []);
    const newDeliveryIds = new Set(deliveries.map((d) => webhookDeliveryDocId(d)));
    const existingDeliveries = await this.handle.webhookDeliveriesCollection().find().toArray();
    const deliveryOps: unknown[] = deliveries.map((delivery) => {
      const id = webhookDeliveryDocId(delivery);
      return {
        replaceOne: {
          filter: { _id: id },
          replacement: { _id: id, receivedAt: delivery.receivedAt || '', doc: delivery, updatedAt: now },
          upsert: true,
        },
      };
    });
    for (const id of existingDeliveries.map((d) => d._id)) {
      if (!newDeliveryIds.has(id)) deliveryOps.push({ deleteOne: { filter: { _id: id } } });
    }
    if (deliveryOps.length > 0) await this.handle.webhookDeliveriesCollection().bulkWrite(deliveryOps);

    // Activity logs：同上，逐项目 ring buffer 截断后全量对齐。
    const newActivityIds = new Set<string>();
    const activityOps: unknown[] = [];
    for (const [projectId, logs] of Object.entries(snapshot.activityLogs || {})) {
      for (const log of (logs || []).slice(-MAX_ACTIVITY_LOGS_PER_PROJECT)) {
        const id = activityLogDocId(projectId, log);
        newActivityIds.add(id);
        activityOps.push({
          replaceOne: {
            filter: { _id: id },
            replacement: { _id: id, projectId, at: log.at || '', doc: log, updatedAt: now },
            upsert: true,
          },
        });
      }
    }
    const existingActivity = await this.handle.activityLogsCollection().find().toArray();
    for (const id of existingActivity.map((d) => d._id)) {
      if (!newActivityIds.has(id)) activityOps.push({ deleteOne: { filter: { _id: id } } });
    }
    if (activityOps.length > 0) await this.handle.activityLogsCollection().bulkWrite(activityOps);

    this.forceGlobalRewrite = false; // 全量写已重写 global doc，legacy 剥离完成。
    // 全量写之后序列化缓存与 DB 强一致，按快照重建（口径同持久化路径）。
    this.rebuildSerializedCaches(snapshot, {
      includeSelfUpdate: true,
      includeDeliveries: true,
      includeActivity: true,
    });
    this.needFullResync = false;
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
   * 仅在所有 split 集合都为空时执行，避免覆盖已迁数据。
   */
  async seedIfEmpty(state: CdsState): Promise<boolean> {
    const [
      globalCount,
      projectsCount,
      branchesCount,
      deploymentRunsCount,
      deploymentVersionsCount,
      historyCount,
      deliveriesCount,
      activityCount,
    ] = await Promise.all([
      this.handle.globalCollection().countDocuments({ _id: GLOBAL_DOC_ID }),
      this.handle.projectsCollection().countDocuments(),
      this.handle.branchesCollection().countDocuments(),
      this.handle.deploymentRunsCollection().countDocuments(),
      this.handle.deploymentVersionsCollection().countDocuments(),
      this.handle.selfUpdateHistoryCollection().countDocuments(),
      this.handle.webhookDeliveriesCollection().countDocuments(),
      this.handle.activityLogsCollection().countDocuments(),
    ]);
    if (
      globalCount > 0 ||
      projectsCount > 0 ||
      branchesCount > 0 ||
      deploymentRunsCount > 0 ||
      deploymentVersionsCount > 0 ||
      historyCount > 0 ||
      deliveriesCount > 0 ||
      activityCount > 0
    ) return false;

    await this.forceFullSave(state);
    return true;
  }
}
