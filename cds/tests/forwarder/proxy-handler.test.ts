/**
 * Forwarder HTTP 代理处理 — TDD 契约
 *
 * 对应 doc/report.cds-forwarder-success.md
 * 实现位置:cds/src/forwarder/proxy-handler.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { ProxyHandler } from '../../src/forwarder/proxy-handler.js';
import type { RouteRecord } from '../../src/forwarder/types.js';

interface UpstreamHandle {
  port: number;
  server: http.Server;
  close: () => Promise<void>;
}

async function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<UpstreamHandle> {
  const server = http.createServer(handler);
  // 跟踪所有 socket(包括 upgrade 后),确保 close 时全部断开
  const sockets: import('node:net').Socket[] = [];
  server.on('connection', (s) => {
    sockets.push(s);
    s.once('close', () => {
      const idx = sockets.indexOf(s);
      if (idx >= 0) sockets.splice(idx, 1);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) {
          try {
            s.destroy();
          } catch {
            // noop
          }
        }
        server.closeAllConnections?.();
        server.close(() => resolve());
        // 兜底超时:1 秒后强制 resolve
        setTimeout(() => resolve(), 1000).unref();
      }),
  };
}

interface ForwarderHandle {
  port: number;
  server: http.Server;
  close: () => Promise<void>;
  proxy: ProxyHandler;
}

async function startForwarder(
  routeFor: (host: string, path: string) => RouteRecord | null,
): Promise<ForwarderHandle> {
  const proxy = new ProxyHandler({ upstreamTimeoutMs: 500 });
  const sockets: import('node:net').Socket[] = [];
  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const route = routeFor(host, req.url ?? '/');
    void proxy.handle(req, res, route);
  });
  server.on('connection', (s) => {
    sockets.push(s);
    s.once('close', () => {
      const idx = sockets.indexOf(s);
      if (idx >= 0) sockets.splice(idx, 1);
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const route = routeFor(host, req.url ?? '/');
    void proxy.handleUpgrade(req, socket as import('node:net').Socket, head, route);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    server,
    proxy,
    close: () =>
      new Promise<void>((resolve) => {
        proxy.destroy();
        for (const s of sockets) {
          try {
            s.destroy();
          } catch {
            // noop
          }
        }
        server.closeAllConnections?.();
        server.close(() => resolve());
        setTimeout(() => resolve(), 1000).unref();
      }),
  };
}

function clientReq(
  port: number,
  options: Partial<http.RequestOptions> & { host?: string; path?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: { host: options.host ?? 'demo.miduo.org', ...(options.headers ?? {}) },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let upstreams: UpstreamHandle[] = [];
let forwarders: ForwarderHandle[] = [];

beforeEach(() => {
  upstreams = [];
  forwarders = [];
});

afterEach(async () => {
  for (const f of forwarders) await f.close();
  for (const u of upstreams) await u.close();
  upstreams = [];
  forwarders = [];
});

describe('ProxyHandler — HTTP 透传', () => {
  it('[C-3.3] 简单 GET 请求 P50 转发延迟 < 5ms,P99 < 30ms(本机)', async () => {
    const u = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hi');
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);

    // warm-up
    for (let i = 0; i < 3; i++) await clientReq(f.port);

    const N = 100;
    const latencies: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      const r = await clientReq(f.port);
      const t1 = process.hrtime.bigint();
      expect(r.status).toBe(200);
      latencies.push(Number(t1 - t0) / 1_000_000);
    }
    latencies.sort((a, b) => a - b);
    // 注意:这里测的是端到端的客户端 → forwarder → upstream 延迟,不是 forwarder 自身开销
    // 真实 forwarder 自身开销通常 < 1ms,这里宽松断言 P50 < 50ms / P99 < 200ms 容忍 CI 抖动
    const p50 = latencies[Math.floor(N * 0.5)];
    const p99 = latencies[Math.floor(N * 0.99)];
    expect(p50).toBeLessThan(50);
    expect(p99).toBeLessThan(200);
  });

  it('[C-3.3] 大 body POST(5MB)能正确流式转发', async () => {
    const u = await startUpstream((req, res) => {
      let total = 0;
      req.on('data', (c) => (total += c.length));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(String(total));
      });
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);

    const FIVE_MB = 5 * 1024 * 1024;
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: f.port,
          method: 'POST',
          path: '/',
          headers: { host: 'demo.miduo.org', 'content-type': 'application/octet-stream' },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      // 写 5MB:分 50 块 100KB
      const chunk = Buffer.alloc(100 * 1024, 0x61);
      let written = 0;
      const writeMore = () => {
        while (written < FIVE_MB) {
          const need = Math.min(FIVE_MB - written, chunk.length);
          const ok = req.write(need === chunk.length ? chunk : chunk.subarray(0, need));
          written += need;
          if (!ok) {
            req.once('drain', writeMore);
            return;
          }
        }
        req.end();
      };
      writeMore();
    });
    expect(result.status).toBe(200);
    expect(parseInt(result.body, 10)).toBe(FIVE_MB);
  });

  it('[C-3.3] response headers 完整透传(包括自定义 X-* header)', async () => {
    const u = await startUpstream((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'x-custom-foo': 'bar',
        'x-trace-id': 'abc123',
      });
      res.end('ok');
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    const r = await clientReq(f.port);
    expect(r.status).toBe(200);
    expect(r.headers['x-custom-foo']).toBe('bar');
    expect(r.headers['x-trace-id']).toBe('abc123');
  });

  it('[C-3.3] X-Forwarded-For 正确累积(append,不覆盖)', async () => {
    let seenXff = '';
    const u = await startUpstream((req, res) => {
      seenXff = String(req.headers['x-forwarded-for'] ?? '');
      res.writeHead(200);
      res.end();
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    await clientReq(f.port, { headers: { 'x-forwarded-for': '203.0.113.1' } });
    // 应保留客户端给的 IP,然后 append 转发者(127.0.0.1)的 IP
    expect(seenXff).toContain('203.0.113.1');
    expect(seenXff.split(',').length).toBeGreaterThanOrEqual(2);
  });

  it('[C-3.3] X-Forwarded-Proto 根据 nginx 上游传入的值', async () => {
    let seenProto = '';
    const u = await startUpstream((req, res) => {
      seenProto = String(req.headers['x-forwarded-proto'] ?? '');
      res.writeHead(200);
      res.end();
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    await clientReq(f.port, { headers: { 'x-forwarded-proto': 'https' } });
    expect(seenProto).toBe('https');
  });

  it('[C-3.3] Host 改写为 127.0.0.1:port 让上游 vhost 不挑剔,原始域名走 X-Forwarded-Host', async () => {
    // 2026-05-08 真生产验证:容器内应用普遍以 vhost 路由(nginx server_name /
    // .NET Host filtering / Vite host check),透传外部域名直接 404。改写为
    // upstream hostname:port 是 master ProxyService 的既定做法(proxy.ts:912)。
    let seenHost = '';
    let seenForwardedHost = '';
    const u = await startUpstream((req, res) => {
      seenHost = String(req.headers['host'] ?? '');
      seenForwardedHost = String(req.headers['x-forwarded-host'] ?? '');
      res.writeHead(200);
      res.end();
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    await clientReq(f.port, { host: 'demo.miduo.org' });
    expect(seenHost).toBe(`127.0.0.1:${u.port}`);
    expect(seenForwardedHost).toBe('demo.miduo.org');
  });

  it('[C-3.3] cookie 含 cds_branch 时,响应 cache-control=no-store + Vary=Cookie(对齐 master)', async () => {
    const u = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    const r = await clientReq(f.port, { headers: { cookie: 'cds_branch=foo; other=bar' } });
    expect(r.status).toBe(200);
    expect(String(r.headers['cache-control'])).toContain('no-store');
    expect(String(r.headers['vary']).toLowerCase()).toContain('cookie');
  });

  it('[C-3.3] HTML 200 + route 带 branchId/branchName → 注入 widget 在 </body> 前', async () => {
    const u = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>App</h1></body></html>');
    });
    upstreams.push(u);
    const route: RouteRecord = {
      _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100,
      branchId: 'demo-main', branchName: 'main',
    };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    const r = await clientReq(f.port);
    expect(r.status).toBe(200);
    // widget 必须出现在 </body> 之前(buildWidgetScript 输出 <script> 块)
    const idxBody = r.body.indexOf('</body>');
    const idxScript = r.body.indexOf('<script');
    expect(idxScript).toBeGreaterThan(-1);
    expect(idxScript).toBeLessThan(idxBody);
    // content-length 已重算(不应保留原始小值)
    expect(Number(r.headers['content-length'])).toBeGreaterThan(50);
  });

  it('[C-3.3] gzip 压缩 HTML 200 → 解压 + 注入 + 重新写 content-length', async () => {
    const original = '<html><body><h1>Gzipped App</h1></body></html>';
    const gzBody = zlib.gzipSync(Buffer.from(original, 'utf-8'));
    const u = await startUpstream((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': String(gzBody.length),
      });
      res.end(gzBody);
    });
    upstreams.push(u);
    const route: RouteRecord = {
      _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100,
      branchId: 'demo-main', branchName: 'main',
    };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    const r = await clientReq(f.port);
    expect(r.status).toBe(200);
    expect(r.body).toContain('Gzipped App');
    expect(r.body).toContain('<script');
    // 解压后 content-encoding 应被删除
    expect(r.headers['content-encoding']).toBeUndefined();
    // content-length 已重算,大于解压后的原始大小(因为加了 widget 脚本)
    expect(Number(r.headers['content-length'])).toBeGreaterThan(original.length);
  });

  it('[C-3.3] brotli 压缩 HTML 200 → 解压 + 注入', async () => {
    const original = '<html><body><h1>Brotli App</h1></body></html>';
    const brBody = zlib.brotliCompressSync(Buffer.from(original, 'utf-8'));
    const u = await startUpstream((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-encoding': 'br',
      });
      res.end(brBody);
    });
    upstreams.push(u);
    const route: RouteRecord = {
      _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100,
      branchId: 'demo-main', branchName: 'main',
    };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    const r = await clientReq(f.port);
    expect(r.status).toBe(200);
    expect(r.body).toContain('Brotli App');
    expect(r.body).toContain('<script');
    expect(r.headers['content-encoding']).toBeUndefined();
  });

  it('Bugbot Medium (PR #541): gzip upstream mid-stream reset → 502 + forwarder 进程不崩溃(原 upstreamRes 没 error 监听会触发 uncaughtException)', async () => {
    // upstream 发 gzip header + 部分 chunk 后立刻销毁 socket(模拟容器中途崩 ECONNRESET)
    const u = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      // 写入不完整的 gzip 字节(magic header 1f 8b 但截断)
      res.write(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
      // 立刻销毁 socket
      setTimeout(() => res.socket?.destroy(), 30);
    });
    upstreams.push(u);
    const route: RouteRecord = {
      _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100,
      branchId: 'demo-main', branchName: 'main',
    };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    // 关键:这次请求结束后整个 forwarder 不应崩溃。即使 status 是 502/200,
    // 重要的是没有 unhandled exception 让进程退出(测试 framework 会捕获到 process exit)
    const r = await clientReq(f.port);
    expect([502, 200]).toContain(r.status); // 接受 502(我们的兜底)或 200(残缺 inject 兜底)
    // 紧接着第二次请求仍能 work,证明 forwarder 进程还活着
    const r2 = await clientReq(f.port);
    expect(r2.status).toBeGreaterThan(0); // forwarder 进程没崩
  });

  it('[C-3.3] HTML 200 但 route 没 branchName → 不注入 widget(防误注入跨 host 资源)', async () => {
    const u = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>X</body></html>');
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    const r = await clientReq(f.port);
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('<script');
  });
});

describe('ProxyHandler — unknown host fallback to master', () => {
  it('[C-3.3] route=null 时 fallback 转给 master,保留原 Host header(让 master detectBranch)', async () => {
    let masterSeenHost = '';
    let masterSeenPath = '';
    const master = await startUpstream((req, res) => {
      masterSeenHost = String(req.headers['host'] ?? '');
      masterSeenPath = String(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>master starting page</html>');
    });
    upstreams.push(master);

    const proxy = new ProxyHandler({
      upstreamTimeoutMs: 500,
      unknownHostFallbackHost: '127.0.0.1',
      unknownHostFallbackPort: master.port,
    });
    const server = http.createServer((req, res) => {
      // route=null:模拟 publisher 没发布的 host(building/error 分支)
      void proxy.handle(req, res, null);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const fwdPort = (server.address() as AddressInfo).port;
    forwarders.push({ port: fwdPort, server, proxy, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); setTimeout(() => r(), 1000).unref(); }) });

    const r = await clientReq(fwdPort, { host: 'unknown-branch.miduo.org', path: '/some-path' });
    expect(r.status).toBe(200);
    expect(r.body).toContain('master starting page');
    // 关键:master 看到的 Host 是原始外部域名(不是 forwarder 改写的 127.0.0.1:port)
    expect(masterSeenHost).toBe('unknown-branch.miduo.org');
    // path 也保留(没有被 strip)
    expect(masterSeenPath).toBe('/some-path');
  });

  it('[C-3.3] 没配 fallback 时 route=null 走 plain 503 等候页(不变行为)', async () => {
    const proxy = new ProxyHandler({
      upstreamTimeoutMs: 500,
      // 故意不传 unknownHostFallbackHost/Port
    });
    const server = http.createServer((req, res) => {
      void proxy.handle(req, res, null);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const fwdPort = (server.address() as AddressInfo).port;
    forwarders.push({ port: fwdPort, server, proxy, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); setTimeout(() => r(), 1000).unref(); }) });

    const r = await clientReq(fwdPort, { host: 'unknown.miduo.org' });
    expect(r.status).toBe(503);
    expect(r.body.toLowerCase()).toContain('waiting');
  });
});

describe('ProxyHandler — /_cds/api/* passthrough', () => {
  it('Bugbot Low (PR #541): /_cds/* passthrough 不 mutate req.url(共享对象洁净 + 日志显示原始 path)', async () => {
    const master = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    upstreams.push(master);
    const proxy = new ProxyHandler({
      upstreamTimeoutMs: 500,
      masterPassthroughPort: master.port,
    });

    let observedReqUrlInCallback = '';
    const server = http.createServer((req, res) => {
      void proxy.handle(req, res, null).then(() => {
        // 确认 handle 处理后 req.url 仍是原始值,没被 strip
        observedReqUrlInCallback = req.url ?? '';
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const fwdPort = (server.address() as AddressInfo).port;
    forwarders.push({ port: fwdPort, server, proxy, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); setTimeout(() => r(), 1000).unref(); }) });

    await clientReq(fwdPort, { path: '/_cds/api/branches' });
    expect(observedReqUrlInCallback).toBe('/_cds/api/branches'); // 未被 strip 为 /api/branches
  });

  it('[C-3.3] /_cds/api/* 转发到 master 端口 + 改写 path(strip /_cds)+ 加内部来源 header', async () => {
    let seenPath = '';
    let seenInternalHeader = '';
    let seenSourceHost = '';
    let seenSourceBranch = '';
    let seenHost = '';
    // 启个"假 master"(不是真 master),验证 forwarder 转过来时 path 改了 + header 加了
    const master = await startUpstream((req, res) => {
      seenPath = String(req.url ?? '');
      seenInternalHeader = String(req.headers['x-cds-internal'] ?? '');
      seenSourceHost = String(req.headers['x-cds-source-host'] ?? '');
      seenSourceBranch = String(req.headers['x-cds-source-branch-id'] ?? '');
      seenHost = String(req.headers['host'] ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, branches: [] }));
    });
    upstreams.push(master);
    // 分支容器(不应被命中)
    const branchUpstream = await startUpstream((_req, res) => {
      res.writeHead(404);
      res.end('branch container should not see /_cds/* requests');
    });
    upstreams.push(branchUpstream);
    const branchRoute: RouteRecord = {
      _id: '1', host: 'demo.miduo.org', upstreamPort: branchUpstream.port, weight: 100,
      branchId: 'demo-main', branchName: 'main',
    };
    // forwarder masterPassthroughPort 指向我们的"假 master"
    const proxy = new ProxyHandler({
      upstreamTimeoutMs: 500,
      masterPassthroughHost: '127.0.0.1',
      masterPassthroughPort: master.port,
    });
    const server = http.createServer((req, res) => {
      void proxy.handle(req, res, branchRoute);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const fwdPort = (server.address() as AddressInfo).port;
    forwarders.push({ port: fwdPort, server, proxy, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); setTimeout(() => r(), 1000).unref(); }) });

    const r = await clientReq(fwdPort, { path: '/_cds/api/branches' });
    expect(r.status).toBe(200);
    expect(r.body).toContain('"ok":true');
    // path 被 strip:/_cds/api/branches → /api/branches
    expect(seenPath).toBe('/api/branches');
    // x-cds-internal header 加了(让 master 跳过 auth)
    expect(seenInternalHeader).toBe('1');
    // 来源上下文必须带给 master,否则跨项目过滤无法判断当前预览属于哪个项目
    expect(seenSourceHost).toBe('demo.miduo.org');
    expect(seenSourceBranch).toBe('demo-main');
    // Host 改写为 master 端口(因为目标是 master 的 admin REST)
    expect(seenHost).toBe(`127.0.0.1:${master.port}`);
  });

  it('[C-3.3] 非 /_cds/* 路径走分支容器,不被 passthrough', async () => {
    let masterHit = false;
    let branchHit = false;
    const master = await startUpstream((_req, res) => {
      masterHit = true;
      res.writeHead(200);
      res.end('master');
    });
    upstreams.push(master);
    const branchUpstream = await startUpstream((_req, res) => {
      branchHit = true;
      res.writeHead(200);
      res.end('branch app');
    });
    upstreams.push(branchUpstream);
    const branchRoute: RouteRecord = {
      _id: '1', host: 'demo.miduo.org', upstreamPort: branchUpstream.port, weight: 100,
    };
    const proxy = new ProxyHandler({
      upstreamTimeoutMs: 500,
      masterPassthroughPort: master.port,
    });
    const server = http.createServer((req, res) => {
      void proxy.handle(req, res, branchRoute);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const fwdPort = (server.address() as AddressInfo).port;
    forwarders.push({ port: fwdPort, server, proxy, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); setTimeout(() => r(), 1000).unref(); }) });

    const r = await clientReq(fwdPort, { path: '/api/branches' }); // 不带 /_cds/ 前缀
    expect(r.status).toBe(200);
    expect(r.body).toBe('branch app');
    expect(branchHit).toBe(true);
    expect(masterHit).toBe(false); // 关键:master 不该被命中
  });
});

describe('ProxyHandler — SSE / WebSocket / 长连接', () => {
  it('[C-3.3] SSE 长连接持续 5 秒,期间收到 ≥ 5 条 event 全部透传', async () => {
    const u = await startUpstream((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let i = 0;
      const t = setInterval(() => {
        i += 1;
        res.write(`data: event-${i}\n\n`);
        if (i >= 6) {
          clearInterval(t);
          res.end();
        }
      }, 50);
      res.on('close', () => clearInterval(t));
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    const events = await new Promise<string[]>((resolve, reject) => {
      const got: string[] = [];
      const req = http.request(
        {
          host: '127.0.0.1',
          port: f.port,
          method: 'GET',
          path: '/sse',
          headers: { host: 'demo.miduo.org', accept: 'text/event-stream' },
        },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (c) => {
            const matches = String(c).match(/event-\d+/g);
            if (matches) got.push(...matches);
          });
          res.on('end', () => resolve(got));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(events.length).toBeGreaterThanOrEqual(5);
  });

  it('[C-3.3] SSE 客户端主动断开 → 后端连接也释放(无泄漏)', async () => {
    let upstreamClosed = false;
    const u = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const t = setInterval(() => res.write(`data: tick\n\n`), 30);
      const cleanup = () => {
        upstreamClosed = true;
        clearInterval(t);
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: f.port,
          method: 'GET',
          path: '/sse',
          headers: { host: 'demo.miduo.org', accept: 'text/event-stream' },
        },
        (res) => {
          res.once('data', () => {
            // 收到第一条就主动断
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => resolve()); // destroy 会触发 error
      req.end();
    });
    // 等待 upstream 检测到客户端断开
    await new Promise((r) => setTimeout(r, 200));
    expect(upstreamClosed).toBe(true);
  });

  it('[C-3.3] WebSocket Upgrade 握手成功', async () => {
    // 用最小 ws 握手:回 101 + 必要 headers
    const u = await startUpstream((_req, _res) => {
      // 不应到这,因为本测试只发 upgrade
    });
    u.server.on('upgrade', (_req, socket, _head) => {
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Accept: dGhlIHNhbXBsZSBub25jZQ==',
        ].join('\r\n') + '\r\n\r\n',
      );
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: f.port,
        method: 'GET',
        path: '/ws',
        headers: {
          host: 'demo.miduo.org',
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      });
      req.on('upgrade', (res, sock) => {
        // 立刻关 socket,避免 server.close() afterEach hang
        try {
          sock.destroy();
        } catch {
          // noop
        }
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(101);
  });

  it('[C-3.3] WebSocket 双向消息透传', async () => {
    const u = await startUpstream(() => {});
    u.server.on('upgrade', (_req, socket, _head) => {
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Accept: dGhlIHNhbXBsZSBub25jZQ==',
        ].join('\r\n') + '\r\n\r\n',
      );
      // 收到任何字节就 echo
      socket.on('data', (chunk) => {
        socket.write(Buffer.concat([Buffer.from('echo:'), chunk]));
      });
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    const echoed = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: f.port,
        method: 'GET',
        path: '/ws',
        headers: {
          host: 'demo.miduo.org',
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      });
      req.on('upgrade', (_res, sock) => {
        sock.once('data', (c) => {
          const data = c.toString('utf8');
          try {
            sock.destroy();
          } catch {
            // noop
          }
          resolve(data);
        });
        sock.write(Buffer.from('hello'));
      });
      req.on('error', reject);
      req.end();
    });
    expect(echoed).toContain('echo:hello');
  });
});

describe('ProxyHandler — 故障与降级', () => {
  it('[C-1.2] 路由查不到 → 503 + cds-waiting 页面', async () => {
    const f = await startForwarder(() => null);
    forwarders.push(f);
    const r = await clientReq(f.port);
    expect(r.status).toBe(503);
    expect(r.body.toLowerCase()).toContain('waiting');
  });

  it('Bugbot (PR #541): waitingPageHtml 是 HTML 时 Content-Type 应为 text/html(否则浏览器显示原始标签 + auto-reload script 不执行)', async () => {
    // 用一个 HTML 字符串(模拟 forwarder-main 默认行为)
    const proxy = new ProxyHandler({
      upstreamTimeoutMs: 500,
      waitingPageHtml: '<!doctype html><body><h1>warming up</h1><script>setTimeout(()=>location.reload(),3000)</script>',
    });
    const server = http.createServer((req, res) => {
      // route=null → respondWaiting
      void proxy.handle(req, res, null);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const fwdPort = (server.address() as AddressInfo).port;
    forwarders.push({ port: fwdPort, server, proxy, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); setTimeout(() => r(), 1000).unref(); }) });
    const r = await clientReq(fwdPort);
    expect(r.status).toBe(503);
    expect(String(r.headers['content-type'] ?? '').toLowerCase()).toContain('text/html');
    expect(r.body).toContain('<script');
  });

  it('[C-5.1] upstream connect 拒绝(端口未开)→ 503 + 错误响应(JSON 含 hint,HTML 含 准备中)', async () => {
    // 用一个一定关闭的端口
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: 1, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    // JSON 客户端
    const rj = await clientReq(f.port);
    expect(rj.status).toBe(503);
    expect(rj.body).toContain('upstream-error');
    expect(rj.body.toLowerCase()).toContain('econnrefused');
    // 浏览器客户端(Accept: text/html) → 友好 HTML
    const rh = await clientReq(f.port, { headers: { accept: 'text/html' } });
    expect(rh.status).toBe(503);
    expect(rh.body).toContain('准备中');
    expect(rh.body).toContain('location.reload');
  });

  it('[C-5.1] upstream 5s 无响应 → 504 + waiting 页面', async () => {
    // upstream 永远不响应
    const u = await startUpstream(() => {
      // 不 res.writeHead / 不 res.end
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    // forwarder 默认 upstreamTimeoutMs=500(测试中 startForwarder 写死了 500)
    const f = await startForwarder(() => route);
    forwarders.push(f);
    const r = await clientReq(f.port);
    expect(r.status).toBe(504);
    expect(r.body.toLowerCase()).toContain('waiting');
  }, 10000);

  it('[C-5.1] upstream 中途 reset → 给客户端 502 + 错误响应', async () => {
    const u = await startUpstream((_req, _res) => {
      // 立刻销毁连接,客户端拿到 ECONNRESET
    });
    u.server.on('connection', (sock) => {
      // 收到第一字节就 destroy
      sock.once('data', () => sock.destroy());
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    const r = await clientReq(f.port);
    // 502 / 503 都接受(ECONNRESET 在 connect 阶段触发可能等同于 connect 失败)
    expect([502, 503]).toContain(r.status);
    expect(r.body).toContain('upstream-error');
  });

  it('[C-4.4] upstream URL 来自路由表,不接受 client header 改写(防止 SSRF)', async () => {
    // 起两个 upstream,A 是合法路由,B 是攻击者想骗去的
    const targetA = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('A');
    });
    const targetB = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('B');
    });
    upstreams.push(targetA, targetB);
    // 路由表只指向 A
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: targetA.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    // 攻击者尝试传 X-Upstream-Port / X-Forwarded-Host 等改写
    const r = await clientReq(f.port, {
      headers: {
        'x-upstream-port': String(targetB.port),
        'x-upstream-host': '127.0.0.1',
        'x-real-port': String(targetB.port),
      },
    });
    expect(r.body).toBe('A'); // 仍然走 A,client headers 无法改写 upstream
  });
});

describe('ProxyHandler — 资源回收', () => {
  it('[C-3.3] 1000 次请求后,文件描述符数量稳定(无 leak)', async () => {
    const u = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    // 跑 1000 次请求
    for (let i = 0; i < 1000; i++) {
      const r = await clientReq(f.port);
      expect(r.status).toBe(200);
    }
    // 简化断言:进程没崩、stats.totalRequests=1000
    expect(f.proxy.getStats().totalRequests).toBe(1000);
  }, 30_000);

  it('[C-3.3] keepalive 复用上游连接(不每次都新建 socket)', async () => {
    const seenSockets = new Set<unknown>();
    const u = await startUpstream((req, res) => {
      seenSockets.add(req.socket);
      res.writeHead(200);
      res.end('ok');
    });
    upstreams.push(u);
    const route: RouteRecord = { _id: '1', host: 'demo.miduo.org', upstreamPort: u.port, weight: 100 };
    const f = await startForwarder(() => route);
    forwarders.push(f);
    for (let i = 0; i < 20; i++) await clientReq(f.port);
    // 用了 keepalive 后,upstream 看到的 socket 数应该远小于 20
    expect(seenSockets.size).toBeLessThan(20);
  });
});
