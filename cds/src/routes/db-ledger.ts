// 数据台账路由（数据库隔离收敛 3，2026-09-03）
//
//   GET    /api/projects/:id/db-ledger                                  一本台账（血缘树 + 摘要）
//   POST   /api/projects/:id/db-ledger/scan                             扫描实例补录来源未知的存量库
//   POST   /api/projects/:id/db-ledger/:entryId/backup                  备份一条派生库到宿主备份目录
//   POST   /api/projects/:id/db-ledger/:entryId/backups/:backupId/verify 演练还原到临时库并核对对象数
//   DELETE /api/projects/:id/db-ledger/:entryId                         丢弃（门禁：演练验证过的备份，或复述库名强制）
//   GET    /api/branches/:id/db-ledger                                  某条分支的派生库（删分支对话框用）
//   POST   /api/branches/:id/db-init/:profileId                         分支独立库时间点克隆初始化（收敛 4；部署前钩子的手动入口）
//   GET    /api/projects/:id/db-ledger/:entryId/write-back/preview       回写预览：两边逐表行数 + 冲突清单（收敛 5）
//   POST   /api/projects/:id/db-ledger/:entryId/write-back               回写：自动备份目标库并演练 → 整库替换 → 逐表校验 → 记台账
//   POST   /api/projects/:id/db-ledger/:entryId/write-backs/:wbId/rollback 回退：用回写前快照还原目标库
//
// 有副作用的 docker 操作全部经 deps.ops 注入（真实实现 db-ledger-ops.ts），路由测试用桩。

import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request } from 'express';
import type { StateService } from '../services/state.js';
import type { DbLedgerEntry } from '../types.js';
import {
  assertDropAllowed, backupRecord, buildProjectDbLedgerView, materializeEntry, scratchDbName, unknownDatabases, SYSTEM_DBS,
  collectDerivedDbs, type DbLedgerOps, type DbLedgerView,
} from '../services/db-ledger.js';
import { isDroppableDerivedName, realDbLedgerOps } from '../services/db-ledger-ops.js';
import { backupDirCandidates } from '../services/infra-backup-schedule.js';
import { detectInfraDataKind } from './infra-data.js';
import { resolveInfraForDb, resolveReplicaDbTarget, type ReplicaDbEngine } from '../services/replica-db-clone.js';
import { resolveEffectiveProfile } from '../services/container.js';
import { ensurePerBranchDbInitialized, appDbUser, type PerBranchDbInitOutcome } from '../services/per-branch-db-init.js';
import { describeCloneVerification, compareTableCounts, type DbCloneExec } from '../services/db-clone-pipeline.js';
import { assertWriteBackAllowed, buildWriteBackPreview } from '../services/db-write-back.js';
import { randomUUID } from 'node:crypto';
import type { DbLedgerBackup, DbWriteBackRecord, InfraService } from '../types.js';

export interface DbLedgerRouterDeps {
  stateService: StateService;
  assertProjectAccess: (req: Request, projectId: string) => { status: number; body: unknown } | null;
  ops?: DbLedgerOps;
  repoRoot?: string;
  now?: () => Date;
  /** 时间点克隆的 docker exec（测试注入桩；缺省走真实 docker） */
  cloneExec?: DbCloneExec;
}

export function describePerBranchDbInit(o: PerBranchDbInitOutcome): string {
  switch (o.kind) {
    case 'cloned': return `已从 ${o.sourceDb} 时间点克隆到 ${o.dbName}（${o.clonedAt}）：${describeCloneVerification(o.verification)}`;
    case 'exists': return `${o.dbName} 已在实例上，未重复克隆（不覆盖分支自己的数据）`;
    case 'refused': return `未克隆：${o.reason}`;
    default: return `不适用：${o.reason}`;
  }
}

const BACKUP_EXT: Record<ReplicaDbEngine, string> = { mysql: 'sql.gz', postgres: 'sql.gz', mongo: 'archive.gz' };

function pickBackupDir(slug: string, repoRoot?: string): string {
  for (const dir of backupDirCandidates({ slug, repoRoot })) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return dir; } catch { /* next */ }
  }
  throw new Error('没有可写的备份目录（CDS_BACKUP_DIR / /data/cds/<slug>/backups / 仓库旁 cds-backups 均不可写）');
}

/** 一条分支的派生库（视图里 branchId 相同的活跃条目） */
export function branchDbLedgerEntries(view: DbLedgerView, branchId: string): DbLedgerEntry[] {
  return view.entries.filter((e) => e.branchId === branchId && e.status === 'active');
}

export function createDbLedgerRouter(deps: DbLedgerRouterDeps): Router {
  const { stateService } = deps;
  const ops = deps.ops ?? realDbLedgerOps;
  const now = deps.now ?? (() => new Date());
  const router = Router();

  const guardProject = (req: Request, res: import('express').Response): { id: string; slug: string } | null => {
    const project = stateService.getProject(req.params.id);
    if (!project) { res.status(404).json({ error: `项目不存在: ${req.params.id}` }); return null; }
    const access = deps.assertProjectAccess(req, project.id);
    if (access) { res.status(access.status).json(access.body); return null; }
    return { id: project.id, slug: project.slug || project.id };
  };

  const infraOf = (projectId: string, entry: DbLedgerEntry) => {
    const raw = stateService.getInfraServicesForProject(projectId).find((s) => s.containerName === entry.infraContainer || s.id === entry.infraId);
    // 记录里的密码常是 ${CDS_...} 模板，备份 / 演练 / 回写前按项目环境变量解析（与容器启动同一套）
    return raw ? resolveInfraForDb(stateService, raw) : raw;
  };

  router.get('/projects/:id/db-ledger', (req, res) => {
    const p = guardProject(req, res); if (!p) return;
    res.json(buildProjectDbLedgerView(stateService, p.id, now()));
  });

  router.get('/branches/:id/db-ledger', (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) { res.status(404).json({ error: `分支不存在: ${req.params.id}` }); return; }
    const access = deps.assertProjectAccess(req, branch.projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    const view = buildProjectDbLedgerView(stateService, branch.projectId, now());
    const entries = branchDbLedgerEntries(view, branch.id);
    res.json({
      branchId: branch.id, branch: branch.branch, projectId: branch.projectId,
      entries,
      summary: {
        total: entries.length,
        withVerifiedBackup: entries.filter((e) => e.backups.some((b) => b.verifiedAt)).length,
      },
      hint: entries.length === 0
        ? '这条分支没有派生库，删除不会留下任何数据库'
        : `删除分支默认保留这 ${entries.length} 个派生库（转为台账里的孤儿条目，随时可备份或丢弃）；要一并丢弃的必须已有演练验证过的备份，或复述库名强制`,
    });
  });

  router.post('/branches/:id/db-init/:profileId', async (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) { res.status(404).json({ error: `分支不存在: ${req.params.id}` }); return; }
    const access = deps.assertProjectAccess(req, branch.projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    const baseline = stateService.getEffectiveProfilesForBranch(branch).find((p) => p.id === req.params.profileId);
    if (!baseline) { res.status(404).json({ error: `服务不存在: ${req.params.profileId}` }); return; }
    const effective = resolveEffectiveProfile(baseline, branch);
    const lines: string[] = [];
    try {
      const outcome = await ensurePerBranchDbInitialized(stateService, branch, effective, {
        exec: deps.cloneExec,
        listDatabases: (engine, infra) => ops.listDatabases(engine, infra),
        now,
        onOutput: (line) => lines.push(line),
      });
      res.status(outcome.kind === 'refused' ? 409 : 200).json({
        branchId: branch.id, branch: branch.branch, profileId: baseline.id,
        outcome, lines, message: describePerBranchDbInit(outcome),
      });
    } catch (err) {
      res.status(500).json({ error: `时间点克隆失败：${(err as Error).message}`, lines });
    }
  });

  /** 目标库自动备份 + 演练验证（回写 / 回退前的共同门禁）：演练不通过就不许动目标库 */
  async function backupAndDrill(p: { id: string; slug: string }, engine: ReplicaDbEngine, infra: InfraService, dbName: string, tag: string): Promise<{ ok: true; backup: DbLedgerBackup } | { ok: false; backup: DbLedgerBackup; detail: string }> {
    const dir = pickBackupDir(p.slug, deps.repoRoot);
    const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const file = path.join(dir, `db-ledger--${p.id}--${dbName}-${stamp}-${tag}.${BACKUP_EXT[engine]}`);
    const objects = await ops.countObjects(engine, infra, dbName).catch(() => undefined);
    const meta = await ops.dumpToFile(engine, infra, dbName, file);
    const backup = backupRecord(file, { ...meta, objects }, now());
    const scratch = scratchDbName(dbName, now());
    const drill = await ops.restoreDrill(engine, infra, file, scratch);
    const ok = objects === undefined ? drill.objects > 0 : drill.objects === objects;
    const detail = objects === undefined
      ? `还原到临时库 ${scratch} 得到 ${drill.objects} 个表/集合（备份时未记录对象数）`
      : `还原到临时库 ${scratch} 得到 ${drill.objects} 个表/集合，备份时 ${dbName} 有 ${objects} 个${ok ? '，一致' : '，不一致'}`;
    const verified: DbLedgerBackup = { ...backup, verifyDetail: detail, ...(ok ? { verifiedAt: now().toISOString() } : {}) };
    return ok ? { ok: true, backup: verified } : { ok: false, backup: verified, detail };
  }

  /** 回写目标库的应用用户：从派生库所属分支 / 服务的运行时 env 解析（与克隆授权同口径） */
  function writeBackGrantTo(entry: DbLedgerEntry): string | undefined {
    if (!entry.branchId || !entry.profileId) return undefined;
    const branch = stateService.getBranch(entry.branchId);
    const baseline = branch && stateService.getEffectiveProfilesForBranch(branch).find((p) => p.id === entry.profileId);
    if (!branch || !baseline) return undefined;
    const { target } = resolveReplicaDbTarget(stateService, branch, resolveEffectiveProfile(baseline, branch), { infraStatus: 'any' });
    return target ? appDbUser(target) : undefined;
  }

  function resolveWriteBackTarget(req: Request, res: any): { p: { id: string; slug: string }; live: DbLedgerEntry; infra: InfraService; targetDb: string; view: DbLedgerView } | null {
    const p = guardProject(req, res); if (!p) return null;
    const view = buildProjectDbLedgerView(stateService, p.id, now());
    const live = view.entries.find((e) => e.id === req.params.entryId);
    if (!live) { res.status(404).json({ error: `台账条目不存在: ${req.params.entryId}` }); return null; }
    const gate = assertWriteBackAllowed(live);
    if (!gate.ok) { res.status(409).json({ error: gate.reason }); return null; }
    const infra = infraOf(p.id, live);
    if (!infra) { res.status(409).json({ error: `找不到承载 ${live.dbName} 的基础设施实例（${live.infraContainer}）` }); return null; }
    return { p, live, infra, targetDb: gate.targetDb, view };
  }

  router.get('/projects/:id/db-ledger/:entryId/write-back/preview', async (req, res) => {
    const t = resolveWriteBackTarget(req, res); if (!t) return;
    try {
      const [parent, derived] = await Promise.all([ops.tableCounts(t.live.engine, t.infra, t.targetDb), ops.tableCounts(t.live.engine, t.infra, t.live.dbName)]);
      res.json({ entryId: t.live.id, ...buildWriteBackPreview(t.live, t.targetDb, parent, derived) });
    } catch (err) {
      res.status(500).json({ error: `回写预览失败：${(err as Error).message}` });
    }
  });

  router.post('/projects/:id/db-ledger/:entryId/write-back', async (req, res) => {
    const t = resolveWriteBackTarget(req, res); if (!t) return;
    const confirm = typeof req.body?.confirmDbName === 'string' ? req.body.confirmDbName : '';
    if (confirm !== t.targetDb) { res.status(400).json({ error: `回写会用 ${t.live.dbName} 的内容整库覆盖 ${t.targetDb}，请一字不差复述目标库名 ${t.targetDb}` }); return; }
    const { engine } = t.live;
    try {
      const [parentBefore, derivedBefore] = await Promise.all([ops.tableCounts(engine, t.infra, t.targetDb), ops.tableCounts(engine, t.infra, t.live.dbName)]);
      const preview = buildWriteBackPreview(t.live, t.targetDb, parentBefore, derivedBefore);
      // 门禁：目标库先自动备份且演练通过；演练不通过整个回写中止，目标库一个字节没动
      const guard = await backupAndDrill(t.p, engine, t.infra, t.targetDb, 'pre-writeback');
      if (!guard.ok) { res.status(422).json({ error: `回写中止：目标库 ${t.targetDb} 的回写前备份演练未通过（${guard.detail}），目标库未动；备份文件 ${guard.backup.file}` }); return; }
      const entry = materializeEntry(stateService, t.view, t.live.id, now())!;
      // 目标库先删后建：postgres 的库级授权会随 DROP 消失，替换完把应用用户的权限补回去（mysql 的授权本就跨 DROP 保留）
      const grantTo = writeBackGrantTo(entry);
      await ops.replaceDbFrom(engine, t.infra, entry.dbName, t.targetDb, grantTo);
      const [parentAfter, derivedAfter] = await Promise.all([ops.tableCounts(engine, t.infra, t.targetDb), ops.tableCounts(engine, t.infra, entry.dbName)]);
      const verification = compareTableCounts(parentAfter, derivedAfter, now());
      const actor = String((req as any).cdsPrincipal?.name || (req as any).cdsProjectKey?.keyId || 'admin');
      const record: DbWriteBackRecord = {
        id: `wb_${randomUUID().replace(/-/g, '').slice(0, 12)}`, targetDb: t.targetDb, at: now().toISOString(), by: actor,
        snapshot: guard.backup, conflicts: preview.conflicts, baselineKind: preview.baselineKind, verification,
      };
      const next: DbLedgerEntry = { ...entry, writeBacks: [...(entry.writeBacks ?? []), record], updatedAt: now().toISOString() };
      stateService.upsertDbLedgerEntry(next);
      stateService.save();
      const overwritten = preview.conflicts.length > 0 ? `；覆盖了 ${preview.conflicts.length} 张主库改过的表（${preview.conflicts.map((c) => c.table).join('、')}）` : '';
      res.json({ entry: next, record, message: `已回写 ${entry.dbName} → ${t.targetDb}：${describeCloneVerification(verification)}${overwritten}；回写前快照已演练验证，可回退到 ${guard.backup.createdAt}` });
    } catch (err) {
      res.status(500).json({ error: `回写失败：${(err as Error).message}` });
    }
  });

  router.post('/projects/:id/db-ledger/:entryId/write-backs/:wbId/rollback', async (req, res) => {
    const p = guardProject(req, res); if (!p) return;
    const entry = stateService.getDbLedgerEntry(req.params.entryId);
    if (!entry || entry.projectId !== p.id) { res.status(404).json({ error: `台账条目不存在: ${req.params.entryId}` }); return; }
    const record = (entry.writeBacks ?? []).find((w) => w.id === req.params.wbId);
    if (!record) { res.status(404).json({ error: `回写记录不存在: ${req.params.wbId}` }); return; }
    if (record.rolledBackAt) { res.status(409).json({ error: `这次回写已于 ${record.rolledBackAt} 回退过` }); return; }
    const confirm = typeof req.body?.confirmDbName === 'string' ? req.body.confirmDbName : '';
    if (confirm !== record.targetDb) { res.status(400).json({ error: `回退会用回写前快照整库覆盖 ${record.targetDb}，请一字不差复述目标库名 ${record.targetDb}` }); return; }
    const infra = infraOf(p.id, entry);
    if (!infra) { res.status(409).json({ error: `找不到承载 ${entry.dbName} 的基础设施实例` }); return; }
    if (!fs.existsSync(record.snapshot.file)) { res.status(409).json({ error: `回写前快照已不在宿主上：${record.snapshot.file}` }); return; }
    try {
      // 回退也是一次替换：目标库先再拍一次快照并演练，不做静默覆盖
      const guard = await backupAndDrill(p, entry.engine, infra, record.targetDb, 'pre-rollback');
      if (!guard.ok) { res.status(422).json({ error: `回退中止：目标库 ${record.targetDb} 的回退前备份演练未通过（${guard.detail}），目标库未动` }); return; }
      await ops.restoreInto(entry.engine, infra, record.snapshot.file, record.targetDb);
      const objects = await ops.countObjects(entry.engine, infra, record.targetDb);
      const expected = record.snapshot.objects;
      const rollbackCheck = { ok: expected === undefined ? objects > 0 : objects === expected, objects, expected, measuredAt: now().toISOString() };
      const nextRecord: DbWriteBackRecord = { ...record, rolledBackAt: now().toISOString(), rollbackSnapshot: guard.backup, rollbackCheck };
      const next: DbLedgerEntry = { ...entry, writeBacks: (entry.writeBacks ?? []).map((w) => (w.id === record.id ? nextRecord : w)), updatedAt: now().toISOString() };
      stateService.upsertDbLedgerEntry(next);
      stateService.save();
      res.json({ entry: next, record: nextRecord, message: `已把 ${record.targetDb} 回退到 ${record.snapshot.createdAt} 的快照：${objects} 个表/集合${expected !== undefined ? `（快照时 ${expected} 个${rollbackCheck.ok ? '，一致' : '，不一致'}）` : ''}` });
    } catch (err) {
      res.status(500).json({ error: `回退失败：${(err as Error).message}` });
    }
  });

  router.post('/projects/:id/db-ledger/scan', async (req, res) => {
    const p = guardProject(req, res); if (!p) return;
    try {
      const view = buildProjectDbLedgerView(stateService, p.id, now());
      const known = new Set<string>(view.entries.map((e) => e.dbName));
      const revivedEntries: DbLedgerEntry[] = [];
      // 项目内所有服务的源库（共享库本体）也算已知
      for (const d of collectDerivedDbs(stateService, p.id)) known.add(d.sourceDb);
      for (const branch of stateService.getBranchesForProject(p.id)) {
        for (const s of branch.replicaDbSnapshots ?? []) known.add(s.sourceDb);
      }
      const infras = stateService.getInfraServicesForProject(p.id).filter((s) => ['mysql', 'postgres', 'mongo'].includes(detectInfraDataKind(s.dockerImage) || ''));
      const added: DbLedgerEntry[] = [];
      const scanned: Array<{ infraId: string; engine: ReplicaDbEngine; databases: string[]; error?: string }> = [];
      for (const infra of infras) {
        const engine = detectInfraDataKind(infra.dockerImage) as ReplicaDbEngine;
        try {
          // 源库本体：项目里配置引用到的库名（不带后缀的）——用 resolver 走一遍每个 profile 太重，
          // 这里把 known 里所有条目的 sourceDb 也算进去
          const listed = await ops.listDatabases(engine, infra);
          scanned.push({ infraId: infra.id, engine, databases: listed });
          // 扫描核实：台账记成「已丢弃」的库又出现在实例上（删分支丢库后又重建、或丢弃其实没成功）→ 复活为活跃
          for (const rec of stateService.getDbLedger(p.id)) {
            if (rec.status !== 'dropped' || rec.infraContainer !== infra.containerName || !listed.includes(rec.dbName)) continue;
            const t = now().toISOString();
            const { droppedAt: _da, droppedBy: _db, droppedForced: _df, ...rest } = rec;
            const revived: DbLedgerEntry = { ...rest, status: 'active', updatedAt: t, note: `扫描 ${infra.id} 核实：库仍在实例上，已从「已丢弃」复活（${t}）` };
            stateService.upsertDbLedgerEntry(revived);
            revivedEntries.push(revived);
          }
          const sourceDbs = new Set(view.entries.map((e) => e.sourceDb).filter((x): x is string => !!x));
          for (const db of unknownDatabases(listed, new Set([...known, ...sourceDbs]), new Set(SYSTEM_DBS[engine]))) {
            const t = now().toISOString();
            const entry: DbLedgerEntry = {
              id: `dbl_scan_${infra.id}_${db}`.replace(/[^A-Za-z0-9_]/g, '_'), projectId: p.id, kind: 'unknown', engine, dbName: db,
              infraId: infra.id, infraContainer: infra.containerName, origin: 'scan', status: 'active',
              createdAt: t, updatedAt: t, backups: [], note: `扫描 ${infra.id} 补录：来源未知（CDS 台账里没有它的派生记录）`,
            };
            stateService.upsertDbLedgerEntry(entry);
            added.push(entry);
            known.add(db);
          }
        } catch (err) {
          scanned.push({ infraId: infra.id, engine, databases: [], error: (err as Error).message });
        }
      }
      if (added.length > 0 || revivedEntries.length > 0) stateService.save();
      res.json({ added, revived: revivedEntries, scanned, view: buildProjectDbLedgerView(stateService, p.id, now()) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/projects/:id/db-ledger/:entryId/backup', async (req, res) => {
    const p = guardProject(req, res); if (!p) return;
    const view = buildProjectDbLedgerView(stateService, p.id, now());
    const entry = materializeEntry(stateService, view, req.params.entryId, now());
    if (!entry) { res.status(404).json({ error: `台账条目不存在: ${req.params.entryId}` }); return; }
    if (entry.status === 'dropped') { res.status(409).json({ error: `${entry.dbName} 已丢弃，无法备份` }); return; }
    const infra = infraOf(p.id, entry);
    if (!infra) { res.status(409).json({ error: `找不到承载 ${entry.dbName} 的基础设施实例（${entry.infraContainer}）` }); return; }
    try {
      const dir = pickBackupDir(p.slug, deps.repoRoot);
      const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const file = path.join(dir, `db-ledger--${p.id}--${entry.dbName}-${stamp}.${BACKUP_EXT[entry.engine]}`);
      const objects = await ops.countObjects(entry.engine, infra, entry.dbName).catch(() => undefined);
      const meta = await ops.dumpToFile(entry.engine, infra, entry.dbName, file);
      const backup = backupRecord(file, { ...meta, objects }, now());
      const next: DbLedgerEntry = {
        ...entry, backups: [...entry.backups, backup], updatedAt: now().toISOString(),
        ...(objects !== undefined ? { lastObjects: { count: objects, measuredAt: now().toISOString() } } : {}),
      };
      stateService.upsertDbLedgerEntry(next);
      stateService.save();
      res.json({ entry: next, backup, message: `已备份 ${entry.dbName}（${(meta.bytes / 1024).toFixed(1)} KB${objects !== undefined ? `，${objects} 个表/集合` : ''}）；演练验证一次后才算备份` });
    } catch (err) {
      res.status(500).json({ error: `备份失败：${(err as Error).message}` });
    }
  });

  router.post('/projects/:id/db-ledger/:entryId/backups/:backupId/verify', async (req, res) => {
    const p = guardProject(req, res); if (!p) return;
    const entry = stateService.getDbLedgerEntry(req.params.entryId);
    if (!entry || entry.projectId !== p.id) { res.status(404).json({ error: `台账条目不存在: ${req.params.entryId}` }); return; }
    const backup = entry.backups.find((b) => b.id === req.params.backupId);
    if (!backup) { res.status(404).json({ error: `备份不存在: ${req.params.backupId}` }); return; }
    const infra = infraOf(p.id, entry);
    if (!infra) { res.status(409).json({ error: `找不到承载 ${entry.dbName} 的基础设施实例` }); return; }
    if (!fs.existsSync(backup.file)) { res.status(409).json({ error: `备份文件已不在宿主上：${backup.file}` }); return; }
    try {
      const scratch = scratchDbName(entry.dbName, now());
      const { objects } = await ops.restoreDrill(entry.engine, infra, backup.file, scratch);
      const expected = backup.objects;
      const ok = expected === undefined ? objects > 0 : objects === expected;
      const detail = expected === undefined
        ? `还原到临时库 ${scratch} 得到 ${objects} 个表/集合（备份时未记录对象数）`
        : `还原到临时库 ${scratch} 得到 ${objects} 个表/集合，备份时源库 ${expected} 个${ok ? '，一致' : '，不一致'}`;
      const nextBackup = { ...backup, verifyDetail: detail, ...(ok ? { verifiedAt: now().toISOString() } : {}) };
      const next: DbLedgerEntry = { ...entry, backups: entry.backups.map((b) => (b.id === backup.id ? nextBackup : b)), updatedAt: now().toISOString() };
      stateService.upsertDbLedgerEntry(next);
      stateService.save();
      if (!ok) { res.status(422).json({ error: `演练未通过：${detail}`, entry: next }); return; }
      res.json({ entry: next, backup: nextBackup, message: `演练通过：${detail}。这份备份现在算数了` });
    } catch (err) {
      res.status(500).json({ error: `演练失败：${(err as Error).message}` });
    }
  });

  router.delete('/projects/:id/db-ledger/:entryId', async (req, res) => {
    const p = guardProject(req, res); if (!p) return;
    const view = buildProjectDbLedgerView(stateService, p.id, now());
    const live = view.entries.find((e) => e.id === req.params.entryId);
    if (!live) { res.status(404).json({ error: `台账条目不存在: ${req.params.entryId}` }); return; }
    if (live.status === 'dropped') { res.status(409).json({ error: `${live.dbName} 已经丢弃过了` }); return; }
    // 还在被分支引用的隔离库 / 在跑分支的独立库不许直接丢：先删分支或回切
    if (live.status === 'active' && live.branchId && stateService.getBranch(live.branchId)) {
      res.status(409).json({ error: `${live.dbName} 仍属于分支 ${live.branch}，先删除该分支（默认保留库，之后再来丢弃）或回切主库` });
      return;
    }
    const naming = isDroppableDerivedName(live);
    if (!naming.ok) { res.status(409).json({ error: naming.reason }); return; }
    const force = req.body?.force && typeof req.body.force.confirmDbName === 'string' ? { confirmDbName: req.body.force.confirmDbName } : undefined;
    const gate = assertDropAllowed(live, { force });
    if (!gate.ok) { res.status(gate.status).json({ error: gate.message, missing: gate.missing }); return; }
    const infra = infraOf(p.id, live);
    if (!infra && !live.dedicatedContainer) { res.status(409).json({ error: `找不到承载 ${live.dbName} 的基础设施实例` }); return; }
    try {
      const entry = materializeEntry(stateService, view, live.id, now())!;
      await ops.dropDb(entry.engine, infra ?? ({ containerName: entry.infraContainer } as any), entry);
      const actor = String((req as any).cdsPrincipal?.name || (req as any).cdsProjectKey?.keyId || 'admin');
      const next: DbLedgerEntry = { ...entry, status: 'dropped', droppedAt: now().toISOString(), droppedBy: actor, droppedForced: gate.forced, updatedAt: now().toISOString() };
      stateService.upsertDbLedgerEntry(next);
      stateService.save();
      res.json({ entry: next, message: gate.forced ? `已强制丢弃 ${entry.dbName}（未备份，已记入台账）` : `已丢弃 ${entry.dbName}；备份留在 ${entry.backups.length} 份，可随时还原` });
    } catch (err) {
      res.status(500).json({ error: `丢弃失败：${(err as Error).message}` });
    }
  });

  return router;
}
