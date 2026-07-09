/**
 * 波5 无 Agent 接入 —— 已 clone 项目的事后栈检测(race-free)。
 *   GET  /api/projects/:id/detect-preview  只读扫已 clone 的 worktree
 *   POST /api/projects/:id/detect-apply    用户确认后建构建配置(幂等 / 空项目守门)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectsRouter } from '../../src/routes/projects.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { StateService } from '../../src/services/state.js';

function request(server: http.Server, method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method, headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => { try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); } catch { resolve({ status: res.statusCode!, body: raw }); } });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('波5 detect-preview / detect-apply', () => {
  let tmpDir: string;
  let repoDir: string;
  let stateService: StateService;
  let server: http.Server;
  const projectId = 'proj1';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-detect-'));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-detect-repo-'));
    // 一个可被 detectModules 识别的 Node 仓库
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'app', scripts: { start: 'node index.js' } }), 'utf8');
    fs.writeFileSync(path.join(repoDir, 'index.js'), 'console.log("hi")', 'utf8');

    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({
      id: projectId, slug: 'sample', name: 'Sample', kind: 'git', cloneStatus: 'ready', repoPath: repoDir, createdAt: now, updatedAt: now,
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createProjectsRouter({ stateService, shell: new MockShellExecutor() }));
    server = app.listen(0);
  });

  afterEach(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('detect-preview 只读扫 worktree,返回检测服务且不写状态', async () => {
    const res = await request(server, 'GET', `/api/projects/${projectId}/detect-preview`);
    expect(res.status).toBe(200);
    expect(res.body.hasProfiles).toBe(false);
    expect(Array.isArray(res.body.services)).toBe(true);
    expect(res.body.services.length).toBeGreaterThan(0);
    expect(res.body.services[0].runtime).toBe('node');
    // 只读:不应创建任何 profile
    expect(stateService.getBuildProfilesForProject(projectId).length).toBe(0);
  });

  it('detect-apply 用确认的服务建构建配置(幂等/空项目)', async () => {
    const preview = await request(server, 'GET', `/api/projects/${projectId}/detect-preview`);
    const svc = preview.body.services[0];
    const res = await request(server, 'POST', `/api/projects/${projectId}/detect-apply`, { services: [svc] });
    expect(res.status).toBe(201);
    expect(res.body.created.length).toBe(1);
    expect(stateService.getBuildProfilesForProject(projectId).length).toBe(1);
  });

  it('detect-apply 拒绝已有构建配置的项目(避免 ghost/重复)', async () => {
    const preview = await request(server, 'GET', `/api/projects/${projectId}/detect-preview`);
    await request(server, 'POST', `/api/projects/${projectId}/detect-apply`, { services: [preview.body.services[0]] });
    // 二次 apply 应被空项目守门拒绝
    const res2 = await request(server, 'POST', `/api/projects/${projectId}/detect-apply`, { services: [preview.body.services[0]] });
    expect(res2.status).toBe(409);
    expect(res2.body.error).toBe('profiles_exist');
    expect(stateService.getBuildProfilesForProject(projectId).length).toBe(1);
  });

  it('detect-apply 无可用 runtime → 400', async () => {
    const res = await request(server, 'POST', `/api/projects/${projectId}/detect-apply`, { services: [{ runtime: 'auto' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_applicable_services');
  });

  it('未知项目 → 404(两端点)', async () => {
    expect((await request(server, 'GET', `/api/projects/nope/detect-preview`)).status).toBe(404);
    expect((await request(server, 'POST', `/api/projects/nope/detect-apply`, { services: [] })).status).toBe(404);
  });

  it('detect-preview:仓库目录不存在 → 409 repo_not_ready', async () => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    const res = await request(server, 'GET', `/api/projects/${projectId}/detect-preview`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('repo_not_ready');
    // afterEach 再删一次 repoDir 会因不存在报错,提前建回空目录避免 afterEach 抛
    fs.mkdirSync(repoDir, { recursive: true });
  });
});
