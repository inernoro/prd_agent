import type { Application } from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export interface FixtureTrace { id: string; pid: number; listener: ReturnType<http.Server['address']>;
  arrivals: Array<{ method?: string; url?: string; localAddress?: string; localPort?: number; status?: number }> }
const traces = new WeakMap<http.Server, FixtureTrace>();
export function getHttpFixtureTrace(server: http.Server): FixtureTrace | undefined { return traces.get(server); }
/** 客户端固定访问IPv4，监听也绑定相同地址；端口及身份共同定位这个私有夹具。 */
export function listenLoopbackFixture(app: Application): http.Server {
  const server = app.listen(0, '127.0.0.1');
  const trace: FixtureTrace = { id: randomUUID(), pid: process.pid, listener: server.address(), arrivals: [] };
  traces.set(server, trace);
  server.on('listening', () => { trace.listener = server.address(); });
  server.prependListener('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader('x-cds-fixture-id', trace.id); res.setHeader('x-cds-fixture-pid', String(process.pid));
    const arrival = { method: req.method, url: req.url, localAddress: req.socket.localAddress, localPort: req.socket.localPort, status: 0 };
    if (trace.arrivals.length < 64) trace.arrivals.push(arrival);
    res.on('finish', () => { arrival.status = res.statusCode; });
  });
  return server;
}
