// 数据台账路由（数据库隔离收敛 3，2026-09-03）
//
//   GET    /api/projects/:id/db-ledger                                  一本台账（血缘树 + 摘要）
//   POST   /api/projects/:id/db-ledger/scan                             扫描实例补录来源未知的存量库
//   POST   /api/projects/:id/db-ledger/:entryId/backup                  备份一条派生库到宿主备份目录
//   POST   /api/projects/:id/db-ledger/:entryId/backups/:backupId/verify 演练还原到临时库并核对对象数
//   DELETE /api/projects/:id/db-ledger/:entryId                         丢弃（门禁：演练验证过的备份，或复述库名强制）
//   GET    /api/branches/:id/db-ledger                                  某条分支的派生库（删分支对话框用）
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
import type { ReplicaDbEngine } from '../services/replica-db-clone.js';

export interface DbLedgerRouterDeps {
  stateService: StateService;
  assertProjectAccess: (req: Request, projectId: string) => { status: number; body: unknown } | null;
  ops?: DbLedgerOps;
  repoRoot?: string;
  now?: () => Date;
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

  const infraOf = (projectId: string, entry: DbLedgerEntry) =>
    stateService.getInfraServicesForProject(projectId).find((s) => s.containerName === entry.infraContainer || s.id === entry.infraId);

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

  router.post('/projects/:id/db-ledger/scan', async (req, res) => {
    const p = guardProject(req, res); if (!p) return;
    try {
      const view = buildProjectDbLedgerView(stateService, p.id, now());
      const known = new Set<string>(view.entries.map((e) => e.dbName));
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
      if (added.length > 0) stateService.save();
      res.json({ added, scanned, view: buildProjectDbLedgerView(stateService, p.id, now()) });
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
