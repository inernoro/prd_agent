import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCdsSystemDiagnosticsRouter } from '../../src/routes/cds-system-diagnostics.js';

async function call(server: http.Server, method: string, urlPath: string, headers: Record<string, string> = {}) {
  const port = (server.address() as { port: number }).port;
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: raw ? JSON.parse(raw) : {} }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('主线程诊断路由', () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    // 测试用身份戳：模拟全局 auth 之后挂在 req 上的字段
    app.use((req, _res, next) => {
      if (req.headers['x-test-project-key']) {
        (req as unknown as { cdsProjectKey: { projectId: string; keyId: string } }).cdsProjectKey = { projectId: 'mdimp', keyId: 'k1' };
      }
      if (req.headers['x-test-member']) {
        Object.assign(req, { cdsUser: { id: 'u1', isSystemOwner: false, username: 'member' }, cdsSession: { id: 's1' } });
      }
      next();
    });
    app.use('/api', createCdsSystemDiagnosticsRouter());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('系统级调用方拿到事件循环、主线程画像、进程与宿主信息', async () => {
    const res = await call(server, 'GET', '/api/cds-system/diagnostics/main-thread');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('eventLoop');
    expect(res.body).toHaveProperty('mainThread.current.sections');
    expect(res.body).toHaveProperty('mainThread.stalls');
    expect(res.body).toHaveProperty('mainThread.sseOpen');
    expect(res.body).toHaveProperty('process.rssMB');
    expect(res.body).toHaveProperty('host.cores');
    expect(res.body.cpuProfileInFlight).toBe(false);
  });

  it('项目级 Key 不能读也不能采样', async () => {
    const get = await call(server, 'GET', '/api/cds-system/diagnostics/main-thread', { 'x-test-project-key': '1' });
    expect(get.status).toBe(403);
    expect(get.body.error).toBe('system_scope_required');
    const post = await call(server, 'POST', '/api/cds-system/diagnostics/cpu-profile?seconds=5', { 'x-test-project-key': '1' });
    expect(post.status).toBe(403);
  });

  it('只有项目授权的成员账号被拒绝', async () => {
    const res = await call(server, 'GET', '/api/cds-system/diagnostics/main-thread', { 'x-test-member': '1' });
    expect(res.status).toBe(403);
  });
});

/**
 * 接线守卫（判据与接线纪律 · 形状 2）：埋点删掉不会让任何功能测试变红，
 * 只会让诊断接口静默少一项数据。这里逐个钉住「哪个文件必须报哪个分段」。
 */
describe('主线程诊断接线', () => {
  const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../src', rel), 'utf8');

  const wiring: Array<[string, string[]]> = [
    ['infra/state-store/mongo-split-store.ts', [
      "'state.snapshot.full-clone'",
      "'state.snapshot.partial-clone'",
      '`state.persist.serialize.${input.label}`',
      "'state.persist.serialize.global'",
    ]],
    ['infra/state-store/json-backing-store.ts', ["'state.persist.serialize.json-file'"]],
    ['infra/state-store/mongo-backing-store.ts', ["'state.snapshot.sanitize'"]],
    ['routes/branches.ts', [
      "'api.branches.compute'",
      "'api.branches.serialize'",
      "'api.branches.widget-serialize'",
      "'sse.branches.snapshot.project'",
      "'sse.branches.snapshot.all'",
      "'sse.branches.event'",
    ]],
    ['services/uptime-monitor.ts', ["'uptime.persist'"]],
    ['services/release-commit-rail.ts', ["'git.sync.release-rail'"]],
    ['index.ts', ["'git.sync.stuck-deploy-diff'", 'startMainThreadDiagnostics();']],
    ['server.ts', [
      "'sse.state.broadcast'",
      'app.use(sseConnectionTrackerMiddleware);',
      "app.use('/api', createCdsSystemDiagnosticsRouter());",
      "'GET /cds-system/diagnostics/main-thread'",
      "'POST /cds-system/diagnostics/cpu-profile'",
    ]],
  ];

  it.each(wiring)('%s 接上了诊断埋点', (file, needles) => {
    const text = src(file);
    for (const needle of needles) expect(text, `${file} 缺少 ${needle}`).toContain(needle);
  });

  it('syncCollection 的每个调用方都带了分段名', () => {
    const text = src('infra/state-store/mongo-split-store.ts');
    const calls = text.split('await this.syncCollection({').length - 1;
    const labelled = (text.match(/await this\.syncCollection\(\{\n\s+label: '/g) || []).length;
    expect(calls).toBeGreaterThan(0);
    expect(labelled).toBe(calls);
  });
});
