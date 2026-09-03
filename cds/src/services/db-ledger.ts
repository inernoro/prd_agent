/**
 * 数据台账（数据库隔离收敛 3，2026-09-03）——派生库不失踪，删除不丢数据。
 *
 * 设计文档第十节的三条铁律在这里落地：
 *   1. 删之前必有备份，备份必须演练还原过一次（assertDropAllowed）；
 *   2. 不做静默覆盖（丢弃前先拍备份进台账，界面显示可回退到什么时候）；
 *   3. 一本台账（buildDbLedgerView 把隔离库快照、分支独立库、孤儿、已丢弃、扫描补录合成一棵血缘树）。
 *
 * 分层：
 *   - 纯函数（本文件上半部）：视图合并、血缘、门禁、孤儿条目——可离线单测；
 *   - 有副作用的操作走 DbLedgerOps 接口注入（备份落盘、演练还原、丢弃、列库），
 *     真实实现在 db-ledger-ops.ts，路由测试用桩。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { BranchEntry, DbLedgerBackup, DbLedgerEntry, InfraService, ReplicaDbSnapshot } from '../types.js';
import type { StateService } from './state.js';
import { slugifyBranchForDb } from './db-scope-isolation.js';
import { resolveReplicaDbTarget, type ReplicaDbEngine } from './replica-db-clone.js';
import { resolveEffectiveProfile } from './container.js';

/** 按配置折算出来的分支独立库（运行时应当存在的库） */
export interface DbLedgerDerived {
  branchId: string;
  branch: string;
  profileId: string;
  engine: ReplicaDbEngine;
  /** 去掉后缀的源库 */
  sourceDb: string;
  /** 加了分支后缀的运行时库名 */
  dbName: string;
  infraId: string;
  infraContainer: string;
}

export interface DbLedgerTreeNode {
  sourceDb: string | null;
  children: DbLedgerEntry[];
}

export interface DbLedgerView {
  projectId: string;
  generatedAt: string;
  entries: DbLedgerEntry[];
  tree: DbLedgerTreeNode[];
  summary: {
    total: number;
    active: number;
    orphaned: number;
    dropped: number;
    unknown: number;
    withVerifiedBackup: number;
    withoutBackup: number;
  };
}

/** 分支独立库的血缘：去掉本分支 slug 后缀就是源库 */
export function stripBranchSuffix(dbName: string, branch: string): string {
  const slug = slugifyBranchForDb(branch);
  const suffix = slug ? `_${slug}` : '';
  return suffix && dbName.endsWith(suffix) ? dbName.slice(0, -suffix.length) : dbName;
}

function hasVerifiedBackup(e: DbLedgerEntry): boolean {
  return e.backups.some((b) => !!b.verifiedAt);
}

/** 快照 → 台账条目（运行时真相映射，不落盘；落盘只在转孤儿 / 记备份时） */
function entryFromSnapshot(branch: BranchEntry, s: ReplicaDbSnapshot, infraId: string | undefined, id: string): DbLedgerEntry {
  return {
    id, projectId: branch.projectId, kind: 'isolated', engine: s.engine, dbName: s.dbName,
    infraId, infraContainer: s.infraContainer, sourceDb: s.sourceDb,
    branchId: branch.id, branch: branch.branch, profileId: s.profileId, memberId: s.memberId, snapshotId: s.id,
    ...(s.dedicatedContainer ? { dedicatedContainer: s.dedicatedContainer } : {}),
    ...(s.dedicatedHostPort ? { dedicatedHostPort: s.dedicatedHostPort } : {}),
    ...(s.dedicatedAuth ? { dedicatedAuth: s.dedicatedAuth } : {}),
    origin: 'cds', status: 'active', createdAt: s.clonedAt, updatedAt: s.clonedAt, backups: [],
  };
}

/** 删分支默认保留：隔离库快照转孤儿条目，把删库要用的定位信息全部带上 */
export function orphanEntryForSnapshot(branch: BranchEntry, s: ReplicaDbSnapshot, infraId: string | undefined, now: Date, existing?: DbLedgerEntry): DbLedgerEntry {
  const base = existing ?? entryFromSnapshot(branch, s, infraId, `dbl_${randomUUID().replace(/-/g, '').slice(0, 12)}`);
  return { ...base, status: 'orphaned', orphanedAt: now.toISOString(), updatedAt: now.toISOString() };
}

/** 删分支默认保留：分支独立库转孤儿条目 */
export function orphanEntryForDerived(d: DbLedgerDerived, projectId: string, now: Date, existing?: DbLedgerEntry): DbLedgerEntry {
  const base: DbLedgerEntry = existing ?? {
    id: `dbl_${randomUUID().replace(/-/g, '').slice(0, 12)}`, projectId, kind: 'per-branch', engine: d.engine, dbName: d.dbName,
    infraId: d.infraId, infraContainer: d.infraContainer, sourceDb: d.sourceDb,
    branchId: d.branchId, branch: d.branch, profileId: d.profileId,
    origin: 'cds', status: 'active', createdAt: now.toISOString(), updatedAt: now.toISOString(), backups: [],
  };
  return { ...base, status: 'orphaned', orphanedAt: now.toISOString(), updatedAt: now.toISOString() };
}

/**
 * 一本台账的视图：运行时真相（分支上的快照、按配置折算的独立库）与台账记录（备份、孤儿、
 * 已丢弃、扫描补录）合并。匹配键：隔离库按 snapshotId；独立库按 (infraContainer, dbName)。
 */
export function buildDbLedgerView(input: {
  projectId: string;
  branches: BranchEntry[];
  derived: DbLedgerDerived[];
  recorded: DbLedgerEntry[];
  infraIdByContainer?: Record<string, string>;
  now: Date;
}): DbLedgerView {
  const { projectId, now } = input;
  const recorded = input.recorded.filter((e) => e.projectId === projectId);
  const bySnapshot = new Map(recorded.filter((e) => e.snapshotId).map((e) => [e.snapshotId!, e]));
  const byDbKey = new Map(recorded.map((e) => [`${e.infraContainer}::${e.dbName}`, e]));
  const used = new Set<string>();
  const entries: DbLedgerEntry[] = [];

  for (const branch of input.branches) {
    if (branch.projectId !== projectId) continue;
    for (const s of branch.replicaDbSnapshots ?? []) {
      const rec = bySnapshot.get(s.id);
      const infraId = input.infraIdByContainer?.[s.infraContainer] ?? rec?.infraId;
      if (rec) {
        used.add(rec.id);
        entries.push({ ...rec, ...entryFromSnapshot(branch, s, infraId, rec.id), backups: rec.backups, lastObjects: rec.lastObjects, note: rec.note, status: 'active' });
      } else {
        entries.push(entryFromSnapshot(branch, s, infraId, `live_snap_${s.id}`));
      }
    }
  }
  for (const d of input.derived) {
    const key = `${d.infraContainer}::${d.dbName}`;
    const rec = byDbKey.get(key);
    if (rec && !used.has(rec.id)) {
      used.add(rec.id);
      entries.push({
        ...rec, kind: 'per-branch', engine: d.engine, sourceDb: d.sourceDb, branchId: d.branchId, branch: d.branch, profileId: d.profileId,
        infraId: d.infraId, status: rec.status === 'dropped' ? 'dropped' : 'active',
      });
    } else if (!rec) {
      entries.push({
        id: `live_db_${d.branchId}_${d.profileId}`, projectId, kind: 'per-branch', engine: d.engine, dbName: d.dbName,
        infraId: d.infraId, infraContainer: d.infraContainer, sourceDb: d.sourceDb,
        branchId: d.branchId, branch: d.branch, profileId: d.profileId,
        origin: 'cds', status: 'active', createdAt: now.toISOString(), updatedAt: now.toISOString(), backups: [],
        note: '按当前配置折算（分支部署后才真正建库）；「扫描补录」可核实实例上是否已存在',
      });
    }
  }
  for (const rec of recorded) {
    if (!used.has(rec.id)) entries.push(rec);
  }

  const groups = new Map<string | null, DbLedgerEntry[]>();
  for (const e of entries) {
    const k = e.sourceDb ?? null;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }
  const tree: DbLedgerTreeNode[] = [...groups.entries()]
    .sort((a, b) => (a[0] ?? '~').localeCompare(b[0] ?? '~'))
    .map(([sourceDb, children]) => ({ sourceDb, children: [...children].sort((a, b) => a.dbName.localeCompare(b.dbName)) }));

  const count = (f: (e: DbLedgerEntry) => boolean): number => entries.filter(f).length;
  return {
    projectId,
    generatedAt: now.toISOString(),
    entries,
    tree,
    summary: {
      total: entries.length,
      active: count((e) => e.status === 'active'),
      orphaned: count((e) => e.status === 'orphaned'),
      dropped: count((e) => e.status === 'dropped'),
      unknown: count((e) => e.kind === 'unknown'),
      withVerifiedBackup: count(hasVerifiedBackup),
      withoutBackup: count((e) => e.backups.length === 0),
    },
  };
}

export type DropGate =
  | { ok: true; forced: boolean }
  | { ok: false; status: 409; missing: 'backup' | 'verified-backup' | 'confirm'; message: string };

/**
 * 删之前必有备份，备份必须演练还原过一次。
 * 强制通道：用户复述库名一字不差（「不备份直接删」），记 forced 供审计。
 */
export function assertDropAllowed(entry: DbLedgerEntry, opts: { force?: { confirmDbName: string } } = {}): DropGate {
  if (opts.force) {
    if (opts.force.confirmDbName !== entry.dbName) {
      return { ok: false, status: 409, missing: 'confirm', message: `强制丢弃需要复述库名：请一字不差地输入 ${entry.dbName}` };
    }
    return { ok: true, forced: true };
  }
  if (entry.backups.length === 0) {
    return { ok: false, status: 409, missing: 'backup', message: `${entry.dbName} 还没有备份，不能丢弃：请先备份并演练还原一次，或勾选「不备份直接删」并复述库名` };
  }
  if (!hasVerifiedBackup(entry)) {
    return { ok: false, status: 409, missing: 'verified-backup', message: `${entry.dbName} 的备份从没演练还原过，不算备份：请先对最近一份备份做演练验证，或勾选「不备份直接删」并复述库名` };
  }
  return { ok: true, forced: false };
}

/** 按配置折算项目内全部分支独立库（运行时应当存在的库） */
export function collectDerivedDbs(state: StateService, projectId: string): DbLedgerDerived[] {
  const out: DbLedgerDerived[] = [];
  for (const branch of state.getBranchesForProject(projectId)) {
    for (const profile of state.getEffectiveProfilesForBranch(branch)) {
      const effective = resolveEffectiveProfile(profile, branch);
      if (effective.dbScope !== 'per-branch') continue;
      const { target } = resolveReplicaDbTarget(state, branch, effective, { infraStatus: 'any' });
      if (!target) continue;
      const sourceDb = stripBranchSuffix(target.sourceDb, branch.branch);
      if (sourceDb === target.sourceDb) continue; // 没加上后缀（如库名变量不在白名单）→ 不是派生库
      out.push({
        branchId: branch.id, branch: branch.branch, profileId: profile.id, engine: target.engine,
        sourceDb, dbName: target.sourceDb, infraId: target.infra.id, infraContainer: target.infra.containerName,
      });
    }
  }
  return out;
}

export function buildProjectDbLedgerView(state: StateService, projectId: string, now: Date = new Date()): DbLedgerView {
  const infraIdByContainer = Object.fromEntries(state.getInfraServicesForProject(projectId).map((s) => [s.containerName, s.id]));
  return buildDbLedgerView({
    projectId,
    branches: state.getBranchesForProject(projectId),
    derived: collectDerivedDbs(state, projectId),
    recorded: state.getDbLedger(projectId),
    infraIdByContainer,
    now,
  });
}

/** 把视图里的「运行时条目」固化成台账记录（记备份 / 转孤儿前必须先有 id 稳定的记录） */
export function materializeEntry(state: StateService, view: DbLedgerView, entryId: string, now: Date): DbLedgerEntry | null {
  const e = view.entries.find((x) => x.id === entryId);
  if (!e) return null;
  if (!e.id.startsWith('live_')) return e;
  const persisted: DbLedgerEntry = { ...e, id: `dbl_${randomUUID().replace(/-/g, '').slice(0, 12)}`, updatedAt: now.toISOString() };
  state.upsertDbLedgerEntry(persisted);
  return persisted;
}

// ── 有副作用的操作：接口注入 ──

export interface DbLedgerOps {
  /** 把一个库导出到宿主文件（容器内 dump | gzip → 宿主 file），返回体量与校验和 */
  dumpToFile(engine: ReplicaDbEngine, infra: InfraService, dbName: string, file: string): Promise<{ bytes: number; sha256: string }>;
  /** 数一下库里的对象（表 / 集合） */
  countObjects(engine: ReplicaDbEngine, infra: InfraService, dbName: string): Promise<number>;
  /** 演练还原：把备份灌进临时库、数对象、删临时库 */
  restoreDrill(engine: ReplicaDbEngine, infra: InfraService, file: string, scratchDb: string): Promise<{ objects: number }>;
  /** 丢弃一个派生库（专用实例 = 整容器移除） */
  dropDb(engine: ReplicaDbEngine, infra: InfraService, entry: Pick<DbLedgerEntry, 'dbName' | 'dedicatedContainer'>): Promise<void>;
  /** 列出实例上的全部库名（不含系统库） */
  listDatabases(engine: ReplicaDbEngine, infra: InfraService): Promise<string[]>;
}

export function sha256File(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 演练用的临时库名：固定前缀 + 短哈希，绝不与业务库撞名，删起来也一眼可辨 */
export function scratchDbName(dbName: string, now: Date): string {
  const h = createHash('sha1').update(`${dbName}|${now.toISOString()}`).digest('hex').slice(0, 8);
  return `cds_drill_${h}`;
}

export function backupRecord(file: string, meta: { bytes: number; sha256: string; objects?: number }, now: Date): DbLedgerBackup {
  return {
    id: `bk_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
    file, bytes: meta.bytes, sha256: meta.sha256, createdAt: now.toISOString(),
    ...(meta.objects !== undefined ? { objects: meta.objects } : {}),
  };
}

/** 扫描结果与已知库名比对，只把「谁也不认识」的库补录为来源未知 */
export function unknownDatabases(listed: string[], known: Set<string>, systemDbs: Set<string>): string[] {
  return listed.filter((db) => !systemDbs.has(db) && !known.has(db) && !db.startsWith('cds_drill_'));
}

export const SYSTEM_DBS: Record<ReplicaDbEngine, string[]> = {
  mysql: ['mysql', 'sys', 'information_schema', 'performance_schema'],
  postgres: ['postgres', 'template0', 'template1'],
  mongo: ['admin', 'local', 'config'],
};

// ── 删分支时的派生库处置（默认保留 → 孤儿；显式勾选丢弃 → 门禁）──

export interface BranchDbDeleteChoice {
  /** 台账视图里的条目 id（live_… 或 dbl_…）或库名 */
  entryId?: string;
  dbName?: string;
  action: 'keep' | 'drop';
  /** 没有演练验证过的备份时，复述库名强制丢弃 */
  confirmDbName?: string;
}

export interface BranchDbSettlement {
  kept: DbLedgerEntry[];
  /** 已通过门禁、待执行 drop 的条目（隔离库由既有级联清理执行，独立库由 ops 执行） */
  toDrop: DbLedgerEntry[];
  refused: Array<{ dbName: string; reason: string }>;
}

/**
 * 分支删除前决定每条派生库的去向：默认保留（转孤儿条目留在台账，不丢数据），
 * 只有明确勾选丢弃且过了门禁的才进 toDrop。纯决策，不动 docker；孤儿条目在这里就写进台账。
 */
export function settleBranchDbsOnDelete(
  state: StateService,
  branch: BranchEntry,
  choices: BranchDbDeleteChoice[],
  now: Date,
): BranchDbSettlement {
  const view = buildProjectDbLedgerView(state, branch.projectId, now);
  const infraIdByContainer = Object.fromEntries(state.getInfraServicesForProject(branch.projectId).map((s) => [s.containerName, s.id]));
  const mine = view.entries.filter((e) => e.branchId === branch.id && e.status === 'active');
  const kept: DbLedgerEntry[] = [];
  const toDrop: DbLedgerEntry[] = [];
  const refused: Array<{ dbName: string; reason: string }> = [];
  for (const e of mine) {
    const choice = choices.find((c) => (c.entryId && c.entryId === e.id) || (c.dbName && c.dbName === e.dbName));
    if (choice?.action === 'drop') {
      const gate = assertDropAllowed(e, choice.confirmDbName ? { force: { confirmDbName: choice.confirmDbName } } : {});
      if (gate.ok) {
        const persisted = materializeEntry(state, view, e.id, now) ?? e;
        toDrop.push({ ...persisted, droppedForced: gate.forced });
        continue;
      }
      refused.push({ dbName: e.dbName, reason: gate.message });
    }
    // 默认保留：转孤儿
    const existing = e.id.startsWith('live_') ? undefined : state.getDbLedgerEntry(e.id);
    let orphan: DbLedgerEntry;
    if (e.kind === 'isolated' && e.snapshotId) {
      const snap = (branch.replicaDbSnapshots ?? []).find((s) => s.id === e.snapshotId);
      orphan = snap
        ? orphanEntryForSnapshot(branch, snap, infraIdByContainer[snap.infraContainer] ?? e.infraId, now, existing)
        : { ...e, id: existing?.id ?? `dbl_${randomUUID().replace(/-/g, '').slice(0, 12)}`, status: 'orphaned', orphanedAt: now.toISOString(), updatedAt: now.toISOString() };
    } else {
      orphan = orphanEntryForDerived({
        branchId: branch.id, branch: branch.branch, profileId: e.profileId || '', engine: e.engine, sourceDb: e.sourceDb || e.dbName,
        dbName: e.dbName, infraId: e.infraId || '', infraContainer: e.infraContainer,
      }, branch.projectId, now, existing);
    }
    state.upsertDbLedgerEntry(orphan);
    kept.push(orphan);
  }
  return { kept, toDrop, refused };
}

/** 丢弃执行完毕后把台账条目翻成 dropped */
export function markDropped(state: StateService, entry: DbLedgerEntry, by: string, now: Date): void {
  const current = state.getDbLedgerEntry(entry.id) ?? entry;
  state.upsertDbLedgerEntry({ ...current, status: 'dropped', droppedAt: now.toISOString(), droppedBy: by, droppedForced: entry.droppedForced, updatedAt: now.toISOString() });
}
