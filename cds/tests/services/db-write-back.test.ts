/**
 * 数据库隔离收敛 5：回写（派生库整库写回源库）。
 * 分支独立库与隔离库共用同一套门禁、冲突清单与替换 / 还原脚本。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBackConflicts, assertWriteBackAllowed, writeBackHeadline, buildWriteBackPreview } from '../../src/services/db-write-back.js';
import { relationalReplaceArgv, relationalRestoreScript, type DbCloneSpec } from '../../src/services/db-clone-pipeline.js';
import type { DbLedgerEntry, InfraService } from '../../src/types.js';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T = '2026-09-04T06:00:00.000Z';
const mysqlInfra = { id: 'mysql', name: 'mysql', projectId: 'p', scope: 'project', dockerImage: 'mysql:8', containerName: 'cds-infra-mysql', hostPort: 0, containerPort: 3306, status: 'running', env: { MYSQL_ROOT_PASSWORD: 'rootpw' } } as unknown as InfraService;
const pgInfra = { ...mysqlInfra, id: 'pg', dockerImage: 'postgres:16', containerName: 'cds-infra-pg', containerPort: 5432, env: { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pgpw' } } as unknown as InfraService;

function entry(o: Partial<DbLedgerEntry> & { dbName: string }): DbLedgerEntry {
  return { id: `id-${o.dbName}`, projectId: 'p', kind: 'per-branch', engine: 'mysql', infraContainer: 'cds-infra-mysql', sourceDb: 'shop', origin: 'cds', status: 'active', createdAt: T, updatedAt: T, backups: [], ...o };
}

describe('回写冲突清单', () => {
  it('有克隆时基线：主库在克隆之后被写过的表才算冲突（回写会覆盖它们）；主库新建的表会丢', () => {
    const r = writeBackConflicts({ users: 3, orders: 58, audit: 5 }, { users: 3, orders: 57 }, { users: 3, orders: 57 });
    expect(r.baselineKind).toBe('clone-time');
    expect(r.conflicts).toEqual([
      { table: 'audit', parentNow: 5, reason: 'parent-only' },
      { table: 'orders', baseline: 57, parentNow: 58, derived: 57, reason: 'parent-changed' },
    ]);
  });

  it('主库自克隆后没动：冲突为空，派生库自己改了多少行不算冲突', () => {
    const r = writeBackConflicts({ users: 3, orders: 57 }, { users: 9, orders: 100 }, { users: 3, orders: 57 });
    expect(r.conflicts).toEqual([]);
    expect(r.baselineKind).toBe('clone-time');
  });

  it('没有基线（隔离库或旧条目）：按主库与派生库当前差异列出，并标 baselineKind=none', () => {
    const r = writeBackConflicts({ users: 3, orders: 58 }, { users: 3, orders: 57 });
    expect(r.baselineKind).toBe('none');
    expect(r.conflicts).toEqual([{ table: 'orders', parentNow: 58, derived: 57, reason: 'differs' }]);
  });
});

describe('回写门禁：分支独立库与隔离库同一套', () => {
  it('活跃或孤儿的分支独立库 / 隔离库可以回写；来源未知、已丢弃、mongo、专用实例一律拒绝并说明', () => {
    expect(assertWriteBackAllowed(entry({ dbName: 'shop_feat_x' }))).toEqual({ ok: true, targetDb: 'shop' });
    expect(assertWriteBackAllowed(entry({ dbName: 'shop_rs_ab_r1', kind: 'isolated', status: 'orphaned' }))).toEqual({ ok: true, targetDb: 'shop' });
    expect(assertWriteBackAllowed(entry({ dbName: 'legacy', kind: 'unknown', sourceDb: undefined, origin: 'scan' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/来源未知|没有源库/) });
    expect(assertWriteBackAllowed(entry({ dbName: 'shop_old', status: 'dropped' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/已丢弃/) });
    expect(assertWriteBackAllowed(entry({ dbName: 'cat_feat_x', engine: 'mongo', sourceDb: 'cat' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/mongo/i) });
    expect(assertWriteBackAllowed(entry({ dbName: 'shop_rs_ab_r1', kind: 'isolated', dedicatedContainer: 'cds-rsdb-x' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/专用实例/) });
    expect(assertWriteBackAllowed(entry({ dbName: 'shop', sourceDb: 'shop' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/等于源库/) });
  });

  it('预览的基线取克隆物在克隆时的行数（校验表 target 列），不是克隆后才量的主库行数', () => {
    const e = entry({ dbName: 'shop_feat_x', clone: { sourceDb: 'shop', clonedAt: T, verification: { ok: false, measuredAt: T, tables: [{ table: 'orders', source: 58, target: 57 }, { table: 'users', source: 3, target: 3 }], mismatched: ['orders'], sourceOnly: [], targetOnly: [] } } });
    const p = buildWriteBackPreview(e, 'shop', { orders: 58, users: 3 }, { orders: 57, users: 3 });
    expect(p.baselineKind).toBe('clone-time');
    expect(p.conflicts).toEqual([{ table: 'orders', baseline: 57, parentNow: 58, derived: 57, reason: 'parent-changed' }]);
    expect(p.tables).toEqual([{ table: 'orders', parent: 58, derived: 57 }, { table: 'users', parent: 3, derived: 3 }]);
  });

  it('预览第一句是判断：几张表会被覆盖、回写前先备份并演练', () => {
    const line = writeBackHeadline({ targetDb: 'shop', derivedDb: 'shop_feat_x', conflicts: [{ table: 'orders', baseline: 57, parentNow: 58, derived: 57, reason: 'parent-changed' }], baselineKind: 'clone-time', tables: [] });
    expect(line).toContain('shop_feat_x');
    expect(line).toContain('1 张表');
    expect(line).toContain('先自动备份 shop 并演练验证');
    const clean = writeBackHeadline({ targetDb: 'shop', derivedDb: 'shop_feat_x', conflicts: [], baselineKind: 'clone-time', tables: [] });
    expect(clean).toContain('克隆之后没有被写过');
  });
});

describe('替换与还原脚本：同一条三元组管线', () => {
  const spec = (o: Partial<DbCloneSpec> = {}): DbCloneSpec => ({ engine: 'mysql', infra: mysqlInfra, sourceDb: 'shop_feat_x', targetDb: 'shop', scope: { kind: 'per-branch', projectId: 'p', branchId: 'b', profileId: 'api' }, ...o });
  it('mysql：dump 派生库 → 删掉并重建目标库 → 导入；凭据只经 -e 注入', () => {
    const r = relationalReplaceArgv(spec());
    const script = r.argv[r.argv.length - 1];
    expect(r.argv[0]).toBe('run');
    expect(script).toContain('mysqldump -h127.0.0.1 -P3306 -uroot --single-transaction --routines --triggers shop_feat_x > /tmp/rsclone.sql');
    expect(script).toContain('DROP DATABASE IF EXISTS `shop`');
    expect(script).toContain('CREATE DATABASE `shop`');
    expect(script).toContain('mysql -h127.0.0.1 -P3306 -uroot shop < /tmp/rsclone.sql');
    expect(script).not.toContain('rootpw');
  });
  it('postgres：先踢掉目标库上的连接再 DROP / CREATE / 导入', () => {
    const r = relationalReplaceArgv(spec({ engine: 'postgres', infra: pgInfra }));
    const script = r.argv[r.argv.length - 1];
    expect(script).toContain('pg_terminate_backend');
    expect(script).toContain('DROP DATABASE IF EXISTS "shop"');
    expect(script).toContain('CREATE DATABASE "shop"');
    expect(script).toContain('-d shop < /tmp/rsclone.sql');
  });
  it('目标库等于源库、mongo 引擎：拒绝', () => {
    expect(() => relationalReplaceArgv(spec({ targetDb: 'shop_feat_x' }))).toThrow(/目标库不能等于源库/);
    expect(() => relationalReplaceArgv(spec({ engine: 'mongo' }))).toThrow(/mongo/);
  });
  it('还原脚本：gunzip 备份流进目标库，目标库先删后建', () => {
    const my = relationalRestoreScript('mysql', mysqlInfra, 'shop');
    expect(my.script).toContain('gunzip -c');
    expect(my.script).not.toMatch(/gunzip -c \|/);
    expect(my.script).toContain('set -e');
    expect(my.script).toContain('DROP DATABASE IF EXISTS `shop`');
    expect(my.script).toContain('mysql -uroot -h127.0.0.1 -P3306 shop');
    const pg = relationalRestoreScript('postgres', pgInfra, 'shop');
    expect(pg.script).toContain('pg_terminate_backend');
    expect(pg.script).not.toMatch(/gunzip -c \|/);
    expect(pg.script).toContain('psql -U app -h 127.0.0.1 -p 5432 -q -v ON_ERROR_STOP=1 -d shop');
  });
});

describe('接线守卫', () => {
  const read = (f: string): string => fs.readFileSync(path.join(CDS_ROOT, f), 'utf8');
  it('真实 ops 的替换与还原走管线脚本，不自己拼', () => {
    const s = read('src/services/db-ledger-ops.ts');
    expect(s).toContain('relationalReplaceArgv(');
    expect(s).toContain('relationalRestoreScript(');
  });
  it('前端台账的回写与回退打台账路由', () => {
    const s = read('web/src/components/branch/DbLedgerSection.tsx');
    expect(s).toContain('/write-back/preview');
    expect(s).toContain('/write-back`');
    expect(s).toContain('/rollback`');
  });
});
