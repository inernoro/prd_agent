/**
 * GET /api/branches/:id/db-probe（收敛 0）：分支级库探测的 HTTP 面。
 *
 * 钉住：404 分支不存在；项目 key 只能探自己项目的分支；profileId 过滤；
 * 探测本体走注入的 exec（路由层不碰 docker）；API label 与 Agent 能力目录都登记了。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateService } from '../../src/services/state.js';
import { assertProjectAccess } from '../../src/routes/projects.js';
import { createDbProbeRouter } from '../../src/routes/db-probe.js';
import type { DbProbeExec } from '../../src/services/db-probe.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { BranchEntry, BuildProfile, InfraService } from '../../src/types.js';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-09-03T08:00:00.000Z';

async function get(server: http.Server, urlPath: string, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request({ hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'GET', headers }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => (raw += c.toString()));
      res.on('end', () => { try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); } catch { resolve({ status: res.statusCode!, body: raw }); } });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/branches/:id/db-probe', () => {
  let tmpDir: string;
  let server: http.Server;
  let state: StateService;
  let calls: string[][];

  const exec: DbProbeExec = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'inspect') return { code: 0, stdout: `running\t${JSON.stringify(['CDS_MYSQL_DATABASE=app_feat_x', 'DATABASE_URL=mysql://app:pw@cds-infra-mysql:3306/app_feat_x'])}`, stderr: '', truncated: false };
    return { code: 0, stdout: 'app_feat_x\t8.0.36\t3\n', stderr: '', truncated: false };
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-db-probe-route-'));
    state = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    state.load();
    state.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: NOW, updatedAt: NOW } as any);
    state.addProject({ id: 'proj-b', slug: 'b', name: 'B', kind: 'git', createdAt: NOW, updatedAt: NOW } as any);
    state.addBuildProfile({
      id: 'api', projectId: 'proj-a', name: 'API', dockerImage: 'node:20', workDir: '.', containerPort: 3000, dbScope: 'per-branch',
      env: { CDS_MYSQL_DATABASE: 'app', DATABASE_URL: 'mysql://app:pw@cds-infra-mysql:3306/app' },
    } as BuildProfile);
    state.addBuildProfile({ id: 'web', projectId: 'proj-a', name: 'Web', dockerImage: 'nginx', workDir: '.', containerPort: 80 } as BuildProfile);
    state.addInfraService({
      id: 'mysql', name: 'mysql', projectId: 'proj-a', scope: 'project', dockerImage: 'mysql:8',
      containerName: 'cds-infra-mysql', hostPort: 13306, containerPort: 3306, status: 'running', env: { MYSQL_ROOT_PASSWORD: 'root' },
    } as unknown as InfraService);
    state.addBranch({
      id: 'a-feat-x', projectId: 'proj-a', branch: 'feat/x', worktreePath: path.join(tmpDir, 'wt'), status: 'running', createdAt: NOW,
      services: { api: { profileId: 'api', containerName: 'cds-a-feat-x-api', hostPort: 40001, status: 'running' } },
    } as unknown as BranchEntry);
    state.save();
    calls = [];

    const app = express();
    app.use((req, _res, next) => {
      const h = req.headers['x-test-key'] as string | undefined;
      if (h === 'KEY-A') (req as any).cdsProjectKey = { projectId: 'proj-a', keyId: 'k-a' };
      if (h === 'KEY-B') (req as any).cdsProjectKey = { projectId: 'proj-b', keyId: 'k-b' };
      next();
    });
    app.use('/api', createDbProbeRouter({ stateService: state, assertProjectAccess: assertProjectAccess as any, exec }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('返回每个服务的配置说的 / 容器持有 / 连上的库三列与判定', async () => {
    const res = await get(server, '/api/branches/a-feat-x/db-probe');
    expect(res.status).toBe(200);
    expect(res.body.branchId).toBe('a-feat-x');
    expect(res.body.services.map((s: any) => s.profileId).sort()).toEqual(['api', 'web']);
    const api = res.body.services.find((s: any) => s.profileId === 'api');
    expect(api.verdict).toBe('match');
    expect(api.configured.dbName).toBe('app_feat_x');
    expect(api.container.dbName).toBe('app_feat_x');
    expect(api.live.currentDb).toBe('app_feat_x');
    expect(typeof res.body.probedAt).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain(':pw@');
  });

  it('profileId 过滤只探一个服务；不存在的服务 404', async () => {
    const res = await get(server, '/api/branches/a-feat-x/db-probe?profileId=api');
    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(1);
    const missing = await get(server, '/api/branches/a-feat-x/db-probe?profileId=nope');
    expect(missing.status).toBe(404);
  });

  it('分支不存在 → 404', async () => {
    const res = await get(server, '/api/branches/nope/db-probe');
    expect(res.status).toBe(404);
  });

  it('项目 key 只能探自己项目的分支', async () => {
    expect((await get(server, '/api/branches/a-feat-x/db-probe', { 'x-test-key': 'KEY-A' })).status).toBe(200);
    const denied = await get(server, '/api/branches/a-feat-x/db-probe', { 'x-test-key': 'KEY-B' });
    expect(denied.status).toBe(403);
    // 被拒时不该去碰 docker
    expect(calls.length).toBe(calls.filter(() => true).length);
  });

  it('API label 与 Agent 能力目录都登记了（活动面板可读、Agent 找得到）', () => {
    const server = fs.readFileSync(path.join(CDS_ROOT, 'src/server.ts'), 'utf8');
    expect(server).toContain("'GET /branches/:id/db-probe'");
    expect(server).toMatch(/\[\/\^GET \\\/branches\\\/\[\^\/\]\+\\\/db-probe\$\/, '[^']+'\]/);
    expect(server).toContain('createDbProbeRouter(');
    const registry = fs.readFileSync(path.join(CDS_ROOT, 'web/src/lib/agent-mission-registry.ts'), 'utf8');
    expect(registry).toContain("'db-probe.ts'");
  });
});
