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
  const cloneExec = async (argv: string[]) => {
    const sql = argv[argv.length - 1];
    if (argv[0] === 'run') { calls.push('clone'); return { code: 0, stdout: '', stderr: '' }; }
    if (/information_schema\.tables/.test(sql)) return { code: 0, stdout: 'users\n', stderr: '' };
    if (/COUNT\(\*\)/.test(sql)) return { code: 0, stdout: 'users\t3', stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
  };
  const ops: DbLedgerOps = {
    async dumpToFile(_e, _i, dbName, file) { calls.push(`dump:${dbName}`); fs.writeFileSync(file, Buffer.alloc(200, 1)); return { bytes: 200, sha256: 'abc' }; },
    async countObjects(_e, _i, dbName) { calls.push(`count:${dbName}`); return dbName.startsWith('cds_drill_') ? drillObjects : 12; },
    async restoreDrill(_e, _i, file, scratch) { calls.push(`drill:${path.basename(file)}->${scratch}`); return { objects: drillObjects }; },
    async dropDb(_e, _i, entry) { calls.push(`drop:${entry.dbName}`); if (dropFail) throw new Error('boom'); },
    async listDatabases() { calls.push('list'); return listed; },
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
    calls = []; listed = ['mysql', 'sys', 'information_schema', 'performance_schema', 'shop', 'shop_feat_x', 'shop_feat_x_rs_ab12cd_r1', 'shop_old', 'legacy_2024', 'cds_drill_deadbeef']; drillObjects = 12; dropFail = false;
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
});
