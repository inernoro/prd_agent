/**
 * 拓扑接口（plan.cds.service-relations 第一批）：
 *   POST /api/compose/lint 把 compose 交给唯一一份体检规则；
 *   GET /api/branches/:id/service-graph 给 cdscli topology 与画布同一份图。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTopologyRouter } from '../../src/routes/topology.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

function request(server: http.Server, method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({ hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } },
    (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => (raw += c.toString()));
      res.on('end', () => { try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); } catch { resolve({ status: res.statusCode!, body: raw }); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const CONFLICT_YAML = `
services:
  admin:
    build: ./admin
    ports: ["3000"]
    labels:
      cds.path-prefix: "/"
      cds.readiness-path: "/"
  api-a:
    build: ./a
    ports: ["8080"]
    labels:
      cds.path-prefix: "/api/,/open/,/health"
  api-b:
    build: ./b
    ports: ["8081"]
    labels:
      cds.path-prefix: "/open/"
`;

describe('topology router', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;
  let denyProject: string | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-topology-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const app = express();
    app.use(express.json());
    app.use('/api', createTopologyRouter({
      stateService,
      assertProjectAccess: (_req, projectId) => (denyProject === projectId ? { status: 403, body: { error: 'forbidden' } } : null),
    }));
    server = app.listen(0);
  });
  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('POST /compose/lint 报出前缀冲突与探活前缀（与服务层同一份规则）', async () => {
    const res = await request(server, 'POST', '/api/compose/lint', { composeYaml: CONFLICT_YAML });
    expect(res.status).toBe(200);
    expect(res.body.summary.errors).toBe(2);
    expect(res.body.findings.map((f: { rule: string }) => f.rule)).toEqual(expect.arrayContaining(['prefix-conflict', 'probe-in-prefix']));
  });
  it('POST /compose/lint 空 body 400，非 CDS compose 400，项目无权 403', async () => {
    expect((await request(server, 'POST', '/api/compose/lint', {})).status).toBe(400);
    expect((await request(server, 'POST', '/api/compose/lint', { composeYaml: 'hello: world' })).status).toBe(400);
    denyProject = 'p-x';
    expect((await request(server, 'POST', '/api/compose/lint', { composeYaml: CONFLICT_YAML, projectId: 'p-x' })).status).toBe(403);
    denyProject = null;
  });
  it('GET /branches/:id/route-lookup 给出转发器与 master 兜底的判定并标一致性', async () => {
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj', slug: 'demo', name: 'demo', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now } as Parameters<typeof stateService.addProject>[0]);
    for (const [id, prefixes] of [['admin', ['/']], ['api', ['/api/']]] as Array<[string, string[]]>) {
      stateService.addBuildProfile({ id, name: id, projectId: 'proj', dockerImage: 'node:20', workDir: '.', command: 'node s.js', containerPort: 3000, pathPrefixes: prefixes } as Parameters<typeof stateService.addBuildProfile>[0]);
    }
    stateService.addBranch({ id: 'proj-main', projectId: 'proj', branch: 'main', worktreePath: tmpDir, status: 'running', createdAt: now,
      services: { admin: { profileId: 'admin', containerName: 'c1', hostPort: 9101, status: 'running' }, api: { profileId: 'api', containerName: 'c2', hostPort: 9102, status: 'running' } } } as Parameters<typeof stateService.addBranch>[0]);
    const app = express();
    app.use(express.json());
    app.use('/api', createTopologyRouter({
      stateService,
      assertProjectAccess: () => null,
      getPublishedRoutes: () => [
        { _id: 'r1', host: 'main-demo.miduo.org', pathPrefix: '/', upstreamPort: 9101, weight: 100, branchId: 'proj-main', profileId: 'admin' },
        { _id: 'r2', host: 'main-demo.miduo.org', pathPrefix: '/api/', upstreamPort: 9102, weight: 100, branchId: 'proj-main', profileId: 'api' },
      ],
    }));
    const srv = app.listen(0);
    try {
      const res = await request(srv, 'GET', '/api/branches/proj-main/route-lookup?host=main-demo.miduo.org&path=/api/x');
      expect(res.status).toBe(200);
      expect(res.body.forwarder).toMatchObject({ routeId: 'r2', profileId: 'api', upstreamPort: 9102 });
      expect(res.body.masterFallback.profileId).toBe('api');
      expect(res.body.consistent).toBe(true);
      const miss = await request(srv, 'GET', '/api/branches/proj-main/route-lookup?host=other.miduo.org&path=/');
      expect(miss.body.forwarder).toBeNull();
      expect(miss.body.consistent).toBeNull();
      expect((await request(srv, 'GET', '/api/branches/proj-main/route-lookup?path=/')).status).toBe(400);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('GET /branches/:id/route-lookup 命名子域 host 由声明该子域的服务接管，不按主域名路径判定', async () => {
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj', slug: 'demo', name: 'demo', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now } as Parameters<typeof stateService.addProject>[0]);
    stateService.addBuildProfile({ id: 'admin', name: 'admin', projectId: 'proj', dockerImage: 'node:20', workDir: '.', command: 'node s.js', containerPort: 3000, pathPrefixes: ['/'] } as Parameters<typeof stateService.addBuildProfile>[0]);
    stateService.addBuildProfile({ id: 'llmgw', name: 'llmgw', projectId: 'proj', dockerImage: 'node:20', workDir: '.', command: 'node g.js', containerPort: 8091, subdomain: 'llmgw' } as Parameters<typeof stateService.addBuildProfile>[0]);
    stateService.addBranch({ id: 'proj-main', projectId: 'proj', branch: 'main', worktreePath: tmpDir, status: 'running', createdAt: now,
      services: { admin: { profileId: 'admin', containerName: 'c1', hostPort: 9101, status: 'running' }, llmgw: { profileId: 'llmgw', containerName: 'c3', hostPort: 9103, status: 'running' } } } as Parameters<typeof stateService.addBranch>[0]);
    const app = express();
    app.use(express.json());
    app.use('/api', createTopologyRouter({
      stateService,
      assertProjectAccess: () => null,
      envConfig: { jwtIssuer: 'cds', previewHost: 'miduo.org' },
      getPublishedRoutes: () => [
        { _id: 'r1', host: 'main-demo.miduo.org', pathPrefix: '/', upstreamPort: 9101, weight: 100, branchId: 'proj-main', profileId: 'admin' },
        { _id: 'r3', host: 'main-demo-llmgw.miduo.org', pathPrefix: '/', upstreamPort: 9103, weight: 100, branchId: 'proj-main', profileId: 'llmgw' },
      ],
    }));
    const srv = app.listen(0);
    try {
      const named = await request(srv, 'GET', '/api/branches/proj-main/route-lookup?host=main-demo-llmgw.miduo.org&path=/gw/v1/x');
      expect(named.status).toBe(200);
      expect(named.body.forwarder.profileId).toBe('llmgw');
      expect(named.body.masterFallback).toEqual({ profileId: 'llmgw', bySubdomain: true });
      expect(named.body.consistent).toBe(true);
      const main = await request(srv, 'GET', '/api/branches/proj-main/route-lookup?host=main-demo.miduo.org&path=/gw/v1/x');
      expect(main.body.masterFallback).toEqual({ profileId: 'admin', bySubdomain: false });
      expect(main.body.consistent).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('GET /branches/:id/references 抽出地址类键并解析引用；PUT 切换写入分支覆盖；service-graph 并入引用断裂', async () => {
    const now = new Date().toISOString();
    stateService.addProject({ id: 'p-prd', slug: 'prd-agent', name: 'MAP', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now, gitDefaultBranch: 'main' } as Parameters<typeof stateService.addProject>[0]);
    stateService.addProject({ id: 'p-md', slug: 'mdimp', name: 'mdimp', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now } as Parameters<typeof stateService.addProject>[0]);
    stateService.addBuildProfile({ id: 'llmgw-serve', name: 'llmgw', projectId: 'p-prd', dockerImage: 'node:20', workDir: '.', command: 'node s.js', containerPort: 8091, subdomain: 'llmgw' } as Parameters<typeof stateService.addBuildProfile>[0]);
    stateService.addBuildProfile({ id: 'cb-web', name: 'cb-web', projectId: 'p-md', dockerImage: 'node:20', workDir: '.', command: 'node w.js', containerPort: 3000, pathPrefixes: ['/'], env: { LLMGW_BASE: '${CDS_REF:prd-agent/llmgw-serve}', MAP_API_BASE: 'https://main-prd-agent.miduo.org', PLAIN: 'x' } } as Parameters<typeof stateService.addBuildProfile>[0]);
    stateService.addBranch({ id: 'prd-main', projectId: 'p-prd', branch: 'main', worktreePath: tmpDir, status: 'stopped', createdAt: now, services: { 'llmgw-serve': { profileId: 'llmgw-serve', containerName: 'c', hostPort: 1, status: 'stopped' } } } as Parameters<typeof stateService.addBranch>[0]);
    stateService.addBranch({ id: 'prd-feat', projectId: 'p-prd', branch: 'feat/x', worktreePath: tmpDir, status: 'running', createdAt: now, services: { 'llmgw-serve': { profileId: 'llmgw-serve', containerName: 'c', hostPort: 1, status: 'running' } } } as Parameters<typeof stateService.addBranch>[0]);
    stateService.addBranch({ id: 'md-main', projectId: 'p-md', branch: 'main', worktreePath: tmpDir, status: 'running', createdAt: now, services: { 'cb-web': { profileId: 'cb-web', containerName: 'c', hostPort: 2, status: 'running' } } } as Parameters<typeof stateService.addBranch>[0]);
    const app = express();
    app.use(express.json());
    app.use('/api', createTopologyRouter({ stateService, assertProjectAccess: () => null, envConfig: { jwtIssuer: 'cds', previewHost: 'miduo.org' } }));
    const srv = app.listen(0);
    try {
      const res = await request(srv, 'GET', '/api/branches/md-main/references');
      expect(res.status).toBe(200);
      const byKey = Object.fromEntries(res.body.references.map((r: { key: string }) => [r.key, r]));
      expect(byKey.LLMGW_BASE).toMatchObject({ kind: 'cds-ref', profileId: 'cb-web', source: 'platform-injected', detail: 'cds-ref' });
      expect(byKey.LLMGW_BASE.resolved[0]).toMatchObject({ status: 'stopped', target: { branchId: 'prd-main', isDefaultBranch: true } });
      expect(byKey.MAP_API_BASE).toMatchObject({ kind: 'url', matchedBranch: { branchId: 'prd-main' } });
      expect(byKey.PLAIN).toBeUndefined();
      expect(byKey.CDS_PREVIEW_URL?.kind).toBe('platform');
      expect(res.body.broken.map((f: { rule: string; severity: string }) => [f.rule, f.severity])).toEqual([['reference-broken', 'warn']]);

      const bad = await request(srv, 'PUT', '/api/branches/md-main/references/LLMGW_BASE', { profileId: 'cb-web', projectRef: 'prd-agent', serviceId: 'llmgw-serve', branchRef: 'gone' });
      expect(bad.status).toBe(409);
      const ok = await request(srv, 'PUT', '/api/branches/md-main/references/LLMGW_BASE', { profileId: 'cb-web', projectRef: 'prd-agent', serviceId: 'llmgw-serve', branchRef: 'feat/x' });
      expect(ok.status).toBe(200);
      expect(ok.body.value).toBe('${CDS_REF:prd-agent/llmgw-serve@feat/x}');
      expect(stateService.getBranch('md-main')?.profileOverrides?.['cb-web']?.env?.LLMGW_BASE).toBe('${CDS_REF:prd-agent/llmgw-serve@feat/x}');
      const after = await request(srv, 'GET', '/api/branches/md-main/references');
      const sw = after.body.references.find((r: { key: string }) => r.key === 'LLMGW_BASE');
      expect(sw.resolved[0]).toMatchObject({ status: 'running', target: { branchId: 'prd-feat' } });
      expect(after.body.broken).toEqual([]);

      const graph = await request(srv, 'GET', '/api/branches/md-main/service-graph');
      expect(graph.status).toBe(200);
      expect(graph.body.references.length).toBeGreaterThan(0);
      expect(graph.body.lint.findings.some((f: { rule: string }) => f.rule === 'reference-broken')).toBe(false);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('PUT /branches/:id/references/:key 只替换选中的引用 token，前后缀与其他引用原样保留；目标子域按分支覆盖解析', async () => {
    const now = new Date().toISOString();
    stateService.addProject({ id: 'p-prd', slug: 'prd-agent', name: 'MAP', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now, gitDefaultBranch: 'main' } as Parameters<typeof stateService.addProject>[0]);
    stateService.addProject({ id: 'p-md', slug: 'mdimp', name: 'mdimp', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now } as Parameters<typeof stateService.addProject>[0]);
    stateService.addBuildProfile({ id: 'llmgw-serve', name: 'llmgw', projectId: 'p-prd', dockerImage: 'node:20', workDir: '.', command: 'node s.js', containerPort: 8091, subdomain: 'llmgw' } as Parameters<typeof stateService.addBuildProfile>[0]);
    stateService.addBuildProfile({ id: 'cb-web', name: 'cb-web', projectId: 'p-md', dockerImage: 'node:20', workDir: '.', command: 'node w.js', containerPort: 3000, pathPrefixes: ['/'],
      env: { LLMGW_V1: '${CDS_REF:prd-agent/llmgw-serve}/v1', PAIR: '${CDS_REF:prd-agent/llmgw-serve}|${CDS_REF:prd-agent/llmgw-serve@feat/x}' } } as Parameters<typeof stateService.addBuildProfile>[0]);
    stateService.addBranch({ id: 'prd-main', projectId: 'p-prd', branch: 'main', worktreePath: tmpDir, status: 'running', createdAt: now, services: { 'llmgw-serve': { profileId: 'llmgw-serve', containerName: 'c', hostPort: 1, status: 'running' } } } as Parameters<typeof stateService.addBranch>[0]);
    stateService.addBranch({ id: 'prd-feat', projectId: 'p-prd', branch: 'feat/x', worktreePath: tmpDir, status: 'running', createdAt: now, services: { 'llmgw-serve': { profileId: 'llmgw-serve', containerName: 'c', hostPort: 1, status: 'running' } } } as Parameters<typeof stateService.addBranch>[0]);
    stateService.addBranch({ id: 'md-main', projectId: 'p-md', branch: 'main', worktreePath: tmpDir, status: 'running', createdAt: now, services: { 'cb-web': { profileId: 'cb-web', containerName: 'c', hostPort: 2, status: 'running' } } } as Parameters<typeof stateService.addBranch>[0]);
    // 目标分支 feat/x 用分支覆盖把子域改成 gw2：入口表与选 URL 必须都看覆盖后的值
    stateService.setBranchProfileOverride('prd-feat', 'llmgw-serve', { subdomain: 'gw2' });
    const app = express();
    app.use(express.json());
    app.use('/api', createTopologyRouter({ stateService, assertProjectAccess: () => null, envConfig: { jwtIssuer: 'cds', previewHost: 'miduo.org' } }));
    const srv = app.listen(0);
    try {
      const embedded = await request(srv, 'PUT', '/api/branches/md-main/references/LLMGW_V1', { profileId: 'cb-web', projectRef: 'prd-agent', serviceId: 'llmgw-serve', branchRef: 'feat/x' });
      expect(embedded.status, JSON.stringify(embedded.body)).toBe(200);
      expect(embedded.body.value).toBe('${CDS_REF:prd-agent/llmgw-serve@feat/x}/v1');
      expect(embedded.body.resolved.url).toContain('-gw2.');
      expect(stateService.getBranch('md-main')?.profileOverrides?.['cb-web']?.env?.LLMGW_V1).toBe('${CDS_REF:prd-agent/llmgw-serve@feat/x}/v1');

      const ambiguous = await request(srv, 'PUT', '/api/branches/md-main/references/PAIR', { profileId: 'cb-web', projectRef: 'prd-agent', serviceId: 'llmgw-serve', branchRef: 'feat/x' });
      expect(ambiguous.status).toBe(409);
      expect(ambiguous.body.error).toBe('reference_ambiguous');
      const picked = await request(srv, 'PUT', '/api/branches/md-main/references/PAIR', { profileId: 'cb-web', projectRef: 'prd-agent', serviceId: 'llmgw-serve', branchRef: 'main', raw: '${CDS_REF:prd-agent/llmgw-serve@feat/x}' });
      expect(picked.status).toBe(200);
      expect(picked.body.value).toBe('${CDS_REF:prd-agent/llmgw-serve}|${CDS_REF:prd-agent/llmgw-serve@main}');
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('GET /overview/topology 项目配置的默认分支是 CDS 分支 id 时也能认出代表分支', async () => {
    const now = new Date().toISOString();
    stateService.addProject({ id: 'p-md', slug: 'mdimp', name: 'mdimp', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now, defaultBranch: 'md-feat' } as Parameters<typeof stateService.addProject>[0]);
    stateService.addBuildProfile({ id: 'cb-web', name: 'cb-web', projectId: 'p-md', dockerImage: 'node:20', workDir: '.', command: 'node w.js', containerPort: 3000, pathPrefixes: ['/'] } as Parameters<typeof stateService.addBuildProfile>[0]);
    stateService.addBranch({ id: 'md-main', projectId: 'p-md', branch: 'main', worktreePath: tmpDir, status: 'running', createdAt: now, lastDeployAt: '2026-09-02T10:00:00Z', services: { 'cb-web': { profileId: 'cb-web', containerName: 'c', hostPort: 2, status: 'running' } } } as Parameters<typeof stateService.addBranch>[0]);
    stateService.addBranch({ id: 'md-feat', projectId: 'p-md', branch: 'feature/y', worktreePath: tmpDir, status: 'running', createdAt: now, lastDeployAt: '2026-09-01T10:00:00Z', services: { 'cb-web': { profileId: 'cb-web', containerName: 'c', hostPort: 3, status: 'running' } } } as Parameters<typeof stateService.addBranch>[0]);
    const res = await request(server, 'GET', '/api/overview/topology');
    expect(res.status).toBe(200);
    expect(res.body.projects[0].branch).toMatchObject({ id: 'md-feat', name: 'feature/y' });
  });

  it('目标项目对当前凭据不可见时：引用读成 restricted 不下发地址与分支，PUT 指向它被拒，概览不画到它的边', async () => {
    const now = new Date().toISOString();
    stateService.addProject({ id: 'p-prd', slug: 'prd-agent', name: 'MAP', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now, gitDefaultBranch: 'main' } as Parameters<typeof stateService.addProject>[0]);
    stateService.addProject({ id: 'p-md', slug: 'mdimp', name: 'mdimp', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now } as Parameters<typeof stateService.addProject>[0]);
    stateService.addBuildProfile({ id: 'llmgw-serve', name: 'llmgw', projectId: 'p-prd', dockerImage: 'node:20', workDir: '.', command: 'node s.js', containerPort: 8091, subdomain: 'llmgw' } as Parameters<typeof stateService.addBuildProfile>[0]);
    stateService.addBuildProfile({ id: 'cb-web', name: 'cb-web', projectId: 'p-md', dockerImage: 'node:20', workDir: '.', command: 'node w.js', containerPort: 3000, pathPrefixes: ['/'], env: { LLMGW_BASE: '${CDS_REF:prd-agent/llmgw-serve}', MAP_API_BASE: 'https://main-prd-agent.miduo.org' } } as Parameters<typeof stateService.addBuildProfile>[0]);
    stateService.addBranch({ id: 'prd-main', projectId: 'p-prd', branch: 'main', worktreePath: tmpDir, status: 'running', createdAt: now, services: { 'llmgw-serve': { profileId: 'llmgw-serve', containerName: 'c', hostPort: 1, status: 'running' } } } as Parameters<typeof stateService.addBranch>[0]);
    stateService.addBranch({ id: 'md-main', projectId: 'p-md', branch: 'main', worktreePath: tmpDir, status: 'running', createdAt: now, services: { 'cb-web': { profileId: 'cb-web', containerName: 'c', hostPort: 2, status: 'running' } } } as Parameters<typeof stateService.addBranch>[0]);
    const app = express();
    app.use(express.json());
    // 模拟只对 mdimp 项目授权的项目级凭据
    app.use('/api', createTopologyRouter({ stateService, assertProjectAccess: (_r, pid) => (pid === 'p-md' ? null : { status: 403, body: { error: 'forbidden' } }), envConfig: { jwtIssuer: 'cds', previewHost: 'miduo.org' } }));
    const srv = app.listen(0);
    try {
      const refs = await request(srv, 'GET', '/api/branches/md-main/references');
      expect(refs.status).toBe(200);
      const byKey = Object.fromEntries(refs.body.references.map((r: { key: string }) => [r.key, r]));
      expect(byKey.LLMGW_BASE.resolved[0]).toEqual({ ref: byKey.LLMGW_BASE.resolved[0].ref, url: null, status: 'restricted', target: { serviceId: 'llmgw-serve' }, reason: '当前凭据无权查看目标项目' });
      expect(JSON.stringify(refs.body)).not.toContain('prd-main');
      expect(byKey.MAP_API_BASE.matchedBranch).toBeNull();
      expect(byKey.MAP_API_BASE.suggestion).toBeUndefined();
      expect(refs.body.broken.map((f: { severity: string }) => f.severity)).toEqual(['warn']);

      const put = await request(srv, 'PUT', '/api/branches/md-main/references/LLMGW_BASE', { profileId: 'cb-web', projectRef: 'prd-agent', serviceId: 'llmgw-serve', branchRef: 'main' });
      expect(put.status).toBe(403);
      expect(stateService.getBranch('md-main')?.profileOverrides?.['cb-web']?.env?.LLMGW_BASE).toBeUndefined();

      const graph = await request(srv, 'GET', '/api/branches/md-main/service-graph');
      expect(JSON.stringify(graph.body)).not.toContain('prd-main');

      const overview = await request(srv, 'GET', '/api/overview/topology');
      expect(overview.body.projects.map((p: { slug: string }) => p.slug)).toEqual(['mdimp']);
      expect(overview.body.projects[0].edges).toEqual([]);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('GET /overview/topology 每个项目给代表分支、体检结论与跨项目引用边', async () => {
    const now = new Date().toISOString();
    stateService.addProject({ id: 'p-prd', slug: 'prd-agent', name: 'MAP', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now, gitDefaultBranch: 'main' } as Parameters<typeof stateService.addProject>[0]);
    stateService.addProject({ id: 'p-md', slug: 'mdimp', name: 'mdimp', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now } as Parameters<typeof stateService.addProject>[0]);
    stateService.addProject({ id: 'p-empty', slug: 'empty', name: 'empty', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now } as Parameters<typeof stateService.addProject>[0]);
    stateService.addBuildProfile({ id: 'llmgw-serve', name: 'llmgw', projectId: 'p-prd', dockerImage: 'node:20', workDir: '.', command: 'node s.js', containerPort: 8091, subdomain: 'llmgw' } as Parameters<typeof stateService.addBuildProfile>[0]);
    stateService.addBuildProfile({ id: 'cb-web', name: 'cb-web', projectId: 'p-md', dockerImage: 'node:20', workDir: '.', command: 'node w.js', containerPort: 3000, pathPrefixes: ['/'], env: { LLMGW_BASE: '${CDS_REF:prd-agent/llmgw-serve}' } } as Parameters<typeof stateService.addBuildProfile>[0]);
    stateService.addBranch({ id: 'prd-main', projectId: 'p-prd', branch: 'main', worktreePath: tmpDir, status: 'stopped', createdAt: now, services: { 'llmgw-serve': { profileId: 'llmgw-serve', containerName: 'c', hostPort: 1, status: 'stopped' } } } as Parameters<typeof stateService.addBranch>[0]);
    stateService.addBranch({ id: 'md-main', projectId: 'p-md', branch: 'main', worktreePath: tmpDir, status: 'running', createdAt: now, services: { 'cb-web': { profileId: 'cb-web', containerName: 'c', hostPort: 2, status: 'running' } } } as Parameters<typeof stateService.addBranch>[0]);
    const app = express();
    app.use(express.json());
    app.use('/api', createTopologyRouter({ stateService, assertProjectAccess: (_r, pid) => (pid === 'p-empty' ? { status: 403, body: { error: 'forbidden' } } : null), envConfig: { jwtIssuer: 'cds', previewHost: 'miduo.org' } }));
    const srv = app.listen(0);
    try {
      const res = await request(srv, 'GET', '/api/overview/topology');
      expect(res.status).toBe(200);
      expect(res.body.projects.map((p: { slug: string }) => p.slug).sort()).toEqual(['mdimp', 'prd-agent']);
      const md = res.body.projects.find((p: { slug: string }) => p.slug === 'mdimp');
      expect(md.branch).toMatchObject({ id: 'md-main', name: 'main' });
      expect(md.edges).toEqual([expect.objectContaining({ toProjectId: 'p-prd', kind: 'cds-ref', status: 'stopped', fromService: 'cb-web', key: 'LLMGW_BASE' })]);
      expect(md.lint.warnings).toBeGreaterThanOrEqual(1);
      expect(md.headline).toContain('LLMGW_BASE');
      const prd = res.body.projects.find((p: { slug: string }) => p.slug === 'prd-agent');
      expect(prd.inboundEdges).toBe(1);
      expect(res.body.summary.warnings).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('GET /branches/:id/service-graph 按分支覆盖后的 profile 构图（与转发路由同一口径）', async () => {
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj', slug: 'demo', name: 'demo', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now } as Parameters<typeof stateService.addProject>[0]);
    for (const [id, prefixes] of [['admin', ['/']], ['api', ['/api/']]] as Array<[string, string[]]>) {
      stateService.addBuildProfile({ id, name: id, projectId: 'proj', dockerImage: 'node:20', workDir: '.', command: 'node s.js', containerPort: 3000, pathPrefixes: prefixes } as Parameters<typeof stateService.addBuildProfile>[0]);
    }
    stateService.addBranch({ id: 'proj-main', projectId: 'proj', branch: 'main', worktreePath: tmpDir, status: 'running', createdAt: now,
      services: { admin: { profileId: 'admin', containerName: 'c1', hostPort: 9101, status: 'running' }, api: { profileId: 'api', containerName: 'c2', hostPort: 9102, status: 'running' } } } as Parameters<typeof stateService.addBranch>[0]);
    const clean = await request(server, 'GET', '/api/branches/proj-main/service-graph');
    expect(clean.status).toBe(200);
    expect(clean.body.lint.findings.map((f: { rule: string }) => f.rule)).not.toContain('prefix-conflict');
    // 分支级把 api 的前缀改成 `/`：运行中的转发路由就是这么发布的，图与体检必须跟着看到冲突
    stateService.setBranchProfileOverride('proj-main', 'api', { pathPrefixes: ['/'] });
    const overridden = await request(server, 'GET', '/api/branches/proj-main/service-graph');
    expect(overridden.status).toBe(200);
    expect(overridden.body.lint.findings.map((f: { rule: string }) => f.rule)).toContain('prefix-conflict');
    expect(overridden.body.graph.sites[0].conflicts.map((c: { prefix: string }) => c.prefix)).toContain('/');
  });

  it('GET /branches/:id/service-graph 分支不存在 404', async () => {
    const res = await request(server, 'GET', '/api/branches/nope/service-graph');
    expect(res.status).toBe(404);
  });
});
