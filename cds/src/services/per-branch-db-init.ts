/**
 * 分支独立库「时间点克隆」初始化（数据库隔离收敛 4，2026-09-04）。
 *
 * 分支独立库默认是空库、由应用启动时自己跑迁移（dbInit = empty）。选 dbInit = clone 的服务，
 * 在容器启动**之前**从共享库时间点克隆一份到折算后的独立库名，让新分支不必重跑迁移就能
 * 读到克隆时间点之前的数据。克隆走 db-clone-pipeline 的三元组管线，克隆时间点与逐表
 * 行数校验结果进数据台账（收敛 3 那一本）。
 *
 * 幂等：目标库已经在实例上就跳过——重复部署不会覆盖分支自己写进去的数据。
 * 克隆失败抛错让部署如实失败，不让应用对着半份数据启动（半成品库由管线尽力 DROP）。
 */
import type { StateService } from './state.js';
import type { BranchEntry, BuildProfile, DbCloneVerification, DbLedgerEntry } from '../types.js';
import { resolveReplicaDbTarget } from './replica-db-clone.js';
import { buildProjectDbLedgerView, materializeEntry, stripBranchSuffix } from './db-ledger.js';
import { realDbLedgerOps } from './db-ledger-ops.js';
import {
  cloneRelationalDbInPlace, describeCloneVerification, verifyCloneRowCounts,
  type DbCloneExec, type DbCloneSpec,
} from './db-clone-pipeline.js';
import type { DbEngine } from './db-env-keys.js';
import type { InfraService } from '../types.js';
import { effectiveDbInit, MONGO_CLONE_REFUSAL } from './db-init-mode.js';
import { resolveCredential } from './db-probe.js';
import type { ReplicaDbTarget } from './replica-db-clone.js';

export { DB_INIT_MODES, DB_INIT_LABEL, isDbInitMode, effectiveDbInit, MONGO_CLONE_REFUSAL, type DbInitMode } from './db-init-mode.js';

/** 按分支与服务折算克隆三元组；折不出来时给出原因（给日志与界面直接展示） */
export function perBranchCloneSpec(state: StateService, branch: BranchEntry, profile: BuildProfile): { spec: DbCloneSpec } | { refused: string } {
  if (profile.dbScope !== 'per-branch') return { refused: '该服务用共享库，没有分支独立库可初始化' };
  const r = resolveReplicaDbTarget(state, branch, profile, { infraStatus: 'any' });
  if (!r.target) return { refused: r.reason || '该服务没有数据库目标' };
  if (r.target.engine === 'mongo') return { refused: MONGO_CLONE_REFUSAL };
  const sourceDb = stripBranchSuffix(r.target.sourceDb, branch.branch);
  if (sourceDb === r.target.sourceDb) return { refused: '库名变量没有加上分支后缀（不在改写白名单），这个服务没有独立库可克隆' };
  return {
    spec: {
      engine: r.target.engine,
      infra: r.target.infra,
      sourceDb,
      targetDb: r.target.sourceDb,
      scope: { kind: 'per-branch', projectId: branch.projectId, branchId: branch.id, profileId: profile.id },
      grantTo: appDbUser(r.target),
    },
  };
}

/**
 * 应用自己的数据库用户（与库探测同一套凭据解析：连接串 → 应用 env 里的用户变量）。
 * 退回基础设施 root 的不授权（root 什么都能看）；解析不到就不授权，让「应用连不上」如实暴露。
 */
export function appDbUser(target: ReplicaDbTarget): string | undefined {
  const cred = resolveCredential(target.engine, target.appEnv ?? {}, target);
  if (cred.source !== 'app-url' && cred.source !== 'app-env') return undefined;
  // 仍是模板说明项目环境变量里没有这个值：不授权，让应用连不上如实暴露，而不是把 ${...} 写进 GRANT
  return /\$\{[^}]+\}/.test(cred.user) ? undefined : cred.user;
}

export type PerBranchDbInitOutcome =
  | { kind: 'not-applicable'; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'exists'; dbName: string }
  | { kind: 'cloned'; dbName: string; sourceDb: string; clonedAt: string; verification: DbCloneVerification; entryId: string };

export interface PerBranchDbInitDeps {
  exec?: DbCloneExec;
  listDatabases?: (engine: DbEngine, infra: InfraService) => Promise<string[]>;
  now?: () => Date;
  onOutput?: (line: string) => void;
}

function recordClone(
  state: StateService, spec: DbCloneSpec, clonedAt: string, verification: DbCloneVerification, now: Date,
): DbLedgerEntry {
  const projectId = spec.scope.projectId!;
  const view = buildProjectDbLedgerView(state, projectId, now);
  const live = view.entries.find((e) => e.infraContainer === spec.infra.containerName && e.dbName === spec.targetDb);
  const base: DbLedgerEntry = (live && materializeEntry(state, view, live.id, now)) || {
    id: `dbl_${clonedAt.replace(/\D/g, '').slice(0, 14)}_${spec.targetDb}`.slice(0, 64),
    projectId, kind: 'per-branch', engine: spec.engine, dbName: spec.targetDb,
    infraId: spec.infra.id, infraContainer: spec.infra.containerName, sourceDb: spec.sourceDb,
    branchId: spec.scope.branchId, profileId: spec.scope.profileId,
    origin: 'cds', status: 'active', createdAt: now.toISOString(), updatedAt: now.toISOString(), backups: [],
  };
  // 刚克隆出来的库一定活着：同名条目哪怕之前被丢弃过（真实分支复验：删分支丢库后又重建），
  // 也从「已丢弃」复活，清掉丢弃 / 孤儿痕迹——否则回写门禁会把它当已丢弃拒绝
  const { droppedAt: _da, droppedBy: _db, droppedForced: _df, orphanedAt: _oa, ...revived } = base;
  const entry: DbLedgerEntry = {
    ...revived,
    status: 'active',
    branchId: spec.scope.branchId, profileId: spec.scope.profileId,
    clone: { sourceDb: spec.sourceDb, clonedAt, verification },
    lastObjects: { count: verification.tables.length + verification.targetOnly.length, measuredAt: verification.measuredAt },
    note: undefined,
    updatedAt: now.toISOString(),
  };
  state.upsertDbLedgerEntry(entry);
  state.save();
  return entry;
}

/**
 * 同一目标库的克隆串行化（按 实例容器::目标库 键）。
 * 分支里多个服务常共用一个库（前端 + 后端都指向 app），部署层内它们并行启动，两个钩子会
 * 同时发现「库不存在」各克隆一遍（2026-09-04 真实 mysql 分支复验撞上：两份导入交叠，
 * 第一份校验出 57/58 张表）。后来的等前一个做完再重新判「已存在」。进程内互斥即可：
 * 钩子只在本 CDS 进程的部署循环里跑。
 */
const inflightClones = new Map<string, Promise<PerBranchDbInitOutcome>>();

/**
 * 部署前钩子：需要时把分支独立库从共享库时间点克隆出来。
 * 返回值只描述发生了什么；克隆脚本失败直接抛错。
 */
export async function ensurePerBranchDbInitialized(
  state: StateService, branch: BranchEntry, profile: BuildProfile, deps: PerBranchDbInitDeps = {},
): Promise<PerBranchDbInitOutcome> {
  if (profile.dbScope !== 'per-branch' || effectiveDbInit(profile) !== 'clone') {
    return ensurePerBranchDbInitializedUnlocked(state, branch, profile, deps);
  }
  const r = perBranchCloneSpec(state, branch, profile);
  if ('refused' in r) return { kind: 'refused', reason: r.refused };
  const key = `${r.spec.infra.containerName}::${r.spec.targetDb}`;
  const prior = inflightClones.get(key);
  if (prior) {
    deps.onOutput?.(`── 分支独立库 ${r.spec.targetDb} 正由同分支另一个服务克隆中，等它完成 ──`);
    await prior.catch(() => undefined);
  }
  const run = ensurePerBranchDbInitializedUnlocked(state, branch, profile, deps);
  inflightClones.set(key, run);
  try { return await run; }
  finally { if (inflightClones.get(key) === run) inflightClones.delete(key); }
}

async function ensurePerBranchDbInitializedUnlocked(
  state: StateService, branch: BranchEntry, profile: BuildProfile, deps: PerBranchDbInitDeps = {},
): Promise<PerBranchDbInitOutcome> {
  if (profile.dbScope !== 'per-branch') return { kind: 'not-applicable', reason: '共享库' };
  if (effectiveDbInit(profile) !== 'clone') return { kind: 'not-applicable', reason: '初始化方式是空库重跑迁移' };
  const r = perBranchCloneSpec(state, branch, profile);
  if ('refused' in r) return { kind: 'refused', reason: r.refused };
  const { spec } = r;
  if (spec.infra.status !== 'running') return { kind: 'refused', reason: `实例 ${spec.infra.containerName} 未运行（${spec.infra.status}），无法克隆` };
  const listDatabases = deps.listDatabases ?? ((engine, infra) => realDbLedgerOps.listDatabases(engine, infra));
  const now = deps.now ?? (() => new Date());
  const existing = await listDatabases(spec.engine, spec.infra);
  if (existing.some((d) => d.toLowerCase() === spec.targetDb.toLowerCase())) {
    deps.onOutput?.(`── 分支独立库 ${spec.targetDb} 已在实例上，跳过时间点克隆（不覆盖分支自己的数据）──`);
    return { kind: 'exists', dbName: spec.targetDb };
  }
  deps.onOutput?.(`── 分支独立库时间点克隆: ${spec.sourceDb} → ${spec.targetDb}（${spec.engine} @ ${spec.infra.containerName}）──`);
  const cloned = await cloneRelationalDbInPlace(spec, { exec: deps.exec, onOutput: deps.onOutput });
  const clonedAt = now().toISOString();
  const verification = await verifyCloneRowCounts(spec, { exec: deps.exec, now });
  deps.onOutput?.(verification.ok
    ? `── 逐表校验：${describeCloneVerification(verification)} ──`
    : `── 逐表校验：${describeCloneVerification(verification)}；克隆是时间点快照（${clonedAt}），之后源库的写入不会同步 ──`);
  const entry = recordClone(state, spec, clonedAt, verification, now());
  return { kind: 'cloned', dbName: cloned.targetDb, sourceDb: spec.sourceDb, clonedAt, verification, entryId: entry.id };
}
