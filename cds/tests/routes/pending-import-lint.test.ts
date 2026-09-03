/**
 * 导入审批的拓扑体检闸门（plan.cds.service-relations 第一批，已拍板：error 级阻断）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPendingImportRouter } from '../../src/routes/pending-import.js';
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

const BAD_YAML = `
services:
  admin:
    image: node:20
    working_dir: /app
    volumes:
      - ./admin:/app
    command: node server.js
    ports: ["3000"]
    labels:
      cds.path-prefix: "/"
      cds.readiness-path: "/"
  api-a:
    image: node:20
    working_dir: /app
    volumes:
      - ./a:/app
    command: node a.js
    ports: ["8080"]
    labels:
      cds.path-prefix: "/api/,/open/,/health"
  api-b:
    image: node:20
    working_dir: /app
    volumes:
      - ./b:/app
    command: node b.js
    ports: ["8081"]
    labels:
      cds.path-prefix: "/open/"
`;

const CALLS_YAML = `
services:
  web:
    image: node:20
    working_dir: /app
    volumes:
      - ./web:/app
    command: node web.js
    ports: ["3000"]
    labels:
      cds.path-prefix: "/"
      cds.readiness-path: "/"
      cds.calls: "api, worker"
  api:
    image: node:20
    working_dir: /app
    volumes:
      - ./api:/app
    command: node api.js
    ports: ["8080"]
    labels:
      cds.path-prefix: "/api/"
  worker:
    image: node:20
    working_dir: /app
    volumes:
      - ./worker:/app
    command: node worker.js
    ports: ["9000"]
    labels:
      cds.role: "worker"
`;

describe('pending-import 拓扑体检闸门', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pi-lint-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj1', slug: 'sample', name: 'Sample', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now });
    const app = express();
    app.use(express.json());
    app.use('/api', createPendingImportRouter({ stateService }));
    server = app.listen(0);
  });
  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('提交不拒绝但把体检挂在记录上；审批被 error 级阻断；force 放行', async () => {
    const create = await request(server, 'POST', '/api/projects/proj1/pending-import', { agentName: 'A', composeYaml: BAD_YAML });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const record = await request(server, 'GET', `/api/pending-imports/${create.body.importId}`);
    expect(record.body.import.lint.summary.errors).toBe(2);

    const blocked = await request(server, 'POST', `/api/pending-imports/${create.body.importId}/approve`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('topology_lint_blocked');
    expect(blocked.body.lint.findings.map((f: { rule: string }) => f.rule)).toEqual(expect.arrayContaining(['prefix-conflict', 'probe-in-prefix']));
    expect(stateService.getPendingImport(create.body.importId)?.status).toBe('pending');

    const forced = await request(server, 'POST', `/api/pending-imports/${create.body.importId}/approve`, { force: true });
    expect(forced.status).toBe(200);
  });

  it('审批给 profile id 加项目后缀时，cds.calls 指向的服务名跟着加后缀（边不落空）', async () => {
    const create = await request(server, 'POST', '/api/projects/proj1/pending-import', { agentName: 'A', composeYaml: CALLS_YAML });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const approved = await request(server, 'POST', `/api/pending-imports/${create.body.importId}/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(stateService.getBuildProfile('web-sample')?.calls).toEqual(['api-sample', 'worker-sample']);
    expect(stateService.getBuildProfile('api-sample')).toBeTruthy();
    expect(stateService.getBuildProfile('api')).toBeUndefined();
  });
});
