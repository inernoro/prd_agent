/**
 * CDS Forwarder — 数据面独立进程入口（B'.2-forwarder MVP, 2026-05-08）
 *
 * 与 cds-master 完全解耦的反向代理。监听 CDS_FORWARDER_PORT（默认 9090），
 * 把 nginx 透传过来的 *.miduo.org 流量路由到对应的分支容器端口。
 *
 * 设计要点：
 *   - 路由表 SSOT：`<repo>/cds/.cds/forwarder-routes.json`，由 cds-master
 *     周期性发布（ForwarderRoutePublisher）；mongo change-stream 是后续
 *     升级路径，不在 MVP 范围。
 *   - 业务 0 抖动：本进程不参与 self-update 路径，cds-master 重启时它
 *     依然在 listen + 转发。systemd Restart=always 保底。
 *   - 透明代理：复用 cds/src/forwarder/{proxy-handler,route-resolver}，
 *     不重新发明轮子。
 *   - 文件 watch：fs.watch 监听 JSON 变更，debounce 200ms 后重新加载，
 *     不需要重启进程。
 *
 * 替代了 cds-master 历史职责中"workerPort 反向代理"那一份。cds-master
 * 启动时若读到 CDS_USE_FORWARDER=1 就跳过 worker server listen，避免
 * 端口竞争。
 *
 * 历史背景：2026-05-08 蓝绿部署 27 个 hotfix 仍未跑通 verify-target，
 * 用户决策"放弃蓝绿，今天推 forwarder 替代"。蓝绿代码保留但默认禁用
 * 详见 doc/report.cds-forwarder-success.md。
 */

import './load-env.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ProxyHandler } from './forwarder/proxy-handler.js';
import { resolveRoute } from './forwarder/route-resolver.js';
import type { RouteRecord } from './forwarder/types.js';
import { buildForwarderWaitingPageHtml } from './forwarder/waiting-page.js';
import { httpLogStoreFromEnv } from './services/http-log-store.js';

const FORWARDER_PORT = Number.parseInt(
  process.env.CDS_FORWARDER_PORT ?? '9090',
  10,
);
const ROUTES_JSON_DEFAULT = path.resolve(
  process.cwd(),
  '.cds',
  'forwarder-routes.json',
);
const ROUTES_JSON = process.env.CDS_FORWARDER_ROUTES_JSON ?? ROUTES_JSON_DEFAULT;
const RELOAD_DEBOUNCE_MS = 200;

const startedAt = Date.now();
let routes: RouteRecord[] = [];
let routesSource: 'json' | 'empty' = 'empty';
let routesLoadedAt: number = 0;
let routesError: string | null = null;

const MASTER_PASSTHROUGH_HOST = process.env.CDS_MASTER_PASSTHROUGH_HOST ?? '127.0.0.1';
const MASTER_PASSTHROUGH_PORT = Number.parseInt(
  process.env.CDS_MASTER_PASSTHROUGH_PORT ?? process.env.CDS_MASTER_PORT ?? '9900',
  10,
);
// Unknown host fallback:转给 master worker port(默认 5500)让它显示丰富等候页/错误页。
// 设 0 关闭 fallback,走 forwarder 内置 plain 503。
const FALLBACK_HOST = process.env.CDS_UNKNOWN_HOST_FALLBACK_HOST ?? '127.0.0.1';
const FALLBACK_PORT_RAW = process.env.CDS_UNKNOWN_HOST_FALLBACK_PORT ?? process.env.CDS_WORKER_PORT ?? '5500';
const FALLBACK_PORT = Number.parseInt(FALLBACK_PORT_RAW, 10);

let activeHttpLogStore = httpLogStoreFromEnv();
if (activeHttpLogStore) {
  try {
    await activeHttpLogStore.init();
    console.log('[forwarder] persistent HTTP request logging enabled (collection=cds_http_logs)');
  } catch (err) {
    activeHttpLogStore = null;
    console.warn(`[forwarder] HTTP request logging disabled: ${(err as Error).message}`);
  }
}

const proxy = new ProxyHandler({
  upstreamTimeoutMs: 30_000,
  masterPassthroughHost: MASTER_PASSTHROUGH_HOST,
  masterPassthroughPort: MASTER_PASSTHROUGH_PORT,
  unknownHostFallbackHost: FALLBACK_PORT > 0 ? FALLBACK_HOST : undefined,
  unknownHostFallbackPort: FALLBACK_PORT > 0 ? FALLBACK_PORT : undefined,
  waitingPageHtml: buildForwarderWaitingPageHtml(),
  httpLogStore: activeHttpLogStore,
  logger: {
    info: (m) => console.log(`[forwarder] ${m}`),
    warn: (m) => console.warn(`[forwarder] ${m}`),
    error: (m) => console.error(`[forwarder] ${m}`),
  },
});

function loadRoutes(): void {
  try {
    if (!fs.existsSync(ROUTES_JSON)) {
      routes = [];
      routesSource = 'empty';
      routesLoadedAt = Date.now();
      routesError = null;
      console.warn(
        `[forwarder] routes JSON not found at ${ROUTES_JSON} — empty table (cds-master will publish soon)`,
      );
      return;
    }
    const txt = fs.readFileSync(ROUTES_JSON, 'utf8');
    const parsed = JSON.parse(txt);
    if (!Array.isArray(parsed)) throw new Error('routes JSON is not an array');
    routes = parsed as RouteRecord[];
    routesSource = 'json';
    routesLoadedAt = Date.now();
    routesError = null;
    console.log(`[forwarder] loaded ${routes.length} routes from ${ROUTES_JSON}`);
  } catch (err) {
    routesError = (err as Error).message;
    console.error(`[forwarder] failed to load routes: ${routesError}`);
  }
}

let reloadTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReload(reason: string): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    console.log(`[forwarder] reload triggered (${reason})`);
    loadRoutes();
  }, RELOAD_DEBOUNCE_MS);
}

function watchRoutesJson(): void {
  const dir = path.dirname(ROUTES_JSON);
  const base = path.basename(ROUTES_JSON);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.watch(dir, (event, filename) => {
      if (filename === base) scheduleReload(`${event}:${filename}`);
    });
    console.log(`[forwarder] watching ${ROUTES_JSON} for changes`);
  } catch (err) {
    console.warn(
      `[forwarder] fs.watch failed (${(err as Error).message}); falling back to 5s poll`,
    );
    setInterval(() => scheduleReload('poll'), 5000).unref?.();
  }
}

function handleDiagnostic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  // 用 path(去掉 query string)做匹配,Cursor Bugbot Low:监控/LB 加 cache-bust
  // 参数 `?v=1` 时原 url === '/path' 不匹配,fallthrough 到 404。
  const rawUrl = req.url ?? '';
  if (!rawUrl.startsWith('/__forwarder/')) return false;
  const url = rawUrl.split('?')[0];
  // Cursor Bugbot Medium 安全:forwarder 在 nginx 后面时 remoteAddress 永远是
  // 127.0.0.1(nginx)→ 老 isLoopback 检查永远 true → 公网用户能 dump 完整路由
  // 表(branchId/branchName/upstreamPort 全泄露)。新检查:**同时**要求 socket
  // remote 是 loopback **且** Host header 是内部域名(127.0.0.1/localhost),这样
  // nginx 转过来的 host=*.miduo.org 直接被拒,只允许运维 SSH 后直连 9090 调用。
  const remoteAddr = (req.socket?.remoteAddress ?? '') as string;
  const remoteIsLoopback = /^(127\.|::1$|::ffff:127\.)/.test(remoteAddr);
  const hostHeader = (req.headers.host ?? '').split(':')[0].toLowerCase();
  const hostIsInternal = hostHeader === '127.0.0.1' || hostHeader === 'localhost' || hostHeader === '::1';
  const isLoopback = remoteIsLoopback && hostIsInternal;
  if (url === '/__forwarder/healthz') {
    const stats = proxy.getStats();
    const body = {
      status: routesError ? 'degraded' : 'ok',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      routesCount: routes.length,
      routesSource,
      routesError,
      routesLoadedAt,
      port: FORWARDER_PORT,
      totalRequests: stats.totalRequests,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  }
  if (url === '/__forwarder/routes') {
    if (!isLoopback) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        count: routes.length,
        source: routesSource,
        loadedAt: routesLoadedAt,
        path: ROUTES_JSON,
        routes,
      }),
    );
    return true;
  }
  if (url === '/__forwarder/stats') {
    if (!isLoopback) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(proxy.getStats()));
    return true;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unknown forwarder endpoint' }));
  return true;
}

const server = http.createServer((req, res) => {
  if (handleDiagnostic(req, res)) return;
  const host = (req.headers.host ?? '').split(':')[0];
  const route = resolveRoute(routes, host, req.url ?? '/');
  void proxy.handle(req, res, route);
});

server.on('upgrade', (req, socket, head) => {
  const host = (req.headers.host ?? '').split(':')[0];
  const route = resolveRoute(routes, host, req.url ?? '/');
  void proxy.handleUpgrade(req, socket as import('node:net').Socket, head, route);
});

function shutdown(signal: string): void {
  console.log(`[forwarder] received ${signal}, draining...`);
  server.close(() => {
    proxy.destroy();
    const done = () => process.exit(0);
    if (!activeHttpLogStore) {
      done();
      return;
    }
    void activeHttpLogStore.close()
      .catch((err) => console.warn(`[forwarder] HTTP log store close failed: ${(err as Error).message}`))
      .finally(done);
  });
  setTimeout(() => {
    console.warn('[forwarder] graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loadRoutes();
watchRoutesJson();

// 2026-05-28 keepalive 匹配修复(同 cds/src/index.ts:listenWithRetry):
// nginx 反代到本进程时 idle pool 默认 60s,Node http.Server.keepAliveTimeout
// 默认 5s。5s 后 Node 主动 FIN socket,nginx 仍以为可复用 → 下条请求 recv RST
// → 50% 4xx/5xx。把 Node 阈值提到大于 nginx 才避免。Node ≥ 18 同时要求
// headersTimeout >= keepAliveTimeout。
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(FORWARDER_PORT, () => {
  console.log(
    `[forwarder] listening on :${FORWARDER_PORT} (routes: ${routes.length} from ${routesSource}) keepAlive=${server.keepAliveTimeout}ms`,
  );
});
