import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { RouteRecord } from '../forwarder/types.js';
import type { ForwarderRoutePublisher } from './forwarder-route-publisher.js';

function routingKey(route: RouteRecord): string {
  return JSON.stringify([route._id, route.host, route.pathPrefix || '/', route.upstreamHost || '127.0.0.1',
    route.upstreamPort, route.branchId, route.profileId, route.weight, route.replicaGroup || '',
    route.replicaMemberId || '', route.preserveHost === true, route.healthState || 'unknown']);
}

/** Full branch multiset equality, including aliases/replicas and foreign records occupying its hosts. */
export function branchRoutesAcknowledged(branchId: string, expected: readonly RouteRecord[], actual: readonly RouteRecord[]): boolean {
  const desired = expected.filter(route => route.branchId === branchId);
  if (!desired.length) return false; // A no-route worker replacement needs a separate explicit readiness contract.
  const hosts = new Set(desired.map(route => route.host));
  const relevant = actual.filter(route => route.branchId === branchId || hosts.has(route.host));
  return JSON.stringify(desired.map(routingKey).sort()) === JSON.stringify(relevant.map(routingKey).sort());
}

function readConsumer(port: number, timeoutMs: number, signal?: AbortSignal): Promise<RouteRecord[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('route_ack_cancelled')); return; }
    let settled = false; let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, routes?: RouteRecord[]) => {
      if (settled) return; settled = true; if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(routes!);
    };
    const fail = (error: Error) => { finish(error); request.destroy(); };
    const abort = () => fail(new Error('route_ack_cancelled'));
    const request = http.get({ hostname: '127.0.0.1', port, path: '/__forwarder/routes', agent: false }, response => {
      if (response.statusCode !== 200) { fail(new Error('route_ack_status')); response.destroy(); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { fail(new Error('route_ack_size')); response.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on('error', fail);
      response.on('aborted', () => fail(new Error('route_ack_truncated')));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!Array.isArray(body.routes) || !body.routes.every((route: any) => route && typeof route._id === 'string' &&
            typeof route.host === 'string' && Number.isInteger(route.upstreamPort) && route.upstreamPort > 0 && route.upstreamPort <= 65535 &&
            typeof route.weight === 'number' && Number.isFinite(route.weight) && route.weight >= 0 && route.weight <= 100)) throw new Error('route_ack_schema');
          finish(undefined, body.routes);
        } catch (error) { finish(error as Error); }
      });
    });
    // An absolute deadline also bounds a response that keeps trickling bytes.
    timer = setTimeout(() => fail(new Error('route_ack_timeout')), timeoutMs);
    request.on('error', error => finish(error));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Loopback data-plane proof. Neither publishNow() nor a route count can satisfy it. */
export class ForwarderRouteAcknowledgement {
  constructor(private readonly publisher: Pick<ForwarderRoutePublisher, 'getDesiredRoutes' | 'publishNow'>, private readonly port: number) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('route_ack_port');
  }

  async wait(branchId: string, options: { signal?: AbortSignal; timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
    const expected = this.publisher.getDesiredRoutes().filter(route => route.branchId === branchId).map(route => ({ ...route }));
    if (!expected.length || options.signal?.aborted) return false;
    const deadline = Date.now() + Math.max(1, options.timeoutMs ?? 10_000);
    while (Date.now() < deadline && !options.signal?.aborted) {
      // A concurrent state change cannot silently redefine the acknowledgement target.
      if (!branchRoutesAcknowledged(branchId, expected, this.publisher.getDesiredRoutes())) return false;
      this.publisher.publishNow();
      try {
        const routes = await readConsumer(this.port, Math.min(1000, Math.max(1, deadline - Date.now())), options.signal);
        if (!options.signal?.aborted && branchRoutesAcknowledged(branchId, expected, routes) &&
          branchRoutesAcknowledged(branchId, expected, this.publisher.getDesiredRoutes())) return true;
      } catch { /* Retry until the bounded deadline; no acknowledgement is inferred from read failure. */ }
      try { await delay(Math.min(Math.max(1, options.intervalMs ?? 100), Math.max(1, deadline - Date.now())), undefined, { signal: options.signal }); }
      catch { return false; }
    }
    return false;
  }
}
