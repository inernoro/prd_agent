/**
 * GET /api/releases/targets/:id/changes 与四个写入口的留痕。
 *
 * 事故值：留痕只写在 PATCH 路由里。本文件刻意**不直接调 service 层**，而是走
 * 真实 HTTP 打四个入口中的三个（创建 / 归档 / 更新），任何一个入口把留痕漏掉
 * 或搬回路由内联实现，这里都会红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createReleasesRouter } from '../../src/routes/releases.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('发布目标变更历史', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  const createBody = {
    projectId: 'proj-a',
    id: 'tgt-prod',
    name: '官网',
    host: 'prod.example.test',
    port: 22,
    user: 'deploy',
    privateKeyRef: 'host-prod-key',
    appPath: '/opt/app',
    healthcheckUrl: 'https://prod.example.test/api/health',
    strategy: { mode: 'existing-script', command: './deploy.sh' },
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-rt-history-route-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
    stateService.addRemoteHost({
      id: 'host-prod-key',
      name: 'prod',
      host: 'prod.example.test',
      sshPort: 22,
      sshUser: 'deploy',
      sshPrivateKeyEncrypted: 'test-key',
      sshPrivateKeyFingerprint: 'ffffffffffffffff',
      isEnabled: true,
      createdAt: now,
      updatedAt: now,
    } as never);

    const app = express();
    app.use(express.json());
    // repoRoot 指到临时目录：历史台账落在 tmp 下，不污染仓库。
    app.use('/api', createReleasesRouter({
      stateService,
      config: { worktreeBase: path.join(tmpDir, 'wt'), repoRoot: tmpDir },
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('创建 → 改健康检查地址 → 归档，三步都留痕且能回答「谁什么时候改的」', async () => {
    const created = await request(server, 'POST', '/api/releases/targets', createBody);
    expect(created.status).toBe(201);

    const patched = await request(server, 'PATCH', '/api/releases/targets/tgt-prod', {
      healthcheckUrl: 'https://prod.example.test/healthz',
    });
    expect(patched.status).toBe(200);

    const archived = await request(server, 'POST', '/api/releases/targets/tgt-prod/archive', {
      reason: '站点迁移到新机房',
    });
    expect(archived.status).toBe(200);

    const res = await request(server, 'GET', '/api/releases/targets/tgt-prod/changes');
    expect(res.status).toBe(200);
    const kinds = res.body.changes.map((c: any) => c.kind);
    // 倒序：最新在前。
    expect(kinds).toEqual(['archived', 'updated', 'created']);

    const update = res.body.changes.find((c: any) => c.kind === 'updated');
    const healthcheck = update.changes.find((c: any) => c.path === 'ssh.healthcheckUrl');
    expect(healthcheck).toMatchObject({
      label: '健康检查地址',
      before: 'https://prod.example.test/api/health',
      after: 'https://prod.example.test/healthz',
    });
    // 「谁改的」必须是这次请求的操作者，不是首次创建者。
    expect(typeof update.actor).toBe('string');
    expect(update.at).toBeTruthy();

    const archiveEntry = res.body.changes.find((c: any) => c.kind === 'archived');
    expect(archiveEntry.reason).toBe('站点迁移到新机房');
  });

  it('历史里不出现服务器凭据原值', async () => {
    await request(server, 'POST', '/api/releases/targets', createBody);
    const res = await request(server, 'GET', '/api/releases/targets/tgt-prod/changes');
    expect(JSON.stringify(res.body)).not.toContain('host-prod-key');
  });

  it('本机生产创建这条入口同样留痕（不是只有 PATCH 记）', async () => {
    // 事故值：留痕内联在 PATCH 路由里时，这条入口创建的站点在历史里一片空白。
    const res = await request(server, 'POST', '/api/releases/targets/local-prod', {
      projectId: 'proj-a',
      id: 'tgt-local',
      domain: 'local.example.test',
      privateKeyRef: 'host-prod-key',
    });
    expect(res.status).toBe(201);

    const changes = await request(server, 'GET', '/api/releases/targets/tgt-local/changes');
    expect(changes.status).toBe(200);
    expect(changes.body.changes).toHaveLength(1);
    expect(changes.body.changes[0].kind).toBe('created');
  });

  it('不存在的目标返回 404，不泄露空历史', async () => {
    const res = await request(server, 'GET', '/api/releases/targets/nope/changes');
    expect(res.status).toBe(404);
  });
});
