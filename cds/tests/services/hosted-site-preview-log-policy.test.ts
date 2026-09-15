import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import ts from 'typescript';
import { HttpLogStore, redactHeaders, redactBodyText } from '../../src/services/http-log-store.js';
import { isHostedSitePreviewRequest, redactHostedSitePreviewLog } from '../../src/services/hosted-site-preview-log-policy.js';
import { ProxyService } from '../../src/services/proxy.js';
import { ProxyHandler } from '../../src/forwarder/proxy-handler.js';

const ticket = 'SyntheticPreviewCanary-ONLY-0123456789';
const preview = `/api/hosted-site-preview-files/${ticket}/assets/app.js?private=another-canary`;

describe('hosted site preview logging boundary', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it.each([
    preview, `https://map.test${preview}`, `//map.test${preview}`, `/API/%68osted-site-preview-files/${ticket}/index.html`,
    `/%61pi/hosted-site-preview-files/${ticket}%2Fassets%2Fapp.js`,
    `%2Fapi%2Fhosted-site-preview-files%2F${ticket}%2Findex.html`,
    `/_cds/api/hosted-site-preview-files/${ticket}/index.html`,
    `/api/hosted-site-preview-files/${ticket}%ZZ/index.html`,
  ])('matches one encoded route without disclosing the ticket: %s', (value) => {
    expect(isHostedSitePreviewRequest(value)).toBe(true);
    expect(redactHostedSitePreviewLog(value)).toBe('/api/hosted-site-preview-files/[redacted]');
  });
  it.each(['/api/hosted-site-preview-files-other/value', '/other/api/hosted-site-preview-files/value', '/api/hosted-site-preview-access-other', '/api/other?file=abc'])('leaves unrelated endpoints unchanged: %s', (value) => {
    expect(isHostedSitePreviewRequest(value)).toBe(false);
    expect(redactHostedSitePreviewLog(value)).toBe(value);
  });
  it('suppresses access descendant error paths using the same route boundary as MAP', () => {
    const value = `/API/%68osted-site-preview-access/${ticket}?extra=secret`;
    expect(isHostedSitePreviewRequest(value)).toBe(true);
    expect(redactHostedSitePreviewLog(value)).toBe('/api/hosted-site-preview-access');
  });
  it('redacts preview URLs in Referer, Location and error text without mutating headers', () => {
    const headers = { referer: `https://map.test${preview}`, location: `/API/%68osted-site-preview-files/${ticket}/index.html` };
    expect(JSON.stringify(redactHeaders(headers))).not.toContain(ticket);
    expect(redactBodyText(`Failed fetching https://map.test${preview}`)).not.toContain(ticket);
    expect(headers.referer).toContain(ticket);
  });

  it.each([preview, '/api/hosted-site-preview-access?private=another-canary'])('suppresses bodies and paths before active and persisted records: %s', async (requestPath) => {
    const store = new HttpLogStore({ uri: 'mongodb://127.0.0.1:1' });
    const records: unknown[] = [];
    const internal = store as any;
    internal.collection = { async insertOne(value: unknown) { records.push(value); }, async countDocuments() { return 0; } };
    const record = {
      layer: 'forwarder' as const, requestId: 'synthetic-request', method: 'POST', path: requestPath,
      upstream: `https://map.test${preview}`, status: 500, durationMs: 1, outcome: 'server-error' as const,
      request: { headers: { referer: `https://map.test${preview}` }, bodyPreview: `private-request-${ticket}`, bodyBytes: 100 },
      response: { headers: { location: preview }, bodyPreview: `private-response-${ticket}`, bodyBytes: 100 },
      error: { message: `Fetch failed with raw ticket ${ticket}` },
    };
    const { response: _response, error: _error, status: _status, outcome: _outcome, durationMs: _durationMs, ...activeRecord } = record;
    store.beginActive(activeRecord);
    expect(JSON.stringify(store.findActive())).not.toContain(ticket);
    expect(JSON.stringify(store.findActive())).not.toContain('private-request');
    store.record(record);
    await internal.chain;
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(ticket);
    expect(JSON.stringify(records)).not.toContain('private-response');
    expect(JSON.stringify(records)).not.toContain('another-canary');
    expect(record.path).toBe(requestPath);
    expect(record.request.bodyPreview).toContain(ticket);
  });

  it.each((['master', 'forwarder'] as const).flatMap((layer) => [preview, '/api/hosted-site-preview-access'].flatMap((requestPath) =>
    [200, 404].map((status) => ({ layer, requestPath, status })))))('keeps real forwarding bytes but sanitizes all log sinks: $layer $requestPath $status', async ({ layer, requestPath, status }) => {
    vi.stubEnv('CDS_FORWARDER_ACCESS_LOG', '1');
    const records: unknown[] = [];
    const active: unknown[] = [];
    const events: unknown[] = [];
    const logOutput: unknown[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args) => { logOutput.push(args); });
    vi.spyOn(console, 'error').mockImplementation((...args) => { logOutput.push(args); });
    const req = new EventEmitter() as any;
    Object.assign(req, { method: 'POST', url: requestPath, headers: { host: 'map.test', 'content-type': 'application/json', referer: `https://map.test${preview}` }, socket: { remoteAddress: '127.0.0.1' }, pipe: vi.fn() });
    const res = makeResponse();
    let callback: ((value: any) => void) | undefined;
    let options: any;
    const outgoing = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn(), setTimeout: vi.fn() });
    vi.spyOn(http, 'request').mockImplementation(((config: any, cb: any) => { options = config; callback = cb; return outgoing; }) as any);
    const sink = { record: (value: unknown) => records.push(value), beginActive: (value: unknown) => { active.push(value); return 'active'; }, completeActive: vi.fn() };
    let handled: Promise<unknown> | undefined;
    if (layer === 'master') {
      const proxy = new ProxyService({ getState: () => ({ branches: {} }) } as any);
      proxy.setHttpLogStore(sink);
      proxy.setOnAccess((...args) => { events.push(args); });
      proxy.setOnProxyLog((value) => { events.push(value); });
      (proxy as any).proxyRequest(req, res, 'http://127.0.0.1:12345', { branchId: 'test', branchName: 'test', trackAccess: true });
    } else {
      const proxy = new ProxyHandler({ httpLogStore: sink, logger: { info: (...args: unknown[]) => logOutput.push(args), warn: (...args: unknown[]) => logOutput.push(args) } as any });
      handled = proxy.handle(req, res as any, { _id: 'test', host: 'map.test', upstreamHost: '127.0.0.1', upstreamPort: 12345, weight: 100 } as any);
    }
    expect(options.path).toBe(requestPath);
    expect(options.headers.referer).toContain(ticket);
    expect(callback).toBeTypeOf('function');
    req.emit('data', Buffer.from(`private-request-${ticket}`));
    const response = Object.assign(new EventEmitter(), {
      statusCode: status, headers: { 'content-type': 'application/json', location: preview },
      pipe: (target: any) => { response.on('data', (chunk) => target.write(chunk)); response.on('end', () => target.end()); return target; },
    });
    callback!(response);
    response.emit('data', Buffer.from(`private-response-${ticket}`));
    response.emit('end');
    await handled;
    expect(res.sent.join('')).toBe(`private-response-${ticket}`);
    expect(res.getHeader('location')).toBe(preview);
    expect(req.url).toBe(requestPath);
    expect(active).toHaveLength(1);
    expect(records).toHaveLength(1);
    const allLogs = JSON.stringify({ records, active, events, logOutput });
    expect(allLogs).not.toContain(ticket);
    expect(allLogs).not.toContain('private-request');
    expect(allLogs).not.toContain('private-response');
  });

  it('redacts forwarder no-route errors before a custom sink or console sees them', async () => {
    const records: unknown[] = [];
    const warnings: unknown[] = [];
    const req = Object.assign(new EventEmitter(), { url: preview, method: 'GET', headers: { host: 'unknown.test' }, socket: { remoteAddress: '127.0.0.1' } });
    const res = makeResponse();
    const proxy = new ProxyHandler({ httpLogStore: { record: (value) => records.push(value) }, logger: { warn: (...args: unknown[]) => warnings.push(args) } as any });
    await proxy.handle(req as any, res as any, null);
    expect(records).toHaveLength(1);
    expect(JSON.stringify({ records, warnings })).not.toContain(ticket);
    expect(req.url).toBe(preview);
  });

  it.each(['master', 'forwarder', 'forwarder-fallback'])('does not log raw upstream error tickets, including fallback: %s', async (layer) => {
    const logs: unknown[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args) => { logs.push(args); });
    vi.spyOn(console, 'error').mockImplementation((...args) => { logs.push(args); });
    const req = Object.assign(new EventEmitter(), { url: preview, method: 'GET', headers: { host: 'map.test', accept: 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, pipe: vi.fn() });
    const res = makeResponse();
    const outgoing = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn(), setTimeout: vi.fn() });
    vi.spyOn(http, 'request').mockReturnValue(outgoing as any);
    const sink = { record: (value: unknown) => logs.push(value), beginActive: (value: unknown) => { logs.push(value); return 'error-active'; }, completeActive: vi.fn() };
    let handled: Promise<unknown> | undefined;
    if (layer === 'master') {
      const proxy = new ProxyService({ getState: () => ({ branches: {} }) } as any);
      proxy.setHttpLogStore(sink);
      proxy.setOnAccess((...args) => { logs.push(args); });
      proxy.setOnProxyLog((value) => { logs.push(value); });
      (proxy as any).proxyRequest(req, res, 'http://127.0.0.1:12345', { branchId: 'test', branchName: 'test', trackAccess: true });
    } else {
      const proxy = new ProxyHandler({
        httpLogStore: sink, unknownHostFallbackHost: '127.0.0.1', unknownHostFallbackPort: 12345,
        logger: { info: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) } as any,
      });
      handled = proxy.handle(req as any, res as any, layer === 'forwarder-fallback' ? null : { _id: 'test', host: 'map.test', upstreamHost: '127.0.0.1', upstreamPort: 12345, weight: 100 } as any);
    }
    outgoing.emit('error', Object.assign(new Error(`raw failure ${ticket}`), { code: 'ECONNREFUSED' }));
    await handled;
    expect(logs.length).toBeGreaterThan(2);
    expect(JSON.stringify(logs)).not.toContain(ticket);
    expect(req.url).toBe(preview);
  });

  it('keeps the master middleware and activity broadcaster wired to the common log policy', () => {
    const source = fs.readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
    expect(source).toContain('return redactHostedSitePreviewLog(raw)');
    expect(source).toContain('const requestCapture = createBodyCapture(suppressPreviewBody ? 0 : undefined');
    expect(source).toContain('const responseCapture = createBodyCapture(suppressPreviewBody ? 0 : undefined)');
    expect(source).toContain('suppressPreviewBody ? {} : bodyPreviewFromUnknown');
    const index = fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    const activity = index.slice(index.indexOf('proxyService.setOnAccess('), index.indexOf('// ── Build lock'));
    expect(activity).toContain('path: redactHostedSitePreviewLog(reqPath)');
  });

  it.each((['early-failure', 'activity', 'mutation'] as const).flatMap((kind) => [preview.split('?')[0], '/api/hosted-site-preview-access'].map((requestPath) => ({ kind, requestPath }))))('runs the actual master middleware without logging preview secrets: $kind $requestPath', ({ kind, requestPath: reqPath }) => {
    const output: unknown[] = [];
    const req = {
      method: 'POST', originalUrl: `${reqPath}?ticket=${ticket}`, url: reqPath.slice(4), path: reqPath.slice(4),
      headers: { referer: `https://map.test${preview}`, origin: `https://map.test${preview}`, 'content-type': 'application/json' },
      body: { instruction: `private-request-${ticket}` }, query: { ticket }, socket: { remoteAddress: '127.0.0.1' },
    };
    const res = makeResponse();
    res.locals = {};
    res.statusCode = 404;
    const middleware = loadMasterMiddleware(kind, output);
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    res.end(JSON.stringify({ error: `private-response-${ticket}` }));
    expect(output.length).toBeGreaterThan(0);
    expect(JSON.stringify(output)).not.toContain(ticket);
    expect(JSON.stringify(output)).not.toContain('private-request');
    expect(JSON.stringify(output)).not.toContain('private-response');
    expect(req.body.instruction).toContain(ticket);
    expect(res.sent.join('')).toContain(ticket);
  });
});

// Transpile and execute the real registered middleware bodies, not a parallel
// implementation. No createServer(), listeners, authentication calls or sockets.
function loadMasterMiddleware(kind: 'early-failure' | 'activity' | 'mutation', output: unknown[]): (req: any, res: any, next: () => void) => void {
  const source = fs.readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
  const markers = {
    'early-failure': ['// Assign a request id before auth', '// Persistent HTTP log for master/dashboard requests.'],
    activity: ['// ── API activity tracking middleware', '// Instantiate the GitHub App client'],
    mutation: ['// ── Durable control-plane mutation audit', '// ── API activity tracking middleware'],
  }[kind];
  const start = source.indexOf(markers[0]);
  const end = source.indexOf(markers[1], start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const utilities = source.slice(source.indexOf('function shouldAuditApiMutation('), source.indexOf('function normalizeHttpLogPath('))
    + source.slice(source.indexOf('function requestPathForLogs('), source.indexOf('function requestHeadersForLogs('));
  let registered: any;
  const code = ts.transpileModule(utilities + source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  vm.runInNewContext(code, {
    app: { use: (_path: string, fn: unknown) => { registered = fn; } },
    deps: { config: { repoRoot: '/synthetic-no-read' }, stateService: { getBranch: () => undefined }, serverEventLogStore: { record: (value: unknown) => output.push(value) } },
    console: { warn: (...args: unknown[]) => output.push(args) },
    createRequestId: () => 'synthetic-master-request', readBundledCdsCliVersion: () => undefined,
    isHostedSitePreviewRequest, redactHostedSitePreviewLog,
    normalizedSealedStoragePath: () => null, resolveApiLabel: () => 'Synthetic endpoint', activitySeq: 0,
    broadcastActivity: (value: unknown) => output.push(value), getRemoteAddr: () => '127.0.0.1',
    extractApiMutationContext: () => ({}), resolveActorFromRequest: () => 'synthetic-user',
    crypto: { randomUUID: () => 'synthetic-master-request' }, Buffer, URLSearchParams,
  });
  expect(registered).toBeTypeOf('function');
  return registered;
}

function makeResponse() {
  const res = new EventEmitter() as any;
  const headers: Record<string, unknown> = {};
  res.sent = [] as string[];
  Object.assign(res, {
    statusCode: 200, headersSent: false, writableEnded: false,
    setHeader: (key: string, value: unknown) => { headers[key.toLowerCase()] = value; },
    getHeader: (key: string) => headers[key.toLowerCase()], getHeaders: () => ({ ...headers }),
    writeHead: (status: number, values: Record<string, unknown> = {}) => { res.statusCode = status; res.headersSent = true; for (const [key, value] of Object.entries(values)) headers[key.toLowerCase()] = value; },
    write: (chunk: Buffer | string) => { res.sent.push(String(chunk)); return true; },
    end: (chunk?: Buffer | string) => { if (chunk) res.sent.push(String(chunk)); res.writableEnded = true; res.emit('finish'); },
  });
  return res;
}
