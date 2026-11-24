import { it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import * as fixture from './loopback-http-fixture.js';

const SENTINEL = 'private-fixture-sensitive-sentinel';
type EvidenceInput = {
  phase: 'bootstrap' | 'project-create'; event: 'end'; response: http.IncomingMessage; raw: string; bytes: number;
};
// 旧模块仍可正常载入；缺能力须在真实HTTP往返之后报告工程RED，而非缺导出编译红。
const planned = fixture as typeof fixture & {
  attachHttpFixtureObservation?: (server: http.Server) => void;
  projectHttpFixtureResponse?: (server: http.Server, input: EvidenceInput) => Record<string, unknown>;
};
const allowedKeys = new Set([
  'phase', 'event', 'status', 'complete', 'bytes', 'contentLengthMatches', 'jsonType',
  'fixtureIdMatches', 'fixturePidMatches', 'arrivalMatches', 'finishMatches',
  'cookieCount', 'cookieKinds', 'sessionIndex', 'hasUser', 'isSystemOwner', 'hasProject', 'errorCode',
]);

function readResponse(server: http.Server): Promise<{ response: http.IncomingMessage; raw: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request({ hostname: '127.0.0.1', port: addr.port, path: `/?secret=${SENTINEL}` }, response => {
      let raw = '', bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; raw += chunk.toString(); });
      response.on('end', () => resolve({ response, raw, bytes }));
      response.on('aborted', () => reject(new Error('fixture-response-aborted')));
      response.on('error', () => reject(new Error('fixture-response-error')));
    });
    req.on('error', () => reject(new Error('fixture-request-error')));
    req.end();
  });
}

it.each([
  ['bootstrap', 200, 'object'], ['project', 201, 'object'], ['empty', 503, 'empty'],
  ['null', 201, 'null'], ['denied', 403, 'object'], ['foreign', 200, 'object'],
] as const)('真实HTTP安全响应取证：%s', async (mode, status, jsonType) => {
  const app = express();
  app.get('/', (_req, res) => {
    res.setHeader('x-sensitive-test', SENTINEL);
    res.setHeader('Set-Cookie', [
      `cds_sso_session=${SENTINEL}; Max-Age=0`,
      `cds_gh_session=${SENTINEL}; HttpOnly`, `${SENTINEL}=${SENTINEL}`,
    ]);
    if (mode === 'foreign') {
      res.setHeader('x-cds-fixture-id', SENTINEL);
      res.setHeader('x-cds-fixture-pid', String(process.pid + 1));
    }
    if (mode === 'empty') { res.setHeader('Content-Length', '0'); res.status(status).end(); return; }
    if (mode === 'null') { res.status(status).json(null); return; }
    const body = mode === 'denied' ? { error: SENTINEL }
      : mode === 'project' ? { project: { id: SENTINEL, name: SENTINEL } }
      : { user: { id: SENTINEL, isSystemOwner: true, passwordHash: SENTINEL, passwordSalt: SENTINEL } };
    res.status(status).json({ ...body, token: SENTINEL, password: SENTINEL });
  });
  // 保留原listen(0)；组件自身等待监听完成，不改两个原业务客户端的时序/agent。
  const server = app.listen(0);
  let arrivals = 0, finishes = 0;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  server.prependListener('request', (_req, res) => {
    arrivals++;
    res.on('finish', () => { finishes++; finish(); });
  });
  planned.attachHttpFixtureObservation?.(server);
  try {
    if (!server.address()) await once(server, 'listening');
    const { response, raw, bytes } = await readResponse(server);
    await finished;
    expect(arrivals === 1).toBe(true);
    expect(finishes === 1).toBe(true);
    expect(response.complete === true).toBe(true);
    expect(response.statusCode === status).toBe(true);
    expect(typeof planned.attachHttpFixtureObservation === 'function').toBe(true);
    expect(fixture.getHttpFixtureTrace(server) !== undefined).toBe(true);
    expect(typeof planned.projectHttpFixtureResponse === 'function').toBe(true);
    const phase = mode === 'project' || mode === 'null' ? 'project-create' : 'bootstrap';
    const evidence = planned.projectHttpFixtureResponse!(server, { phase, event: 'end', response, raw, bytes });
    // 失败输出也只出现布尔值，不把敏感哨兵、body、Cookie或任意新增字段打印进断言。
    expect(JSON.stringify(evidence).includes(SENTINEL)).toBe(false);
    expect(Object.keys(evidence).every(key => allowedKeys.has(key))).toBe(true);
    expect(evidence.phase === phase && evidence.event === 'end').toBe(true);
    expect(evidence.status === status && evidence.complete === true).toBe(true);
    expect(evidence.bytes === Buffer.byteLength(raw) && evidence.contentLengthMatches === true).toBe(true);
    expect(evidence.jsonType === jsonType).toBe(true);
    const owned = mode !== 'foreign';
    expect(evidence.fixtureIdMatches === owned && evidence.fixturePidMatches === owned).toBe(true);
    expect(evidence.arrivalMatches === owned && evidence.finishMatches === owned).toBe(true);
    expect(evidence.cookieCount === 3 && evidence.sessionIndex === 1).toBe(true);
    expect(JSON.stringify(evidence.cookieKinds) === '["sso","session","other"]').toBe(true);
    const hasUser = mode === 'bootstrap' || mode === 'foreign';
    expect(evidence.hasUser === hasUser && evidence.isSystemOwner === hasUser).toBe(true);
    expect(evidence.hasProject === (mode === 'project')).toBe(true);
    expect(evidence.errorCode === (mode === 'denied' ? 'unknown' : 'none')).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(new Error('fixture-close-error')) : resolve()));
  }
});

it('固定IPv4客户端对应的监听拒绝同地址同端口竞争者', async () => {
  let arrivals = 0;
  const app = express();
  app.get('/', (_req, res) => { arrivals++; res.json({ project: { id: 'owned-response' } }); });
  const server = fixture.listenLoopbackFixture(app);
  const competing = http.createServer((_req, res) => { res.statusCode = 503; res.end(); });
  try {
    if (!server.address()) await once(server, 'listening');
    const address = server.address() as { port: number; address: string; family: string };
    expect(address.family === 'IPv4' && address.address === '127.0.0.1').toBe(true);
    const outcome = await new Promise<string>(resolve => {
      competing.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'EADDRINUSE' ? 'EADDRINUSE' : 'other'));
      competing.listen(address.port, '127.0.0.1', () => resolve('unexpected-listening'));
    });
    expect(outcome).toBe('EADDRINUSE');
    const { response, raw, bytes } = await readResponse(server);
    const evidence = planned.projectHttpFixtureResponse!(server, { phase: 'project-create', event: 'end', response, raw, bytes });
    expect(response.statusCode === 200 && arrivals === 1 && evidence.hasProject
      && evidence.fixtureIdMatches && evidence.fixturePidMatches && evidence.arrivalMatches && evidence.finishMatches,
    JSON.stringify(evidence)).toBe(true);
    expect(JSON.stringify(evidence).includes(SENTINEL)).toBe(false);
  } finally {
    for (const owned of [competing, server]) {
      if (owned.listening) await new Promise<void>(resolve => owned.close(() => resolve()));
    }
  }
});
