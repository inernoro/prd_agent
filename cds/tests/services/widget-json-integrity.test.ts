import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProxyHandler } from '../../src/forwarder/proxy-handler.js';
import { ProxyService } from '../../src/services/proxy.js';
import { StateService } from '../../src/services/state.js';

const servers: http.Server[] = [];
const forwarders: ProxyHandler[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const proxy of forwarders.splice(0)) proxy.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
const codecs = {
  identity: (body: Buffer) => body,
  gzip: zlib.gzipSync,
  br: zlib.brotliCompressSync,
  deflate: zlib.deflateSync,
};
async function actualResponse(kind: 'master' | 'forwarder', body: Buffer, encoding: keyof typeof codecs = 'identity', contentType = 'text/html;charset=UTF-8', status = 200, declaredEncoding = encoding === 'identity' ? '' : encoding as string, reset = false) {
  const wire = codecs[encoding](body);
  const upstream = await listen((req, res) => {
    req.resume();
    res.writeHead(status, { 'content-type': contentType, ...(reset ? {} : { 'content-length': String(wire.length) }), ...(declaredEncoding ? { 'content-encoding': declaredEncoding } : {}) });
    if (reset) {
      res.write(wire.subarray(0, 12)); setTimeout(() => res.destroy(), 20); return;
    }
    // Split across network writes; classification must not depend on the first chunk.
    res.write(wire.subarray(0, 1)); res.end(wire.subarray(1));
  });
  let entry: number;
  if (kind === 'forwarder') {
    const proxy = new ProxyHandler({ upstreamTimeoutMs: 1000 }); forwarders.push(proxy);
    entry = await listen((req, res) => void proxy.handle(req, res, { _id: 'owned', host: 'owned.example', upstreamPort: upstream, weight: 100, branchId: 'b', branchName: 'main' }));
  } else {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-widget-integrity-')); directories.push(directory);
    const state = new StateService(path.join(directory, 'state.json')); state.load();
    const proxy = new ProxyService(state) as unknown as { proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, upstream: string, branch: { branchId: string; branchName: string }): void };
    entry = await listen((req, res) => proxy.proxyRequest(req, res, 'http://127.0.0.1:'+upstream, { branchId: 'b', branchName: 'main' }));
  }
  return await new Promise<{ body: Buffer; headers: http.IncomingHttpHeaders; status: number }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: entry, path: '/beat', method: 'POST', headers: { host: 'owned.example', 'content-type': 'application/json' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ body: Buffer.concat(chunks), headers: res.headers, status: res.statusCode ?? 0 }));
    });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('owned probe timeout'))); req.end('{}');
  });
}
for (const kind of ['master', 'forwarder'] as const) describe(kind+' widget body integrity (actual HTTP producer, no runtime or auth claim)', () => {
  for (const encoding of Object.keys(codecs) as Array<keyof typeof codecs>) {
    it('preserves mislabeled XXL JSON bytes and parser result '+encoding, async () => {
      const body = Buffer.from('\ufeff \n'+JSON.stringify({ code: 200, msg: '真实 RPC <html></body> 字段', content: null }));
      const response = await actualResponse(kind, body, encoding);
      expect(response.status).toBe(200); expect(response.body).toEqual(body);
      expect(JSON.parse(response.body.toString('utf8').replace(/^\ufeff/, '').trim()).code).toBe(200);
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(Number(response.headers['content-length'])).toBe(body.length);
      expect(response.headers['content-type']).toBe('text/html;charset=UTF-8');
    });
    it('retains actual HTML widget injection '+encoding, async () => {
      const response = await actualResponse(kind, Buffer.from('\ufeff \n<html><body>实际页面</body></html>'), encoding);
      const body = response.body.toString('utf8'); expect(body).toContain('data-cds-widget');
      expect(body.indexOf('data-cds-widget')).toBeLessThan(body.lastIndexOf('</body>'));
      expect(Number(response.headers['content-length'])).toBe(response.body.length);
    });
  }
  it('preserves empty and invalid UTF8 non-markup bytes without widget', async () => {
    for (const body of [Buffer.alloc(0), Buffer.from([0xff, 0xfe, 0, 1])]) expect((await actualResponse(kind, body)).body).toEqual(body);
  });
  it('leaves correctly labeled JSON and non2xx responses in passthrough', async () => {
    const body = Buffer.from('{"code":403,"msg":"拒绝"}');
    expect((await actualResponse(kind, body, 'identity', 'application/json')).body).toEqual(body);
    const response = await actualResponse(kind, body, 'identity', 'text/html', 403);
    expect(response.status).toBe(403); expect(response.body).toEqual(body);
  });
  it('returns a real failure for malformed supported compression', async () => {
    for (const encoding of ['gzip', 'br', 'deflate']) {
      const response = await actualResponse(kind, Buffer.from('not-compressed'), 'identity', 'text/html', 200, encoding);
      expect(response.status).toBe(502); expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.body.toString('utf8')).not.toContain('data-cds-widget');
    }
  });
  it('returns a real failure when the compressed upstream resets mid-body', async () => {
    const response = await actualResponse(kind, Buffer.from('{"code":200,"padding":"'+ 'x'.repeat(100) +'"}'), 'gzip', 'text/html', 200, 'gzip', true);
    expect(response.status).toBe(502); expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.body.toString('utf8')).not.toContain('data-cds-widget');
  });
  it('retains explicit identity encoding for markup and JSON', async () => {
    for (const body of [Buffer.from('{"code":200}'), Buffer.from('<html><body>identity</body></html>')]) {
      const response = await actualResponse(kind, body, 'identity', 'text/html', 200, 'identity');
      expect(response.headers['content-encoding']).toBe('identity');
      if (body[0] === 0x3c) expect(response.body.toString('utf8')).toContain('data-cds-widget');
      else expect(response.body).toEqual(body);
      expect(Number(response.headers['content-length'])).toBe(response.body.length);
    }
  });
  it('preserves unknown and stacked encodings without interpreting raw markup', async () => {
    for (const [encoding, wire] of [
      ['x-opaque', Buffer.from('<html><body>opaque bytes</body></html>')],
      ['gzip, br', zlib.brotliCompressSync(zlib.gzipSync(Buffer.from('{"code":200}')))],
    ] as const) {
      const response = await actualResponse(kind, wire, 'identity', 'text/html', 200, encoding);
      expect(response.body).toEqual(wire); expect(response.headers['content-encoding']).toBe(encoding);
      expect(Number(response.headers['content-length'])).toBe(wire.length);
    }
  });
  it('does not scan beyond the 4KiB prefix to invent a document', async () => {
    const body = Buffer.from(' '.repeat(4096)+'<html><body>unknown prefix</body></html>');
    expect((await actualResponse(kind, body)).body).toEqual(body);
  });
});
