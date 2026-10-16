import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ProxyService } from '../../src/services/proxy.js';
import { ProxyHandler } from '../../src/forwarder/proxy-handler.js';
import { StateService } from '../../src/services/state.js';
import { hasWidgetCspHeader, hasWidgetCspMeta } from '../../src/services/widget-injection-policy.js';

const servers: http.Server[] = [];
const cleanup: Array<() => Promise<void> | void> = [];
async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function proxyPort(kind: string, upstream: number): Promise<number> {
  if (kind === 'forwarder') {
    const proxy = new ProxyHandler({ upstreamTimeoutMs: 1000 });
    cleanup.push(() => proxy.destroy());
    return listen((req, res) => { void proxy.handle(req, res, {
      _id: 'test', host: 'test.invalid', upstreamPort: upstream, weight: 100,
      branchId: 'main', branchName: 'main',
    }); });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbd-csp-proxy-'));
  const state = new StateService(path.join(dir, 'state.json')); state.load();
  state.addBranch({ id: 'main', branch: 'main', worktreePath: dir, status: 'running',
    createdAt: new Date().toISOString(), services: {
      web: { profileId: 'web', status: 'running', hostPort: upstream, containerName: 'test-only' },
    } });
  state.setDefaultBranch('main');
  cleanup.push(async () => { await state.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  const proxy = new ProxyService(state);
  proxy.setResolveUpstream(() => `http://127.0.0.1:${upstream}`);
  return listen((req, res) => { void proxy.handleRequest(req, res); });
}
function request(port: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { 'x-branch': 'main' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}
const strict = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const plain = '<!doctype html><html><body><h1>业务页面</h1></body></html>';
const meta = `<!doctype html><html><head><meta content="${strict}" HTTP-EQUIV='Content-Security-Policy'></head><body><h1>业务页面</h1></body></html>`;

describe.each(['master', 'forwarder'])('%s 实际 HTTP 代理保留应用 CSP', kind => {
  it.each(['content-security-policy', 'content-security-policy-report-only'])('%s 响应头保留压缩字节，不注入装饰', async name => {
    const zipped = zlib.gzipSync(Buffer.from(plain));
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', [name]: strict,
        'content-encoding': 'gzip', 'content-length': String(zipped.length) });
      res.end(zipped);
    });
    const response = await request(await proxyPort(kind, upstream));
    expect(response.status).toBe(200);
    expect(response.headers[name]).toBe(strict);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.body).toEqual(zipped);
  });
  it.each(['identity', 'gzip', 'br', 'deflate'])('HTML meta CSP 在 %s 编码下保留策略和业务正文', async encoding => {
    const raw = Buffer.from(meta);
    const body = encoding === 'gzip' ? zlib.gzipSync(raw) : encoding === 'br' ? zlib.brotliCompressSync(raw)
      : encoding === 'deflate' ? zlib.deflateSync(raw) : raw;
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.length),
        ...(encoding === 'identity' ? {} : { 'content-encoding': encoding }) });
      res.end(body);
    });
    const response = await request(await proxyPort(kind, upstream));
    expect(response.status).toBe(200);
    expect(response.body).toEqual(raw);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(Number(response.headers['content-length'])).toBe(raw.length);
    expect(response.body.toString()).not.toContain('data-cds-widget-root');
  });
  it('未声明 CSP 的页面继续注入既有 widget', async () => {
    const upstream = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(plain); });
    const response = await request(await proxyPort(kind, upstream));
    expect(response.status).toBe(200);
    expect(response.body.toString()).toContain('data-cds-widget-root');
    expect(response.body.toString()).toContain('<h1>业务页面</h1>');
  });
});

describe('可选 widget 策略的保守判断', () => {
  it('多条策略以及大小写响应头不能绕过跳过判断', () => {
    expect(hasWidgetCspHeader({ 'Content-Security-Policy': ['', strict] })).toBe(true);
    expect(hasWidgetCspHeader({ 'content-type': 'text/html' })).toBe(false);
  });
  it.each([
    '<meta http-equiv=Content-Security-Policy content="default-src none">',
    '<META content="img-src https://example.invalid/a>b" http-equiv=" Content-Security-Policy ">',
    "<meta\nhttp-equiv='content-security-policy' content=\"default-src 'none'\"/>",
  ])('兼容常见 meta 属性顺序和引号：%s', html => {
    expect(hasWidgetCspMeta(html)).toBe(true);
  });
  it('普通页面提及 CSP 字样不取消装饰', () => {
    expect(hasWidgetCspMeta('<p>Content-Security-Policy</p><meta name="viewport" content="width=device-width">')).toBe(false);
  });
});
