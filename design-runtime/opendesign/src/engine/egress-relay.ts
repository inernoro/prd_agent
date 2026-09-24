// 模型出口转发口：引擎只拿占位 token，真实的 MAP 模型票据只在这里注入。
//
// 搬迁自 cds/src/services/agent-workspace-session-runtime.ts 的 EGRESS_PROXY_SCRIPT（原来跑在一个单独的
// relay 容器里，别名 map-egress:8787）。现在引擎与本服务同处一个容器，转发口改成本服务进程里的一个
// 只监听 127.0.0.1 的 HTTP 服务。规则逐条不变：
// - 只认 `Bearer <占位 token>`，常量时间比较；
// - 每分钟最多 240 个请求；只放行 GET / POST，路径必须落在 MAP 模型出口的前缀之下；
// - 自己解析 DNS，任何一个解析结果落在私网 / 回环 / 链路本地 / 元数据等保留段即拒绝（502）；
// - 删掉调用方带来的一切凭据头与转发头，换成真实票据；
// - 拒绝 3xx（不跟随、不透传 Location），拒绝 CONNECT 与 upgrade。
import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { validateTransferUrl } from '../workspace/transfer.js';

const DENIED_SUBNETS: ReadonlyArray<readonly [string, number, 'ipv4' | 'ipv6']> = [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'], ['64:ff9b:1::', 48, 'ipv6'], ['100::', 64, 'ipv6'],
  ['2001:10::', 28, 'ipv6'], ['2001:20::', 28, 'ipv6'], ['2001:db8::', 32, 'ipv6'],
  ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['fec0::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
];

const deniedAddresses = new net.BlockList();
for (const [address, prefix, type] of DENIED_SUBNETS) deniedAddresses.addSubnet(address, prefix, type);

/** 解析结果是否落在不允许转发的地址段。解析不出族的一律按拒绝处理（fail closed）。 */
export function isDeniedEgressAddress(address: string): boolean {
  const value = String(address || '').toLowerCase().split('%')[0];
  const family = net.isIP(value);
  if (family === 4) return deniedAddresses.check(value, 'ipv4');
  if (family === 6) {
    if (value.startsWith('::ffff:') && net.isIP(value.slice(7)) === 4) return isDeniedEgressAddress(value.slice(7));
    return deniedAddresses.check(value, 'ipv6');
  }
  return true;
}

const STRIPPED_REQUEST_HEADERS = [
  'authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'apikey',
  'openai-api-key', 'anthropic-api-key', 'x-goog-api-key', 'x-auth-token',
  'x-access-token', 'cookie', 'set-cookie', 'connection', 'proxy-connection',
  'upgrade', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
];

export interface EgressRelayOptions {
  modelBaseUrl: string;
  mapModelTicket: string;
  relayClientToken: string;
  port: number;
  /** 测试注入：默认使用上面的保留段判据。生产代码不传。 */
  isDeniedAddress?: (address: string) => boolean;
  maxRequestsPerMinute?: number;
}

export interface EgressRelay {
  /** 交给 Codex 配置的 base_url（本机地址 + MAP 出口路径）。 */
  readonly proxiedBaseUrl: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startEgressRelay(options: EgressRelayOptions): Promise<EgressRelay> {
  const target = validateTransferUrl(options.modelBaseUrl, 'modelBaseUrl');
  const prefix = target.pathname || '/';
  const isDenied = options.isDeniedAddress ?? isDeniedEgressAddress;
  const maxRequestsPerMinute = options.maxRequestsPerMinute ?? 240;
  const requestStarts: number[] = [];
  const expected = Buffer.from(`Bearer ${options.relayClientToken}`, 'utf8');

  const authorized = (value: unknown): boolean => {
    if (!options.relayClientToken || typeof value !== 'string') return false;
    const actual = Buffer.from(value, 'utf8');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  };
  const admitted = (): boolean => {
    const cutoff = Date.now() - 60_000;
    while (requestStarts.length && requestStarts[0] < cutoff) requestStarts.shift();
    if (requestStarts.length >= maxRequestsPerMinute) return false;
    requestStarts.push(Date.now());
    return true;
  };
  const pathAllowed = (raw: string): boolean => {
    try {
      const pathname = new URL(raw, 'http://relay.invalid').pathname;
      return prefix === '/' || pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
    } catch {
      return false;
    }
  };

  const server = http.createServer((req, res) => {
    if (req.url === '/__health') {
      res.writeHead(options.mapModelTicket && options.relayClientToken ? 204 : 503);
      res.end();
      return;
    }
    if (!authorized(req.headers.authorization)) { res.writeHead(401); res.end(); return; }
    if (!admitted()) { res.writeHead(429, { 'retry-after': '60' }); res.end(); return; }
    if ((req.method !== 'GET' && req.method !== 'POST') || !pathAllowed(req.url || '/')) {
      res.writeHead(403); res.end(); return;
    }
    dns.lookup(target.hostname, { all: true, verbatim: true }, (lookupError, addresses) => {
      if (lookupError || !addresses.length || addresses.some((entry) => isDenied(entry.address))) {
        res.writeHead(502); res.end(); return;
      }
      const selected = addresses[0];
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
      for (const name of STRIPPED_REQUEST_HEADERS) delete headers[name];
      headers.authorization = `Bearer ${options.mapModelTicket}`;
      const transport = target.protocol === 'https:' ? https : http;
      const upstream = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: req.method,
        path: req.url,
        headers,
        lookup: ((_hostname: string, lookupOptions: unknown, callback: (...args: unknown[]) => void) => {
          if (lookupOptions && typeof lookupOptions === 'object' && (lookupOptions as { all?: boolean }).all) {
            callback(null, [selected]);
            return;
          }
          callback(null, selected.address, selected.family);
        }) as unknown as net.LookupFunction,
      }, (upstreamResponse) => {
        if ((upstreamResponse.statusCode || 0) >= 300 && (upstreamResponse.statusCode || 0) < 400) {
          upstreamResponse.resume(); res.writeHead(502); res.end(); return;
        }
        const responseHeaders = { ...upstreamResponse.headers };
        delete responseHeaders.location;
        res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        upstreamResponse.pipe(res);
        // pipe 不会把上游响应体的中断传给下游：MAP 发完响应头后断流，下游要等 90 秒超时才知道。
        // 上游一断就立刻掐掉下游，让 OpenDesign 马上看到这一轮被打断，而不是白等。
        const abortDownstream = () => res.destroy();
        upstreamResponse.on('aborted', abortDownstream);
        upstreamResponse.on('error', abortDownstream);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      upstream.setTimeout?.(90_000, () => upstream.destroy());
      req.pipe(upstream);
    });
  });
  server.maxConnections = 16;
  server.headersTimeout = 10_000;
  server.requestTimeout = 900_000;
  server.keepAliveTimeout = 5_000;
  server.on('connection', (socket) => socket.setTimeout(90_000, () => socket.destroy()));
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const basePath = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');
  return {
    proxiedBaseUrl: `http://127.0.0.1:${port}${basePath}`,
    port,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
