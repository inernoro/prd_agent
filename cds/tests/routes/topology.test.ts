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
  it('GET /branches/:id/service-graph 分支不存在 404', async () => {
    const res = await request(server, 'GET', '/api/branches/nope/service-graph');
    expect(res.status).toBe(404);
  });
});
