/**
 * 波4 漂移巡检端点 —— POST /api/projects/:id/compose-drift-scan。
 *
 * 从项目 worktree 读 repo cds-compose.yml,与 CDS 配置树 diff,可选开
 * repo-sync PendingImport 走人审。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectComposeRouter } from '../../src/routes/project-compose.js';
import { StateService } from '../../src/services/state.js';

function request(server: http.Server, method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); }
          catch { resolve({ status: res.statusCode!, body: raw }); }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// repo 结构种子:声明一个 api profile + mongodb infra,x-cds-env 只有结构默认 +
// 一个仍未剥离的密钥(测 secretsInRepo)。
const REPO_COMPOSE = `
x-cds-project:
  name: "drift-sample"
x-cds-env:
  ASSETS_PROVIDER: tencentCos
  JWT_SECRET: "TODO: 请填写实际值"
services:
  api:
    image: node:20
    working_dir: /app
    ports:
      - "3000"
    command: npm run start:v2
  mongodb:
    image: mongo:7
    ports:
      - "27017"
`;

describe('compose-drift-scan 端点', () => {
  let tmpDir: string;
  let repoDir: string;
  let stateService: StateService;
  let server: http.Server;
  const projectId = 'proj1';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-drift-'));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-drift-repo-'));
    fs.writeFileSync(path.join(repoDir, 'cds-compose.yml'), REPO_COMPOSE, 'utf8');

    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({
      id: projectId,
      slug: 'drift-sample',
      name: 'Drift Sample',
      kind: 'git',
      cloneStatus: 'ready',
      repoPath: repoDir,
      createdAt: now,
      updatedAt: now,
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createProjectComposeRouter({
      stateService,
      assertProjectAccess: () => null,
      repoRootFallback: tmpDir,
    }));
    server = app.listen(0);
  });

  afterEach(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('空 CDS 侧 → 报结构漂移 + 密钥应剥离,不建单', async () => {
    const res = await request(server, 'POST', `/api/projects/${projectId}/compose-drift-scan`, {});
    expect(res.status).toBe(200);
    expect(res.body.report.hasRepoCompose).toBe(true);
    expect(res.body.report.syncRecommended).toBe(true);
    expect(res.body.report.secretsInRepo.map((s: any) => s.key)).toContain('JWT_SECRET');
    // 未要求建单 → createdImportId 为空
    expect(res.body.createdImportId).toBeNull();
    expect(stateService.getPendingImports().length).toBe(0);
  });

  it('createImport=true 且有结构漂移 → 开一条 repo-sync pending-import', async () => {
    const res = await request(server, 'POST', `/api/projects/${projectId}/compose-drift-scan`, { createImport: true });
    expect(res.status).toBe(200);
    expect(res.body.createdImportId).toBeTruthy();
    expect(res.body.approveUrl).toContain('pendingImport=');
    const pend = stateService.getPendingImports();
    expect(pend.length).toBe(1);
    expect(pend[0].agentName).toBe('repo-sync 漂移巡检');
    expect(pend[0].status).toBe('pending');
    expect(pend[0].composeYaml).toContain('x-cds-project');
  });

  it('重复扫描不重复建单(去重)', async () => {
    await request(server, 'POST', `/api/projects/${projectId}/compose-drift-scan`, { createImport: true });
    const res2 = await request(server, 'POST', `/api/projects/${projectId}/compose-drift-scan`, { createImport: true });
    expect(res2.status).toBe(200);
    expect(res2.body.createdImportId).toBeNull(); // 已有 pending 的 repo-sync 单
    expect(stateService.getPendingImports().filter((i) => i.status === 'pending').length).toBe(1);
  });

  it('无 repo cds-compose.yml → hasRepoCompose=false,不建单', async () => {
    fs.rmSync(path.join(repoDir, 'cds-compose.yml'));
    const res = await request(server, 'POST', `/api/projects/${projectId}/compose-drift-scan`, { createImport: true });
    expect(res.status).toBe(200);
    expect(res.body.report.hasRepoCompose).toBe(false);
    expect(res.body.createdImportId).toBeNull();
  });

  it('未知项目 → 404', async () => {
    const res = await request(server, 'POST', `/api/projects/nope/compose-drift-scan`, {});
    expect(res.status).toBe(404);
  });
});
