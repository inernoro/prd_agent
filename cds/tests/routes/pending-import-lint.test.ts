/**
 * 导入审批的拓扑体检闸门（plan.cds.service-relations 第一批，已拍板：error 级阻断）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { getHttpFixtureTrace, listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';
import { createPendingImportRouter } from '../../src/routes/pending-import.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const requestSequences = new WeakMap<http.Server, number>();
type RequestPhase = 'lint-submit' | 'lint-record' | 'lint-blocked-approve' | 'lint-force-approve'
  | 'calls-submit' | 'calls-approve' | 'consumer-negative';

/** 与既有 HTTP 夹具合同同形，仅记录有限元数据，不输出 URL、正文或原始头。 */
async function request(server: http.Server, method: string, urlPath: string, phase: RequestPhase,
  body?: unknown): Promise<{ status: number; body: any; meta: Record<string, unknown> }> {
  const sequence = (requestSequences.get(server) ?? 0) + 1; requestSequences.set(server, sequence);
  if (!server.listening) await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('测试 HTTP 夹具未就绪');
  const trace = getHttpFixtureTrace(server);
  const arrivals = () => trace?.arrivals.slice(-8).map(arrival => ({ method: arrival.method?.slice(0, 12),
    localAddress: arrival.localAddress, localPort: arrival.localPort, status: arrival.status })) ?? [];
  return new Promise((resolve, reject) => {
    let snapshot: () => Record<string, unknown> = () => ({ phase, sequence, method: method.slice(0, 12),
      fixtureId: trace?.id, fixturePid: trace?.pid, listener: trace?.listener, arrivals: arrivals() });
    const fail = (code: string, error?: unknown) => {
      const detail = error as { name?: unknown; code?: unknown } | undefined;
      const meta = { ...snapshot(), ...(error ? { transportError: {
        name: typeof detail?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(detail.name) ? detail.name : 'Error',
        code: typeof detail?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(detail.code) ? detail.code : null,
      } } : {}) };
      console.info('[pending-import-http-failure]', JSON.stringify({ code, ...meta }));
      reject(Object.assign(new Error('测试 HTTP 响应未满足夹具契约'), { code, meta }));
    };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({ hostname: '127.0.0.1', port: addr.port, agent: false, path: urlPath, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
    (res) => {
      const chunks: Buffer[] = [];
      let rawBytes = 0, parseKind = 'empty';
      const socket = { localAddress: res.socket?.localAddress, localPort: res.socket?.localPort,
        remoteAddress: res.socket?.remoteAddress, remotePort: res.socket?.remotePort };
      const id = res.headers['x-cds-fixture-id'], pid = res.headers['x-cds-fixture-pid'];
      const contentType = res.headers['content-type'], length = res.headers['content-length'];
      snapshot = () => ({ phase, sequence, method: method.slice(0, 12), status: res.statusCode || 0, rawBytes, parseKind,
        complete: res.complete, reusedSocket: !!req.reusedSocket,
        contentType: typeof contentType === 'string' && /^application\/json(?:\s*;|$)/i.test(contentType) ? 'json' : contentType === undefined ? 'missing' : 'other',
        declaredBytes: typeof length === 'string' && /^\d{1,10}$/.test(length) ? Number(length) : null,
        responseFixtureId: typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? id : id === undefined ? 'missing' : 'invalid',
        responseFixturePid: typeof pid === 'string' && /^\d{1,10}$/.test(pid) ? Number(pid) : null,
        fixtureId: trace?.id, fixturePid: trace?.pid, listener: trace?.listener, socket, arrivals: arrivals() });
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); rawBytes += chunk.length; });
      res.on('aborted', () => fail('response_aborted'));
      res.on('error', error => fail('response_error', error));
      res.on('end', () => {
        let parsed: any;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); parseKind = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed; }
        catch { parseKind = rawBytes ? 'invalid-json' : 'empty'; }
        const meta = snapshot();
        if (!res.complete) return fail('incomplete_response');
        if (!trace || id !== trace.id || pid !== String(trace.pid)) return fail('fixture_identity');
        if (meta.contentType !== 'json' || parseKind === 'invalid-json' || parseKind === 'empty') return fail('invalid_json');
        resolve({ status: res.statusCode || 0, body: parsed, meta });
      });
    });
    req.on('error', error => fail('request_error', error));
    if (payload) req.write(payload);
    req.end();
  });
}

const BAD_YAML = `
services:
  admin:
    image: node:20
    working_dir: /app
    volumes:
      - ./admin:/app
    command: node server.js
    ports: ["3000"]
    labels:
      cds.path-prefix: "/"
      cds.readiness-path: "/"
  api-a:
    image: node:20
    working_dir: /app
    volumes:
      - ./a:/app
    command: node a.js
    ports: ["8080"]
    labels:
      cds.path-prefix: "/api/,/open/,/health"
  api-b:
    image: node:20
    working_dir: /app
    volumes:
      - ./b:/app
    command: node b.js
    ports: ["8081"]
    labels:
      cds.path-prefix: "/open/"
`;

const CALLS_YAML = `
services:
  web:
    image: node:20
    working_dir: /app
    volumes:
      - ./web:/app
    command: node web.js
    ports: ["3000"]
    labels:
      cds.path-prefix: "/"
      cds.readiness-path: "/"
      cds.calls: "api, worker"
  api:
    image: node:20
    working_dir: /app
    volumes:
      - ./api:/app
    command: node api.js
    ports: ["8080"]
    labels:
      cds.path-prefix: "/api/"
  worker:
    image: node:20
    working_dir: /app
    volumes:
      - ./worker:/app
    command: node worker.js
    ports: ["9000"]
    labels:
      cds.role: "worker"
`;

describe('pending-import 拓扑体检闸门', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pi-lint-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj1', slug: 'sample', name: 'Sample', kind: 'git', cloneStatus: 'ready', createdAt: now, updatedAt: now });
    const app = express();
    app.use(express.json());
    app.use('/api', createPendingImportRouter({ stateService }));
    server = listenLoopbackFixture(app);
    if (!server.listening) await once(server, 'listening');
  });
  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('提交不拒绝但把体检挂在记录上；审批被 error 级阻断；force 放行', async () => {
    const create = await request(server, 'POST', '/api/projects/proj1/pending-import', 'lint-submit', { agentName: 'A', composeYaml: BAD_YAML });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const record = await request(server, 'GET', `/api/pending-imports/${create.body.importId}`, 'lint-record');
    expect(record.body.import.lint.summary.errors).toBe(2);

    const blocked = await request(server, 'POST', `/api/pending-imports/${create.body.importId}/approve`, 'lint-blocked-approve');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('topology_lint_blocked');
    expect(blocked.body.lint.findings.map((f: { rule: string }) => f.rule)).toEqual(expect.arrayContaining(['prefix-conflict', 'probe-in-prefix']));
    expect(stateService.getPendingImport(create.body.importId)?.status).toBe('pending');

    const forced = await request(server, 'POST', `/api/pending-imports/${create.body.importId}/approve`, 'lint-force-approve', { force: true });
    expect(forced.status).toBe(200);
  });

  it('审批给 profile id 加项目后缀时，cds.calls 指向的服务名跟着加后缀（边不落空）', async () => {
    const create = await request(server, 'POST', '/api/projects/proj1/pending-import', 'calls-submit', { agentName: 'A', composeYaml: CALLS_YAML });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const approved = await request(server, 'POST', `/api/pending-imports/${create.body.importId}/approve`, 'calls-approve');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(stateService.getBuildProfile('web-sample')?.calls).toEqual(['api-sample', 'worker-sample']);
    expect(stateService.getBuildProfile('api-sample')).toBeTruthy();
    expect(stateService.getBuildProfile('api')).toBeUndefined();
  });
});

describe('pending-import 请求消费者的完整 HTTP 反例', () => {
  it.each([
    { name: '完整响应但 fixture 身份错误', raw: '{"ok":true}', wrongIdentity: true, parseKind: 'object', code: 'fixture_identity' },
    { name: '完整 JSON 类型响应但 JSON 字节损坏', raw: '{"broken":', wrongIdentity: false, parseKind: 'invalid-json', code: 'invalid_json' },
  ])('原请求消费者应拒绝 $name', async ({ raw, wrongIdentity, parseKind, code }) => {
    let finished = false, received = '';
    let wire: Record<string, unknown> | undefined;
    let restoreRequest = () => {};
    const foreignId = randomUUID();
    const peerApp = express();
    peerApp.use((_req, res) => {
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', Buffer.byteLength(raw));
      if (wrongIdentity) res.setHeader('x-cds-fixture-id', foreignId);
      res.on('finish', () => { finished = true; }); res.end(raw);
    });
    const peer = listenLoopbackFixture(peerApp);
    try {
      if (!peer.listening) await once(peer, 'listening');
      const trace = getHttpFixtureTrace(peer)!;
      expect(trace.listener).toMatchObject({ address: '127.0.0.1', port: expect.any(Number) });
      if (wrongIdentity) expect(foreignId).not.toBe(trace.id);
      // 仅旁观旧 request 返回的真实 ClientRequest；参数、回调、返回值和错误均原样透传。
      const realRequest = http.request;
      const observer = vi.spyOn(http, 'request').mockImplementation(((...args: unknown[]) => {
        const client = Reflect.apply(realRequest, http, args) as http.ClientRequest;
        client.once('response', res => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
          res.on('end', () => {
            const bytes = Buffer.concat(chunks); received = bytes.toString('utf8');
            let actualKind: string;
            try { const parsed = JSON.parse(received); actualKind = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed; }
            catch { actualKind = bytes.length ? 'invalid-json' : 'empty'; }
            const id = res.headers['x-cds-fixture-id'], pid = res.headers['x-cds-fixture-pid'];
            const contentType = res.headers['content-type'], length = res.headers['content-length'];
            wire = { status: res.statusCode || 0, complete: res.complete, rawBytes: bytes.length, parseKind: actualKind,
              contentType: typeof contentType === 'string' && /^application\/json(?:\s*;|$)/i.test(contentType) ? 'json' : 'other',
              declaredBytes: typeof length === 'string' && /^\d{1,10}$/.test(length) ? Number(length) : null,
              responseFixtureId: typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? id : 'invalid',
              responseFixturePid: typeof pid === 'string' && /^\d{1,10}$/.test(pid) ? Number(pid) : null };
          });
        });
        return client;
      }) as typeof http.request);
      restoreRequest = () => { observer.mockRestore(); };
      const outcome = await request(peer, 'GET', '/consumer-negative', 'consumer-negative').then(response => ({ response, error: undefined }),
        error => ({ response: undefined, error }));
      expect(finished).toBe(true); expect(trace.arrivals).toHaveLength(1); expect(trace.arrivals[0].status).toBe(200);
      expect(trace.arrivals[0].localAddress).toBe('127.0.0.1');
      expect(received).toBe(raw);
      expect(wire).toMatchObject({ status: 200, complete: true, rawBytes: Buffer.byteLength(raw), declaredBytes: Buffer.byteLength(raw),
        contentType: 'json', parseKind, responseFixtureId: wrongIdentity ? foreignId : trace.id, responseFixturePid: trace.pid });
      console.info('[pending-import-negative-response]', JSON.stringify({ wire, fixtureId: trace.id, fixturePid: trace.pid,
        listener: trace.listener, arrivals: trace.arrivals.slice(-8).map(arrival => ({ method: arrival.method?.slice(0, 12),
          localAddress: arrival.localAddress, localPort: arrival.localPort, status: arrival.status })) }));
      expect(outcome).toHaveProperty('error', expect.objectContaining({ code }));
      expect(outcome.error?.meta).toMatchObject({ status: 200, complete: true, rawBytes: Buffer.byteLength(raw), contentType: 'json', parseKind });
    } finally {
      restoreRequest();
      await new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve()));
    }
  });
});
