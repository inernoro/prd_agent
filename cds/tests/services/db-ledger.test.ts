/**
 * 数据台账（数据库隔离收敛 3）：派生库不失踪，删除不丢数据。
 *
 * 钉住：
 *   1. 一本台账：分支上的隔离库快照（运行时真相）、按配置折算的分支独立库、台账里记着的孤儿 /
 *      已丢弃 / 扫描补录条目合并成同一份视图，按血缘（源库）成树；每条都能回答「从谁来、
 *      什么时候、多大、备份在哪」。
 *   2. 丢弃门禁：没有演练验证过的备份 → 拒绝并说缺什么；用户复述库名才能强制。
 *   3. 删分支默认保留：派生库转孤儿条目留在台账里，而不是随分支一起消失。
 */
import { describe, expect, it } from 'vitest';
import {
  assertDropAllowed,
  retainedDedicatedContainers,
  buildDbLedgerView,
  orphanEntryForSnapshot,
  stripBranchSuffix,
  type DbLedgerDerived,
} from '../../src/services/db-ledger.js';
import { dumpArgv, restoreDrillArgv } from '../../src/services/db-ledger-ops.js';
import type { BranchEntry, DbLedgerEntry, InfraService, ReplicaDbSnapshot } from '../../src/types.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T = '2026-09-03T08:00:00.000Z';

const snapshot = (o: Partial<ReplicaDbSnapshot> = {}): ReplicaDbSnapshot => ({
  id: 'snap-1', profileId: 'api', memberId: 'r1', engine: 'mysql', sourceDb: 'shop', dbName: 'shop_rs_ab12cd_r1',
  infraContainer: 'cds-infra-mysql', clonedAt: T, ...o,
});
const branch = (o: Partial<BranchEntry> = {}): BranchEntry => ({
  id: 'p-feat-x', projectId: 'p', branch: 'feat/x', worktreePath: '/x', services: {}, status: 'running', createdAt: T, ...o,
} as BranchEntry);
const entry = (o: Partial<DbLedgerEntry> = {}): DbLedgerEntry => ({
  id: 'e1', projectId: 'p', kind: 'per-branch', engine: 'mysql', dbName: 'shop_feat_x', infraContainer: 'cds-infra-mysql',
  sourceDb: 'shop', origin: 'cds', status: 'active', createdAt: T, updatedAt: T, backups: [], ...o,
});

describe('buildDbLedgerView：一本台账、按血缘成树', () => {
  it('隔离库快照 + 分支独立库 + 台账孤儿条目 合并到同一棵树，源库做根', () => {
    const derived: DbLedgerDerived[] = [
      { branchId: 'p-feat-x', branch: 'feat/x', profileId: 'api', engine: 'mysql', sourceDb: 'shop', dbName: 'shop_feat_x', infraId: 'mysql', infraContainer: 'cds-infra-mysql' },
    ];
    const recorded: DbLedgerEntry[] = [
      entry({ id: 'orphan-1', dbName: 'shop_old_branch', status: 'orphaned', orphanedAt: T, branch: 'old/branch', backups: [{ id: 'b1', file: '/b/x.sql.gz', bytes: 10, sha256: 'x', createdAt: T, verifiedAt: T }] }),
      entry({ id: 'scan-1', kind: 'unknown', dbName: 'legacy_2024', sourceDb: undefined, origin: 'scan' }),
    ];
    const view = buildDbLedgerView({
      projectId: 'p',
      branches: [branch({ replicaDbSnapshots: [snapshot()] })],
      derived,
      recorded,
      now: new Date(T),
    });
    const names = view.entries.map((e) => `${e.kind}:${e.dbName}:${e.status}`).sort();
    expect(names).toEqual([
      'isolated:shop_rs_ab12cd_r1:active',
      'per-branch:shop_feat_x:active',
      'per-branch:shop_old_branch:orphaned',
      'unknown:legacy_2024:active',
    ]);
    // 血缘树：shop 下挂着隔离库、独立库、孤儿；来源未知的单独一组
    const roots = Object.fromEntries(view.tree.map((n) => [n.sourceDb ?? '(未知)', n.children.map((c) => c.dbName).sort()]));
    expect(roots.shop).toEqual(['shop_feat_x', 'shop_old_branch', 'shop_rs_ab12cd_r1']);
    expect(roots['(未知)']).toEqual(['legacy_2024']);
    // 每条都能回答「从谁来、什么时候、备份在哪」
    const iso = view.entries.find((e) => e.dbName === 'shop_rs_ab12cd_r1')!;
    expect(iso).toMatchObject({ sourceDb: 'shop', createdAt: T, branch: 'feat/x', snapshotId: 'snap-1', backups: [] });
    expect(view.summary).toMatchObject({ total: 4, active: 3, orphaned: 1, unknown: 1, withVerifiedBackup: 1, withoutBackup: 3 });
  });

  it('台账里已记的备份挂回运行时快照（同一个 snapshotId），不出现两条', () => {
    const recorded = [entry({ id: 'led-snap', kind: 'isolated', dbName: 'shop_rs_ab12cd_r1', snapshotId: 'snap-1', backups: [{ id: 'b1', file: '/b/a.sql.gz', bytes: 5, sha256: 'y', createdAt: T }] })];
    const view = buildDbLedgerView({ projectId: 'p', branches: [branch({ replicaDbSnapshots: [snapshot()] })], derived: [], recorded, now: new Date(T) });
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0].backups).toHaveLength(1);
    expect(view.entries[0].id).toBe('led-snap');
  });

  it('分支回切主库后：台账里记着的独立库不再被任何配置折算出来，视图标孤儿并写明原因，让丢弃门禁放行', () => {
    const recorded = [entry({ id: 'e-back', dbName: 'shop_feat_x', branchId: 'p-feat-x', branch: 'feat/x', profileId: 'api' })];
    const view = buildDbLedgerView({ projectId: 'p', branches: [branch()], derived: [], recorded, now: new Date(T) });
    const e = view.entries.find((x) => x.id === 'e-back')!;
    expect(e.status).toBe('orphaned');
    expect(e.orphanedAt).toBe(T);
    expect(e.note).toMatch(/回切主库/);
    expect(view.summary).toMatchObject({ orphaned: 1, active: 0 });
    // 分支还在按独立库跑（折算得到同一个库）→ 仍是活跃
    const still = buildDbLedgerView({ projectId: 'p', branches: [branch()], derived: [{ branchId: 'p-feat-x', branch: 'feat/x', profileId: 'api', engine: 'mysql', sourceDb: 'shop', dbName: 'shop_feat_x', infraId: 'mysql', infraContainer: 'cds-infra-mysql' }], recorded, now: new Date(T) });
    expect(still.entries.find((x) => x.id === 'e-back')!.status).toBe('active');
  });

  it('已丢弃的条目留在台账里可追溯，但不算活跃', () => {
    const recorded = [entry({ id: 'gone', status: 'dropped', droppedAt: T, droppedBy: 'admin' })];
    const view = buildDbLedgerView({ projectId: 'p', branches: [], derived: [], recorded, now: new Date(T) });
    expect(view.entries[0].status).toBe('dropped');
    expect(view.summary).toMatchObject({ total: 1, active: 0, dropped: 1 });
  });
});

describe('stripBranchSuffix：分支独立库的血缘', () => {
  it('去掉本分支 slug 后缀得到源库', () => {
    expect(stripBranchSuffix('shop_feat_x', 'feat/x')).toBe('shop');
    expect(stripBranchSuffix('shop', 'feat/x')).toBe('shop');
  });
});

describe('assertDropAllowed：删之前必有备份', () => {
  it('没有任何备份 → 拒绝，说明缺备份', () => {
    const r = assertDropAllowed(entry());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toBe('backup');
      expect(r.message).toContain('shop_feat_x');
      expect(r.message).toContain('先备份');
    }
  });

  it('有备份但从没演练还原过 → 拒绝，说明缺验证（从没成功还原过的备份不算备份）', () => {
    const r = assertDropAllowed(entry({ backups: [{ id: 'b', file: '/b', bytes: 1, sha256: 's', createdAt: T }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toBe('verified-backup');
      expect(r.message).toContain('演练');
    }
  });

  it('有演练验证过的备份 → 放行', () => {
    const r = assertDropAllowed(entry({ backups: [{ id: 'b', file: '/b', bytes: 1, sha256: 's', createdAt: T, verifiedAt: T }] }));
    expect(r).toEqual({ ok: true, forced: false });
  });

  it('强制：复述库名一字不差才放行，并标 forced', () => {
    expect(assertDropAllowed(entry(), { force: { confirmDbName: 'shop_feat_x' } })).toEqual({ ok: true, forced: true });
    const wrong = assertDropAllowed(entry(), { force: { confirmDbName: 'shop_feat' } });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.message).toContain('复述');
  });
});

describe('orphanEntryForSnapshot：删分支默认保留，隔离库转孤儿条目', () => {
  it('把快照的定位信息（容器、专用实例、凭据标记）完整带进台账，状态 orphaned', () => {
    const e = orphanEntryForSnapshot(branch(), snapshot({ dedicatedContainer: 'cds-rsdb-x', dedicatedHostPort: 31001, dedicatedAuth: 'source-infra' }), 'mysql', new Date(T));
    expect(e).toMatchObject({
      projectId: 'p', kind: 'isolated', engine: 'mysql', dbName: 'shop_rs_ab12cd_r1', sourceDb: 'shop', infraId: 'mysql',
      infraContainer: 'cds-infra-mysql', branchId: 'p-feat-x', branch: 'feat/x', profileId: 'api', memberId: 'r1', snapshotId: 'snap-1',
      dedicatedContainer: 'cds-rsdb-x', dedicatedHostPort: 31001, dedicatedAuth: 'source-infra',
      origin: 'cds', status: 'orphaned', orphanedAt: T, createdAt: T, backups: [],
    });
  });
});

describe('settleBranchDbsOnDelete：删分支默认保留，勾选丢弃走门禁', () => {
  it('不勾选 → 隔离库与独立库都转孤儿写进台账；勾选丢弃但没备份 → 拒绝并仍保留；复述库名 → 进 toDrop', async () => {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const { StateService } = await import('../../src/services/state.js');
    const { settleBranchDbsOnDelete } = await import('../../src/services/db-ledger.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-ledger-settle-'));
    const state = new StateService(path.join(tmp, 'state.json'), tmp); state.load();
    state.addProject({ id: 'p', slug: 'p', name: 'P', kind: 'git', createdAt: T, updatedAt: T } as any);
    state.addBuildProfile({ id: 'api', projectId: 'p', name: 'API', dockerImage: 'node:20', workDir: '.', containerPort: 3000, dbScope: 'per-branch', env: { CDS_MYSQL_DATABASE: 'shop' } } as any);
    state.addInfraService({ id: 'mysql', name: 'mysql', projectId: 'p', scope: 'project', dockerImage: 'mysql:8', containerName: 'cds-infra-mysql', hostPort: 0, containerPort: 3306, status: 'running', env: {} } as any);
    const b = branch({ replicaDbSnapshots: [snapshot({ sourceDb: 'shop_feat_x', dbName: 'shop_feat_x_rs_ab12cd_r1' })] });
    state.addBranch(b as any);
    const now = new Date(T);
    const keepAll = settleBranchDbsOnDelete(state, state.getBranch('p-feat-x')!, [], now);
    expect(keepAll.toDrop).toEqual([]);
    expect(keepAll.kept.map((e) => `${e.kind}:${e.dbName}:${e.status}`).sort()).toEqual(['isolated:shop_feat_x_rs_ab12cd_r1:orphaned', 'per-branch:shop_feat_x:orphaned']);
    expect(state.getDbLedger('p').filter((e) => e.status === 'orphaned')).toHaveLength(2);
    const refused = settleBranchDbsOnDelete(state, state.getBranch('p-feat-x')!, [{ dbName: 'shop_feat_x', action: 'drop' }], now);
    expect(refused.refused[0]).toMatchObject({ dbName: 'shop_feat_x' });
    expect(refused.refused[0].reason).toContain('先备份');
    const forced = settleBranchDbsOnDelete(state, state.getBranch('p-feat-x')!, [{ dbName: 'shop_feat_x', action: 'drop', confirmDbName: 'shop_feat_x' }], now);
    expect(forced.toDrop.map((e) => e.dbName)).toEqual(['shop_feat_x']);
    expect(forced.toDrop[0].droppedForced).toBe(true);
    // 孤儿条目幂等：反复结算不会长出重复记录
    expect(state.getDbLedger('p').filter((e) => e.dbName === 'shop_feat_x')).toHaveLength(1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('备份 dump：dump 失败必须让备份失败（Codex P1）', () => {
  const infra = { id: 'mysql', containerName: 'cds-infra-mysql', containerPort: 3306, env: { MYSQL_ROOT_PASSWORD: 'pw' } } as unknown as InfraService;
  const pg = { id: 'pg', containerName: 'cds-infra-pg', containerPort: 5432, env: { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'pw' } } as unknown as InfraService;
  it('关系型 dump 两阶段落盘再压缩，不用 `dump | gzip`（POSIX sh 管道退出码取 gzip，dump 半路失败也是 0）', () => {
    for (const [engine, i, tool] of [['mysql', infra, 'mysqldump'], ['postgres', pg, 'pg_dump']] as const) {
      const { argv } = dumpArgv(engine, i, 'shop');
      const script = argv[argv.length - 1];
      expect(script).toContain('set -e');
      expect(script).toMatch(new RegExp(`${tool} [^|]* > /tmp/`));
      expect(script).not.toMatch(/\| *gzip/);
      expect(script).toMatch(/gzip -c \/tmp\//);
      expect(script).not.toContain('pw');
    }
  });
});

describe('演练还原：解压失败必须让演练失败（Codex P1）', () => {
  const infra = { id: 'mysql', containerName: 'cds-infra-mysql', containerPort: 3306, env: { MYSQL_ROOT_PASSWORD: 'pw' } } as unknown as InfraService;
  const pg = { id: 'pg', containerName: 'cds-infra-pg', containerPort: 5432, env: { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'pw' } } as unknown as InfraService;
  it('gunzip 先落盘再喂客户端，不用 `gunzip -c | client`（截断的 gzip 让 gunzip 失败、client 读到合法前缀照样 0）', () => {
    for (const [engine, i] of [['mysql', infra], ['postgres', pg]] as const) {
      const { argv } = restoreDrillArgv(engine, i, 'cds_drill_x');
      const script = argv[argv.length - 1];
      expect(script).toContain('set -e');
      expect(script).toMatch(/gunzip -c > \/tmp\//);
      expect(script).not.toMatch(/gunzip -c \|/);
      expect(script).not.toContain('pw');
    }
  });
});

describe('删项目级联：台账里保留下来的专用隔离实例也要一起拆（Codex P1）', () => {
  it('活跃 / 孤儿条目的 dedicatedContainer 列出来，已丢弃的不算', () => {
    const names = retainedDedicatedContainers([
      entry({ id: 'a', kind: 'isolated', engine: 'mongo', dbName: 'cat_rs_1', dedicatedContainer: 'cds-rsdb-a-cat_rs_1', status: 'orphaned' }),
      entry({ id: 'b', kind: 'isolated', engine: 'mongo', dbName: 'cat_rs_2', dedicatedContainer: 'cds-rsdb-b-cat_rs_2', status: 'dropped' }),
      entry({ id: 'c', kind: 'isolated', engine: 'mongo', dbName: 'cat_rs_3', dedicatedContainer: 'cds-rsdb-c-cat_rs_3' }),
      entry({ id: 'd' }),
    ]);
    expect(names).toEqual(['cds-rsdb-a-cat_rs_1', 'cds-rsdb-c-cat_rs_3']);
  });
  it('删项目路由把台账里的专用实例列进拆除清单（接线守卫）', () => {
    const s = fs.readFileSync(path.join(CDS_ROOT, 'src/routes/projects.ts'), 'utf8');
    expect(s).toContain('retainedDedicatedContainers(');
  });
});
