/**
 * operator-console 人类鉴权回归 — 2026-05-29 Cursor Bugbot(High)+ Codex(P1×2):
 * operator console 能以 root 跑任意 shell、审批/拒绝请求。此前只靠顶层中间件放行
 * AI access key / 项目级 cdsp_ key,导致任何认证调用方都能自请求+自审批执行 root
 * shell,且能读 destructive op 的 confirmText。本测试锁死:run/ops/approve/reject/
 * requests 必须人类 cookie 鉴权(req._cdsCookieAuth===true),AI/项目 key 一律 403。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createOperatorConsoleRouter } from '../../src/routes/operator-console.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

async function request(
  server: http.Server, method: string, urlPath: string, body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('operator-console 人类鉴权门', () => {
  let tmpDir: string;
  let server: http.Server;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-opc-'));
    const stateService = new StateService(path.join(tmpDir, 'state.json'));
    const app = express();
    app.use(express.json());
    // 模拟 server.ts 顶层 auth:带 x-test-human:1 视为人类 cookie 登录
    app.use((req, _res, next) => {
      if (req.headers['x-test-human'] === '1') (req as any)._cdsCookieAuth = true;
      next();
    });
    app.use('/api', createOperatorConsoleRouter({
      stateService,
      shell: new MockShellExecutor() as any,
      repoRoot: tmpDir,
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const HUMAN = { 'x-test-human': '1' };

  it('非人类调用 POST /operator/run → 403(封死 AI/项目 key 跑 root shell)', async () => {
    const res = await request(server, 'POST', '/api/cds-system/operator/run', { opId: 'shell.run', args: { command: 'id' } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('human_auth_required');
  });

  it('非人类调用 GET /operator/ops → 403(不泄露 confirmText)', async () => {
    const res = await request(server, 'GET', '/api/cds-system/operator/ops');
    expect(res.status).toBe(403);
  });

  it('非人类调用 approve / reject → 403(封死自审自批)', async () => {
    const a = await request(server, 'POST', '/api/cds-system/operator/requests/x/approve', {});
    const r = await request(server, 'POST', '/api/cds-system/operator/requests/x/reject', {});
    expect(a.status).toBe(403);
    expect(r.status).toBe(403);
  });

  it('人类 cookie 调用 GET /operator/ops → 放行(200)', async () => {
    const res = await request(server, 'GET', '/api/cds-system/operator/ops', undefined, HUMAN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.ops)).toBe(true);
  });

  it('人类 cookie 调用 approve(请求不存在)→ 过了鉴权门,落到 404 而非 403', async () => {
    const res = await request(server, 'POST', '/api/cds-system/operator/requests/nope/approve', {}, HUMAN);
    expect(res.status).toBe(404);
  });

  it('AI 仍可发起待批请求 POST /operator/request(请求入口对 AI 开放)', async () => {
    const res = await request(server, 'POST', '/api/cds-system/operator/request', { opId: 'host.stats' });
    // 不是 403(鉴权门不拦 request);具体 200/202 由审批服务决定
    expect(res.status).not.toBe(403);
  });
});
