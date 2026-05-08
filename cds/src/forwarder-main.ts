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
 * （CDS_USE_BLUE_GREEN 默认 off）。详见 doc/handoff.cds-blue-green.md。
 */

import './load-env.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ProxyHandler } from './forwarder/proxy-handler.js';
import { resolveRoute } from './forwarder/route-resolver.js';
import type { RouteRecord } from './forwarder/types.js';

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

const proxy = new ProxyHandler({
  upstreamTimeoutMs: 30_000,
  masterPassthroughHost: MASTER_PASSTHROUGH_HOST,
  masterPassthroughPort: MASTER_PASSTHROUGH_PORT,
  waitingPageHtml: '<!doctype html><meta charset="utf-8"><title>Branch warming up</title><body style="font-family:sans-serif;padding:2rem"><h1>预览环境准备中</h1><p>分支正在启动或重新构建，几秒后自动恢复。本页面 3 秒后自动刷新。</p><script>setTimeout(()=>location.reload(),3000)</script>',
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
  const url = req.url ?? '';
  if (!url.startsWith('/__forwarder/')) return false;
  const isLoopback = ((req.socket?.remoteAddress ?? '') as string).match(
    /^(127\.|::1$|::ffff:127\.)/,
  );
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
    process.exit(0);
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

server.listen(FORWARDER_PORT, () => {
  console.log(
    `[forwarder] listening on :${FORWARDER_PORT} (routes: ${routes.length} from ${routesSource})`,
  );
});
