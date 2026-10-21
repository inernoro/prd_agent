import type { Application } from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export interface FixtureTrace { id: string; pid: number; listener: ReturnType<http.Server['address']>;
  arrivals: Array<{ method?: string; url?: string; localAddress?: string; localPort?: number; status?: number; sequence?: number; finished?: boolean }> }
const traces = new WeakMap<http.Server, FixtureTrace>();
export function getHttpFixtureTrace(server: http.Server): FixtureTrace | undefined { return traces.get(server); }
/** 只附加响应归属观察，不改变原监听、请求、Cookie或响应体。 */
export function attachHttpFixtureObservation(server: http.Server): void {
  if (traces.has(server)) return;
  const trace: FixtureTrace = { id: randomUUID(), pid: process.pid, listener: server.address(), arrivals: [] };
  let sequence = 0;
  traces.set(server, trace);
  server.on('listening', () => { trace.listener = server.address(); });
  server.prependListener('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader('x-cds-fixture-id', trace.id); res.setHeader('x-cds-fixture-pid', String(process.pid));
    res.setHeader('x-cds-fixture-request', String(++sequence));
    const arrival = { method: req.method, url: req.url, localAddress: req.socket.localAddress, localPort: req.socket.localPort, status: 0, sequence, finished: false };
    if (trace.arrivals.length < 64) trace.arrivals.push(arrival);
    res.on('finish', () => { arrival.status = res.statusCode; arrival.finished = true; });
  });
}
/** 客户端固定访问IPv4，监听也绑定相同地址；端口及身份共同定位这个私有夹具。 */
export function listenLoopbackFixture(app: Application): http.Server {
  const server = app.listen(0, '127.0.0.1');
  attachHttpFixtureObservation(server);
  return server;
}

export type HttpFixturePhase = 'bootstrap' | 'project-create' | 'auth-local' | 'projects';
export type HttpFixtureEvent = 'end' | 'aborted' | 'response-error' | 'request-error';
type JsonKind = 'empty' | 'invalid' | 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean';
/** 只构造白名单诊断；bytes必须来自data chunk，不从UTF8解码文本反推。 */
export function projectHttpFixtureResponse(server: http.Server, input: {
  phase: HttpFixturePhase; event: HttpFixtureEvent; response?: http.IncomingMessage; raw: string; bytes: number;
}) {
  const trace = traces.get(server), headers = input.response?.headers || {};
  const fixtureIdMatches = !!trace && headers['x-cds-fixture-id'] === trace.id;
  const fixturePidMatches = !!trace && headers['x-cds-fixture-pid'] === String(trace.pid);
  const request = headers['x-cds-fixture-request'];
  const arrival = fixtureIdMatches && fixturePidMatches && typeof request === 'string'
    ? trace!.arrivals.find(item => item.sequence !== undefined && String(item.sequence) === request) : undefined;
  const status = input.response?.statusCode ?? null;
  const length = headers['content-length'];
  let body: any, jsonType: JsonKind = 'empty';
  if (input.raw.length) {
    try {
      body = JSON.parse(input.raw);
      jsonType = body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body as JsonKind;
    } catch { jsonType = 'invalid'; }
  }
  const cookies = headers['set-cookie'] || [];
  const cookieKinds = cookies.map((cookie): 'session' | 'sso' | 'other' => {
    const name = cookie.split('=', 1)[0];
    return name === 'cds_gh_session' ? 'session' : name === 'cds_sso_session' ? 'sso' : 'other';
  });
  const hasUser = !!body?.user && typeof body.user.id === 'string' && body.user.id.length > 0;
  const hasProject = !!body?.project && typeof body.project.id === 'string' && body.project.id.length > 0;
  const code = body?.code ?? body?.error;
  const errorCode = code === undefined ? 'none'
    : ['bootstrap_unavailable', 'username_taken', 'validation', 'duplicate', 'state_save_failed', 'docker'].includes(code) ? code : 'unknown';
  return {
    phase: input.phase, event: input.event, status, complete: input.response?.complete === true, bytes: input.bytes,
    contentLengthMatches: typeof length === 'string' ? /^\d+$/.test(length) && Number(length) === input.bytes : null,
    jsonType, fixtureIdMatches, fixturePidMatches, arrivalMatches: !!arrival,
    finishMatches: !!arrival && arrival.finished === true && arrival.status === status,
    cookieCount: cookies.length, cookieKinds, sessionIndex: cookieKinds.indexOf('session'),
    hasUser, isSystemOwner: hasUser && body.user.isSystemOwner === true, hasProject, errorCode,
  };
}
