/**
 * /api/notices 的项目作用域收窄。
 *
 * 事故值：一把项目级 Key（cdsp_ / 单项目 cdsg_）如果能读到全量站内信，就等于能枚举
 * 出全实例每个项目的项目名、发布目标名与故障原因——Codex 在 PR #1273 P1 已经为
 * uptime summary 抓过同款。系统级条目（infra 熔断 / 预览探测，payload 里没有
 * projectId）尤其不能给项目 Key，否则跨租户泄露的是 CDS 自身的运维现场。
 */
import express from 'express';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createNoticesRouter } from '../../src/routes/notices.js';
import { NoticeLedgerService } from '../../src/services/notice-ledger.js';

function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
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

let server: http.Server | null = null;

afterEach(async () => {
  if (server) await new Promise((r) => server!.close(() => r(null)));
  server = null;
});

/** projectScope 为 null 时模拟人类 cookie / 全局 Key；否则模拟项目级 Key 的戳。 */
async function boot(options: {
  ledger: NoticeLedgerService;
  projectScope?: string | null;
  outbound?: { configured: boolean; reason?: string };
}): Promise<http.Server> {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    if (options.projectScope) {
      (req as { cdsProjectKey?: { projectId: string } }).cdsProjectKey = { projectId: options.projectScope };
    }
    next();
  });
  app.use('/api', createNoticesRouter({
    ledger: options.ledger,
    getOutboundStatus: () => options.outbound ?? { configured: false, reason: '未配置 MAP 通知外发凭据' },
  }));
  const srv = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  server = srv;
  return srv;
}

function seed(): NoticeLedgerService {
  const ledger = new NoticeLedgerService({ storePath: '' });
  ledger.upsert({ id: 'a', dedupeKey: 'a', level: 'danger', title: 'A 项目发布失败', body: '', source: 'release', projectId: 'proj-a' });
  ledger.upsert({ id: 'b', dedupeKey: 'b', level: 'danger', title: 'B 项目发布失败', body: '', source: 'release', projectId: 'proj-b' });
  ledger.upsert({ id: 'sys', dedupeKey: 'sys', level: 'danger', title: '基础设施反复重启已熔断', body: '', source: 'system' });
  return ledger;
}

describe('GET /api/notices 作用域', () => {
  it('项目级 Key 只看到自己项目，系统级条目一条都不给', async () => {
    const srv = await boot({ ledger: seed(), projectScope: 'proj-a' });
    const res = await request(srv, 'GET', '/api/notices');
    expect(res.status).toBe(200);
    expect(res.body.notices.map((n: { id: string }) => n.id)).toEqual(['a']);
    expect(res.body.projectScope).toBe('proj-a');
  });

  it('人类 cookie / 全局 Key 拿到全量（含系统级）', async () => {
    const srv = await boot({ ledger: seed(), projectScope: null });
    const res = await request(srv, 'GET', '/api/notices');
    expect(res.body.notices.map((n: { id: string }) => n.id).sort()).toEqual(['a', 'b', 'sys']);
  });

  it('外发未配置时如实回 configured:false + 非空原因（不许暗示已通知）', async () => {
    const srv = await boot({ ledger: seed(), projectScope: null });
    const res = await request(srv, 'GET', '/api/notices');
    expect(res.body.outbound.configured).toBe(false);
    expect(String(res.body.outbound.reason).length).toBeGreaterThan(0);
  });
});

describe('POST /api/notices 兼容入口', () => {
  it('写入前端 window 事件那四类来源，id 直接当合并键', async () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    const srv = await boot({ ledger, projectScope: null });
    const res = await request(srv, 'POST', '/api/notices', {
      id: 'env-missing:proj-a',
      title: '必填环境变量缺失',
      body: 'JWT_SECRET 未配置',
      level: 'warning',
      source: 'env',
      projectId: 'proj-a',
    });
    expect(res.status).toBe(200);
    expect(res.body.notice.dedupeKey).toBe('env-missing:proj-a');
    expect(ledger.list()).toHaveLength(1);
  });

  it('缺 id/title、来源或级别不在白名单一律 400', async () => {
    const srv = await boot({ ledger: new NoticeLedgerService({ storePath: '' }), projectScope: null });
    expect((await request(srv, 'POST', '/api/notices', { title: 'x' })).status).toBe(400);
    expect((await request(srv, 'POST', '/api/notices', { id: 'x', title: 'x', source: 'wat' })).status).toBe(400);
    expect((await request(srv, 'POST', '/api/notices', { id: 'x', title: 'x', source: 'env', level: 'critical' })).status).toBe(400);
  });

  it('项目级 Key 不许往别的项目写', async () => {
    const srv = await boot({ ledger: new NoticeLedgerService({ storePath: '' }), projectScope: 'proj-a' });
    const res = await request(srv, 'POST', '/api/notices', {
      id: 'x', title: 'x', source: 'env', projectId: 'proj-b',
    });
    expect(res.status).toBe(403);
  });
});

describe('标已读 / 忽略', () => {
  it('read-all 只影响本作用域；dismiss 跨项目返 404', async () => {
    const ledger = seed();
    const scoped = await boot({ ledger, projectScope: 'proj-a' });
    expect((await request(scoped, 'POST', '/api/notices/read-all')).body.changed).toBe(1);
    expect(ledger.getByDedupeKey('b')?.readAt).toBeUndefined();

    const res = await request(scoped, 'POST', '/api/notices/b/dismiss');
    expect(res.status).toBe(404);
    expect(ledger.getByDedupeKey('b')?.dismissedAt).toBeUndefined();
  });
});
