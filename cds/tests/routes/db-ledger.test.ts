/**
 * 数据台账路由（收敛 3）：备份 → 演练 → 丢弃 的门禁链，以及扫描补录、分支视图。
 * docker 全部走注入的桩 ops；文件真的落到临时目录（备份文件存在与否是演练的前置判据）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { assertProjectAccess } from '../../src/routes/projects.js';
import { createDbLedgerRouter } from '../../src/routes/db-ledger.js';
import type { DbLedgerOps } from '../../src/services/db-ledger.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { BranchEntry, BuildProfile, InfraService } from '../../src/types.js';

async function request(server: http.Server, method: string, urlPath: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({ hostname: '127.0.0.1', port: addr.port, path: urlPath, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(headers || {}) } }, (res) => {
      let raw = ''; res.on('data', (c: Buffer) => (raw += c.toString()));
      res.on('end', () => { try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); } catch { resolve({ status: res.statusCode!, body: raw }); } });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

const NOW = '2026-09-03T08:00:00.000Z';

describe('数据台账路由', () => {
  let tmpDir: string; let server: http.Server; let state: StateService;
  let calls: string[]; let listed: string[]; let drillObjects: number; let dropFail: boolean;
  let counts: Record<string, Record<string, number>>;
  let listedBy: Record<string, string[]>; let containers: string[]; let objectsBy: Record<string, number>;
  const cloneExec = async (argv: string[]) => {
    const sql = argv[argv.length - 1];
    if (argv[0] === 'run') { calls.push('clone'); return { code: 0, stdout: '', stderr: '' }; }
    if (/information_schema\.tables/.test(sql)) return { code: 0, stdout: 'users\n', stderr: '' };
    if (/COUNT\(\*\)/.test(sql)) return { code: 0, stdout: 'users\t3', stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
  };
  const ops: DbLedgerOps = {
    async tableCounts(_e, _i, dbName) { calls.push(`counts:${dbName}`); return { ...(counts[dbName] ?? {}) }; },
    async replaceDbFrom(_e, _i, sourceDb, targetDb, grantTo) { calls.push(`replace:${sourceDb}->${targetDb}${grantTo ? `@grant:${grantTo}` : ''}`); counts[targetDb] = { ...(counts[sourceDb] ?? {}) }; },
    async restoreInto(_e, _i, file, targetDb) { calls.push(`restore:${path.basename(file)}->${targetDb}`); counts[targetDb] = { ...(counts[`snapshot:${targetDb}`] ?? {}) }; },
    async dumpToFile(_e, infra, dbName, file) { calls.push(`dump:${dbName}`); containers.push(`dump@${infra.containerName}`); fs.writeFileSync(file, Buffer.alloc(200, 1)); return { bytes: 200, sha256: 'abc' }; },
    async countObjects(_e, infra, dbName) { calls.push(`count:${dbName}`); containers.push(`count@${infra.containerName}`); return dbName.startsWith('cds_drill_') ? drillObjects : (objectsBy[dbName] ?? 12); },
    async restoreDrill(_e, infra, file, scratch) { calls.push(`drill:${path.basename(file)}->${scratch}`); containers.push(`drill@${infra.containerName}`); return { objects: drillObjects }; },
    async dropDb(_e, _i, entry) { calls.push(`drop:${entry.dbName}`); if (dropFail) throw new Error('boom'); },
    async listDatabases(_e, infra) { calls.push('list'); return listedBy[infra.containerName] ?? listed; },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-db-ledger-'));
    state = new StateService(path.join(tmpDir, 'state.json'), tmpDir); state.load();
    state.addProject({ id: 'p', slug: 'p', name: 'P', kind: 'git', createdAt: NOW, updatedAt: NOW } as any);
    state.addProject({ id: 'q', slug: 'q', name: 'Q', kind: 'git', createdAt: NOW, updatedAt: NOW } as any);
    state.addBuildProfile({ id: 'api', projectId: 'p', name: 'API', dockerImage: 'node:20', workDir: '.', containerPort: 3000, dbScope: 'per-branch', env: { CDS_MYSQL_DATABASE: 'shop' } } as BuildProfile);
    state.addInfraService({ id: 'mysql', name: 'mysql', projectId: 'p', scope: 'project', dockerImage: 'mysql:8', containerName: 'cds-infra-mysql', hostPort: 0, containerPort: 3306, status: 'running', env: { MYSQL_ROOT_PASSWORD: 'rootpw' } } as unknown as InfraService);
    state.addBranch({ id: 'p-feat-x', projectId: 'p', branch: 'feat/x', worktreePath: path.join(tmpDir, 'wt'), status: 'running', createdAt: NOW, services: {},
      replicaDbSnapshots: [{ id: 'snap-1', profileId: 'api', memberId: 'r1', engine: 'mysql', sourceDb: 'shop_feat_x', dbName: 'shop_feat_x_rs_ab12cd_r1', infraContainer: 'cds-infra-mysql', clonedAt: NOW }],
    } as unknown as BranchEntry);
    // 孤儿：已删分支留下的独立库
    state.upsertDbLedgerEntry({ id: 'orphan-1', projectId: 'p', kind: 'per-branch', engine: 'mysql', dbName: 'shop_old', infraId: 'mysql', infraContainer: 'cds-infra-mysql', sourceDb: 'shop', branch: 'old', origin: 'cds', status: 'orphaned', orphanedAt: NOW, createdAt: NOW, updatedAt: NOW, backups: [] });
    state.save();
    counts = { shop: { users: 3, orders: 58 }, shop_feat_x: { users: 3, orders: 57 }, 'snapshot:shop': { users: 3, orders: 58 } };
    calls = []; containers = []; listedBy = {}; objectsBy = {}; listed = ['mysql', 'sys', 'information_schema', 'performance_schema', 'shop', 'shop_feat_x', 'shop_feat_x_rs_ab12cd_r1', 'shop_old', 'legacy_2024', 'cds_drill_deadbeef']; drillObjects = 12; dropFail = false;
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { const h = req.headers['x-test-key'] as string | undefined; if (h === 'KEY-Q') (req as any).cdsProjectKey = { projectId: 'q', keyId: 'k-q' }; next(); });
    process.env.CDS_BACKUP_DIR = path.join(tmpDir, 'backups');
    app.use('/api', createDbLedgerRouter({ stateService: state, assertProjectAccess: assertProjectAccess as any, ops, now: () => new Date(NOW), cloneExec }));
    server = app.listen(0);
  });
  afterEach(async () => { delete process.env.CDS_BACKUP_DIR; await flushAllJsonStateStores(); await new Promise<void>((r) => server.close(() => r())); fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it('GET 台账：隔离库快照、分支独立库、孤儿合成一棵树，每条能答从谁来', async () => {
    const res = await request(server, 'GET', '/api/projects/p/db-ledger');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.entries.map((e: any) => [e.dbName, e]));
    expect(byName.shop_feat_x).toMatchObject({ kind: 'per-branch', sourceDb: 'shop', branch: 'feat/x', status: 'active' });
    expect(byName.shop_feat_x_rs_ab12cd_r1).toMatchObject({ kind: 'isolated', sourceDb: 'shop_feat_x', snapshotId: 'snap-1', status: 'active' });
    expect(byName.shop_old).toMatchObject({ kind: 'per-branch', status: 'orphaned' });
    expect(res.body.summary).toMatchObject({ total: 3, active: 2, orphaned: 1, withoutBackup: 3 });
    expect(res.body.tree.map((n: any) => n.sourceDb)).toEqual(['shop', 'shop_feat_x']);
  });

  it('POST 分支时间点克隆：目标库不在实例上就克隆并写台账（含逐表校验）；已存在则不重复；空库方式不适用', async () => {
    const before = await request(server, 'POST', '/api/branches/p-feat-x/db-init/api');
    expect(before.status).toBe(200);
    expect(before.body.outcome.kind).toBe('not-applicable');
    expect(calls).toEqual([]);

    state.updateBuildProfile('api', { dbInit: 'clone' }); state.save();
    listed = listed.filter((d) => d !== 'shop_feat_x');
    const res = await request(server, 'POST', '/api/branches/p-feat-x/db-init/api');
    expect(res.status).toBe(200);
    expect(res.body.outcome).toMatchObject({ kind: 'cloned', dbName: 'shop_feat_x', sourceDb: 'shop', verification: { ok: true } });
    expect(res.body.message).toMatch(/时间点克隆到 shop_feat_x/);
    expect(res.body.lines.join('\n')).toMatch(/1 张表行数一致/);
    expect(calls.filter((c) => c === 'clone')).toEqual(['clone']);

    const ledger = await request(server, 'GET', '/api/branches/p-feat-x/db-ledger');
    const e = ledger.body.entries.find((x: any) => x.dbName === 'shop_feat_x');
    expect(e.clone).toMatchObject({ sourceDb: 'shop', verification: { ok: true, mismatched: [] } });
    expect(e.initMode).toBe('clone');
    expect(e.id.startsWith('live_')).toBe(false);

    listed.push('shop_feat_x');
    const again = await request(server, 'POST', '/api/branches/p-feat-x/db-init/api');
    expect(again.status).toBe(200);
    expect(again.body.outcome.kind).toBe('exists');
    expect(calls.filter((c) => c === 'clone')).toEqual(['clone']);

    const missing = await request(server, 'POST', '/api/branches/p-feat-x/db-init/nope');
    expect(missing.status).toBe(404);
  });

  it('项目 key 只能看自己的项目', async () => {
    const res = await request(server, 'GET', '/api/projects/p/db-ledger', undefined, { 'x-test-key': 'KEY-Q' });
    expect(res.status).toBe(403);
  });

  it('分支视图：列出将保留的派生库与提示', async () => {
    const res = await request(server, 'GET', '/api/branches/p-feat-x/db-ledger');
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: any) => e.dbName).sort()).toEqual(['shop_feat_x', 'shop_feat_x_rs_ab12cd_r1']);
    expect(res.body.hint).toContain('默认保留这 2 个派生库');
  });

  it('丢弃门禁：没有备份 → 409 并说缺备份；有备份没演练 → 409 说缺验证；演练后 → 放行并记台账', async () => {
    let r = await request(server, 'DELETE', '/api/projects/p/db-ledger/orphan-1');
    expect(r.status).toBe(409); expect(r.body.missing).toBe('backup'); expect(r.body.error).toContain('先备份');
    const b = await request(server, 'POST', '/api/projects/p/db-ledger/orphan-1/backup');
    expect(b.status).toBe(200);
    expect(fs.existsSync(b.body.backup.file)).toBe(true);
    expect(b.body.backup).toMatchObject({ bytes: 200, sha256: 'abc', objects: 12 });
    expect(b.body.message).toContain('演练验证一次后才算备份');
    r = await request(server, 'DELETE', '/api/projects/p/db-ledger/orphan-1');
    expect(r.status).toBe(409); expect(r.body.missing).toBe('verified-backup');
    const v = await request(server, 'POST', `/api/projects/p/db-ledger/orphan-1/backups/${b.body.backup.id}/verify`);
    expect(v.status).toBe(200);
    expect(v.body.backup.verifiedAt).toBe(NOW);
    expect(calls.find((c) => c.startsWith('drill:'))).toMatch(/->cds_drill_/);
    r = await request(server, 'DELETE', '/api/projects/p/db-ledger/orphan-1');
    expect(r.status).toBe(200);
    expect(r.body.entry).toMatchObject({ status: 'dropped', droppedForced: false, droppedAt: NOW });
    expect(calls).toContain('drop:shop_old');
    // 台账里留着可追溯
    const view = await request(server, 'GET', '/api/projects/p/db-ledger');
    expect(view.body.entries.find((e: any) => e.id === 'orphan-1').status).toBe('dropped');
  });

  it('演练对象数对不上 → 422，备份不算验证过', async () => {
    const b = await request(server, 'POST', '/api/projects/p/db-ledger/orphan-1/backup');
    drillObjects = 3;
    const v = await request(server, 'POST', `/api/projects/p/db-ledger/orphan-1/backups/${b.body.backup.id}/verify`);
    expect(v.status).toBe(422);
    expect(v.body.error).toContain('不一致');
    expect(v.body.entry.backups[0].verifiedAt).toBeUndefined();
  });

  it('强制丢弃：复述库名一字不差才放行，并标 forced', async () => {
    let r = await request(server, 'DELETE', '/api/projects/p/db-ledger/orphan-1', { force: { confirmDbName: 'shop' } });
    expect(r.status).toBe(409); expect(r.body.missing).toBe('confirm');
    r = await request(server, 'DELETE', '/api/projects/p/db-ledger/orphan-1', { force: { confirmDbName: 'shop_old' } });
    expect(r.status).toBe(200); expect(r.body.entry.droppedForced).toBe(true);
  });

  it('还属于在册分支的派生库不许直接丢：先删分支', async () => {
    const view = await request(server, 'GET', '/api/projects/p/db-ledger');
    const live = view.body.entries.find((e: any) => e.dbName === 'shop_feat_x');
    const r = await request(server, 'DELETE', `/api/projects/p/db-ledger/${live.id}`, { force: { confirmDbName: 'shop_feat_x' } });
    expect(r.status).toBe(409); expect(r.body.error).toContain('先删除该分支');
    expect(calls.some((c) => c.startsWith('drop:'))).toBe(false);
  });

  it('丢弃失败不改状态', async () => {
    dropFail = true;
    const r = await request(server, 'DELETE', '/api/projects/p/db-ledger/orphan-1', { force: { confirmDbName: 'shop_old' } });
    expect(r.status).toBe(500);
    expect(state.getDbLedgerEntry('orphan-1')!.status).toBe('orphaned');
  });

  it('扫描补录：实例上谁也不认识的库进台账标来源未知；系统库、源库、已知派生库、演练临时库不算', async () => {
    const r = await request(server, 'POST', '/api/projects/p/db-ledger/scan');
    expect(r.status).toBe(200);
    expect(r.body.added.map((e: any) => e.dbName)).toEqual(['legacy_2024']);
    expect(r.body.added[0]).toMatchObject({ kind: 'unknown', origin: 'scan', infraId: 'mysql' });
    expect(r.body.view.summary.unknown).toBe(1);
    // 再扫一次不重复
    const again = await request(server, 'POST', '/api/projects/p/db-ledger/scan');
    expect(again.body.added).toEqual([]);
  });

  it('扫描补录核实：记成已丢弃的库还在实例上 → 复活为活跃并注明（真实分支复验：删分支丢库后重建分支）', async () => {
    state.upsertDbLedgerEntry({ id: 'dbl_gone', projectId: 'p', kind: 'per-branch', engine: 'mysql', dbName: 'shop_feat_x', infraId: 'mysql', infraContainer: 'cds-infra-mysql', sourceDb: 'shop', branchId: 'p-feat-x', branch: 'feat/x', profileId: 'api', origin: 'cds', status: 'dropped', droppedAt: NOW, droppedBy: 'admin', droppedForced: true, createdAt: NOW, updatedAt: NOW, backups: [] });
    state.save();
    const res = await request(server, 'POST', '/api/projects/p/db-ledger/scan');
    expect(res.status).toBe(200);
    expect(res.body.revived.map((e: any) => e.dbName)).toEqual(['shop_feat_x']);
    const rec = state.getDbLedgerEntry('dbl_gone')!;
    expect(rec.status).toBe('active');
    expect(rec.droppedAt).toBeUndefined();
    expect(rec.note).toMatch(/复活/);
    // 丢弃后实例上真没有了的库不复活
    state.upsertDbLedgerEntry({ ...rec, id: 'dbl_really_gone', dbName: 'shop_feat_gone', status: 'dropped', droppedAt: NOW });
    state.save();
    const again = await request(server, 'POST', '/api/projects/p/db-ledger/scan');
    expect(again.body.revived).toEqual([]);
    expect(state.getDbLedgerEntry('dbl_really_gone')!.status).toBe('dropped');
  });

  it('扫描补录按实例分别判已知：同名库在另一台实例上是已知的，不能让这台实例上的存量库漏录（Codex P2）', async () => {
    state.addInfraService({ id: 'pg', name: 'pg', projectId: 'p', scope: 'project', dockerImage: 'postgres:16', containerName: 'cds-infra-pg', hostPort: 0, containerPort: 5432, status: 'running', env: { POSTGRES_PASSWORD: 'pgpw' } } as unknown as InfraService);
    state.save();
    listedBy = { 'cds-infra-pg': ['postgres', 'template0', 'shop', 'shop_old'] };
    const r = await request(server, 'POST', '/api/projects/p/db-ledger/scan');
    expect(r.status).toBe(200);
    const onPg = r.body.added.filter((e: any) => e.infraContainer === 'cds-infra-pg').map((e: any) => e.dbName).sort();
    expect(onPg).toEqual(['shop', 'shop_old']);
    // mysql 那台上的 shop（源库本体）与 shop_old（台账孤儿）仍不算未知
    expect(r.body.added.filter((e: any) => e.infraContainer === 'cds-infra-mysql').map((e: any) => e.dbName)).toEqual(['legacy_2024']);
  });

  it('专用隔离实例上的 mongo 隔离库：备份、数对象、演练都打到专用容器，不是源库所在的共享实例（Codex P1）', async () => {
    state.addInfraService({ id: 'mongo', name: 'mongo', projectId: 'p', scope: 'project', dockerImage: 'mongo:7.0', containerName: 'cds-infra-mongo', hostPort: 0, containerPort: 27017, status: 'running', env: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'mpw' } } as unknown as InfraService);
    state.addBranch({ id: 'p-feat-m', projectId: 'p', branch: 'feat/m', worktreePath: path.join(tmpDir, 'wt-m'), status: 'running', createdAt: NOW, services: {},
      replicaDbSnapshots: [{ id: 'snap-m', profileId: 'api', memberId: 'r1', engine: 'mongo', sourceDb: 'catalog', dbName: 'catalog_rs_ab12cd_r1', infraContainer: 'cds-infra-mongo', dedicatedContainer: 'cds-rsdb-abc123-catalog_rs_ab12cd_r1', dedicatedHostPort: 40001, dedicatedAuth: 'source-infra', clonedAt: NOW }],
    } as unknown as BranchEntry);
    state.save();
    const view = await request(server, 'GET', '/api/projects/p/db-ledger');
    const entry = view.body.entries.find((e: any) => e.dbName === 'catalog_rs_ab12cd_r1');
    const backup = await request(server, 'POST', `/api/projects/p/db-ledger/${entry.id}/backup`);
    expect(backup.status).toBe(200);
    const verify = await request(server, 'POST', `/api/projects/p/db-ledger/${backup.body.entry.id}/backups/${backup.body.backup.id}/verify`);
    expect(verify.status).toBe(200);
    expect(containers.filter((c) => c.endsWith('cds-infra-mongo'))).toEqual([]);
    expect(containers).toEqual(expect.arrayContaining(['dump@cds-rsdb-abc123-catalog_rs_ab12cd_r1', 'count@cds-rsdb-abc123-catalog_rs_ab12cd_r1', 'drill@cds-rsdb-abc123-catalog_rs_ab12cd_r1']));
  });

  it('postgres 孤儿库回写：项目里没有任何分支在用该服务时拒绝（DROP 后授权会丢，应用连不上）；有分支在用就从它解析授权对象（Codex P1）', async () => {
    // 项目 q 没有分支：孤儿库的应用用户无处可解析
    state.addInfraService({ id: 'qpg', name: 'pg', projectId: 'q', scope: 'project', dockerImage: 'postgres:16', containerName: 'cds-infra-qpg', hostPort: 0, containerPort: 5432, status: 'running', env: { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'pgpw' } } as unknown as InfraService);
    state.addBuildProfile({ id: 'qpgapi', projectId: 'q', name: 'PG API', dockerImage: 'node:20', workDir: '.', containerPort: 3001, dbScope: 'per-branch', env: { POSTGRES_DB: 'crm', DATABASE_URL: 'postgres://app:apppw@cds-infra-qpg:5432/crm' } } as BuildProfile);
    state.upsertDbLedgerEntry({ id: 'orphan-pg', projectId: 'q', kind: 'per-branch', engine: 'postgres', dbName: 'crm_old', infraId: 'qpg', infraContainer: 'cds-infra-qpg', sourceDb: 'crm', branchId: 'q-gone', branch: 'gone', profileId: 'qpgapi', origin: 'cds', status: 'orphaned', orphanedAt: NOW, createdAt: NOW, updatedAt: NOW, backups: [] });
    state.save();
    counts.crm = { users: 3 }; counts.crm_old = { users: 4 };
    const refused = await request(server, 'POST', '/api/projects/q/db-ledger/orphan-pg/write-back', { confirmDbName: 'crm' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/应用用户/);
    expect(calls.filter((c) => c.startsWith('replace:'))).toEqual([]);

    state.addBranch({ id: 'q-main', projectId: 'q', branch: 'main', worktreePath: path.join(tmpDir, 'wt-qmain'), status: 'running', createdAt: NOW, services: {} } as unknown as BranchEntry);
    state.save();
    const ok = await request(server, 'POST', '/api/projects/q/db-ledger/orphan-pg/write-back', { confirmDbName: 'crm' });
    expect(ok.status).toBe(200);
    expect(calls).toContain('replace:crm_old->crm@grant:app');
  });

  it('扫描补录条目的 id 带项目作用域：两个项目同名 infra id 同名库不互相覆盖（Codex P1）', async () => {
    const r = await request(server, 'POST', '/api/projects/p/db-ledger/scan');
    expect(r.body.added.map((e: any) => e.id)).toEqual(['dbl_scan_p_mysql_legacy_2024']);
    state.addInfraService({ id: 'qmysql', name: 'mysql', projectId: 'q', scope: 'project', dockerImage: 'mysql:8', containerName: 'cds-infra-qmysql', hostPort: 0, containerPort: 3306, status: 'running', env: { MYSQL_ROOT_PASSWORD: 'x' } } as unknown as InfraService);
    state.save();
    listedBy = { 'cds-infra-qmysql': ['mysql', 'legacy_2024'] };
    const q = await request(server, 'POST', '/api/projects/q/db-ledger/scan');
    expect(q.body.added.map((e: any) => e.id)).toEqual(['dbl_scan_q_qmysql_legacy_2024']);
    expect(state.getDbLedger('p').map((e) => e.id)).toContain('dbl_scan_p_mysql_legacy_2024');
  });

  it('同一秒内两次备份文件名不同，各自的记录各有各的文件（Codex P2）', async () => {
    const a = await request(server, 'POST', '/api/projects/p/db-ledger/orphan-1/backup');
    const b = await request(server, 'POST', '/api/projects/p/db-ledger/orphan-1/backup');
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.body.backup.file).not.toBe(b.body.backup.file);
    expect(b.body.entry.backups).toHaveLength(2);
  });

  it('备份运行时条目（还没有台账记录的隔离库）会先固化成台账记录', async () => {
    const view = await request(server, 'GET', '/api/projects/p/db-ledger');
    const iso = view.body.entries.find((e: any) => e.dbName === 'shop_feat_x_rs_ab12cd_r1');
    expect(iso.id.startsWith('live_')).toBe(true);
    const b = await request(server, 'POST', `/api/projects/p/db-ledger/${iso.id}/backup`);
    expect(b.status).toBe(200);
    expect(b.body.entry.id.startsWith('dbl_')).toBe(true);
    expect(b.body.entry.snapshotId).toBe('snap-1');
    const view2 = await request(server, 'GET', '/api/projects/p/db-ledger');
    const iso2 = view2.body.entries.filter((e: any) => e.dbName === 'shop_feat_x_rs_ab12cd_r1');
    expect(iso2).toHaveLength(1);
    expect(iso2[0].backups).toHaveLength(1);
  });

  describe('回写（收敛 5）：派生库整库写回源库，回写前自动备份并演练，冲突清单人工确认，可回退', () => {
    const live = 'live_db_p-feat-x_api';
    it('预览：目标库、两边逐表行数、冲突清单；没有克隆基线时按当前差异列出', async () => {
      const res = await request(server, 'GET', `/api/projects/p/db-ledger/${live}/write-back/preview`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ targetDb: 'shop', derivedDb: 'shop_feat_x', baselineKind: 'none' });
      expect(res.body.conflicts).toEqual([{ table: 'orders', parentNow: 58, derived: 57, reason: 'differs' }]);
      expect(res.body.tables).toEqual([{ table: 'orders', parent: 58, derived: 57 }, { table: 'users', parent: 3, derived: 3 }]);
      expect(res.body.headline).toContain('shop_feat_x');
    });
    it('执行：必须复述目标库名；演练不通过整个回写中止，目标库一个字节没动', async () => {
      const noConfirm = await request(server, 'POST', `/api/projects/p/db-ledger/${live}/write-back`, {});
      expect(noConfirm.status).toBe(400);
      const wrong = await request(server, 'POST', `/api/projects/p/db-ledger/${live}/write-back`, { confirmDbName: 'shop_feat_x' });
      expect(wrong.status).toBe(400);
      drillObjects = 3;
      const bad = await request(server, 'POST', `/api/projects/p/db-ledger/${live}/write-back`, { confirmDbName: 'shop' });
      expect(bad.status).toBe(422);
      expect(bad.body.error).toMatch(/演练/);
      expect(calls.some((c) => c.startsWith('replace:'))).toBe(false);
      expect(calls).toContain('dump:shop');
    });
    it('执行成功：备份 → 演练 → 替换 → 逐表校验 → 台账记回写与可回退快照；再回退还原目标库', async () => {
      const res = await request(server, 'POST', `/api/projects/p/db-ledger/${live}/write-back`, { confirmDbName: 'shop' });
      expect(res.status).toBe(200);
      expect(calls).toContain('dump:shop');
      expect(calls).toContain('replace:shop_feat_x->shop');
      expect(calls.indexOf('replace:shop_feat_x->shop')).toBeGreaterThan(calls.findIndex((c) => c.startsWith('drill:')));
      expect(res.body.record).toMatchObject({ targetDb: 'shop', conflicts: [{ table: 'orders' }], verification: { ok: true } });
      expect(res.body.record.snapshot.verifiedAt).toBeTruthy();
      expect(res.body.message).toMatch(/已回写/);
      const entry = state.getDbLedger('p').find((e) => e.dbName === 'shop_feat_x')!;
      expect(entry.writeBacks).toHaveLength(1);
      const wbId = entry.writeBacks![0].id;
      const view = await request(server, 'GET', '/api/projects/p/db-ledger');
      expect(view.body.entries.find((e: any) => e.dbName === 'shop_feat_x').writeBacks).toHaveLength(1);
      const noConfirm = await request(server, 'POST', `/api/projects/p/db-ledger/${entry.id}/write-backs/${wbId}/rollback`, {});
      expect(noConfirm.status).toBe(400);
      const rb = await request(server, 'POST', `/api/projects/p/db-ledger/${entry.id}/write-backs/${wbId}/rollback`, { confirmDbName: 'shop' });
      expect(rb.status).toBe(200);
      expect(calls.some((c) => c.startsWith('restore:') && c.endsWith('->shop'))).toBe(true);
      expect(rb.body.record.rolledBackAt).toBeTruthy();
      expect(rb.body.record.rollbackCheck.ok).toBe(true);
      expect(counts.shop).toEqual({ users: 3, orders: 58 });
      const again = await request(server, 'POST', `/api/projects/p/db-ledger/${entry.id}/write-backs/${wbId}/rollback`, { confirmDbName: 'shop' });
      expect(again.status).toBe(409);
    });
    it('回退后对象数对不上：不标已回退、返回 422，记录留着，修好后还能再回退（Codex P1）', async () => {
      const res = await request(server, 'POST', `/api/projects/p/db-ledger/${live}/write-back`, { confirmDbName: 'shop' });
      expect(res.status).toBe(200);
      const entry = state.getDbLedger('p').find((e) => e.dbName === 'shop_feat_x')!;
      const wbId = entry.writeBacks![0].id;
      // 回退前的备份演练照常通过（11 == 11），还原后量到 11 与回写前快照的 12 对不上
      objectsBy.shop = 11; drillObjects = 11;
      const bad = await request(server, 'POST', `/api/projects/p/db-ledger/${entry.id}/write-backs/${wbId}/rollback`, { confirmDbName: 'shop' });
      expect(bad.status).toBe(422);
      expect(bad.body.error).toMatch(/不一致/);
      const after = state.getDbLedgerEntry(entry.id)!.writeBacks![0];
      expect(after.rolledBackAt).toBeUndefined();
      expect(after.rollbackCheck).toMatchObject({ ok: false, objects: 11, expected: 12 });
      delete objectsBy.shop; drillObjects = 12;
      const good = await request(server, 'POST', `/api/projects/p/db-ledger/${entry.id}/write-backs/${wbId}/rollback`, { confirmDbName: 'shop' });
      expect(good.status).toBe(200);
      expect(good.body.record.rolledBackAt).toBeTruthy();
    });
    it('来源未知的扫描条目不能回写', async () => {
      const res = await request(server, 'GET', '/api/projects/p/db-ledger/dbl_scan_p_mysql_legacy_2024/write-back/preview');
      expect([404, 409]).toContain(res.status);
    });
  });
});
