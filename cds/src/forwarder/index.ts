/**
 * Forwarder 数据面工厂(B'.2-forwarder)
 *
 * 把 route-resolver / route-watcher / proxy-handler / diagnostic-routes
 * stitch 到一起,提供 createForwarder() 给后续 phase 接 listen。
 *
 * 本批次**不**listen 端口、**不**起独立进程,只导出可组合的 service。
 */

import type { RouteRecord } from './types.js';
import { resolveRoute } from './route-resolver.js';
import { ProxyHandler, type ProxyHandlerOptions } from './proxy-handler.js';
import { RouteWatcher, type RouteWatcherOptions } from './route-watcher.js';
import { createDiagnosticRouter } from './diagnostic-routes.js';

export type RouteResolverFn = (host: string, path: string) => RouteRecord | null;

export {
  resolveRoute,
  hostMatches,
  pathPrefixMatches,
} from './route-resolver.js';
export { RouteWatcher } from './route-watcher.js';
export { ProxyHandler } from './proxy-handler.js';
export { createDiagnosticRouter } from './diagnostic-routes.js';
export type {
  RouteRecord,
  RouteHealthState,
  RoutesHealthState,
  RouteDataSource,
  ProxyStats,
  MongoLike,
  MongoChange,
  WatcherEvent,
  WatcherEventKind,
} from './types.js';

export interface CreateForwarderOptions {
  watcher: RouteWatcherOptions;
  proxy?: ProxyHandlerOptions;
}

export interface ForwarderHandle {
  watcher: RouteWatcher;
  proxy: ProxyHandler;
  resolve: RouteResolverFn;
  diagnosticRouter: ReturnType<typeof createDiagnosticRouter>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * 工厂:返回 watcher + proxy + resolver + diagnostic router 的组合。
 *
 * 调用方仍需自己 createServer / listen / 路由分发,本工厂不掌管端口。
 */
export function createForwarder(opts: CreateForwarderOptions): ForwarderHandle {
  const watcher = new RouteWatcher(opts.watcher);
  const proxy = new ProxyHandler(opts.proxy ?? {});
  const resolve: RouteResolverFn = (host, path) => resolveRoute(watcher.getRoutes(), host, path);
  const diagnosticRouter = createDiagnosticRouter({ watcher, proxy });
  return {
    watcher,
    proxy,
    resolve,
    diagnosticRouter,
    async start(): Promise<void> {
      await watcher.start();
    },
    async stop(): Promise<void> {
      await watcher.stop();
      proxy.destroy();
    },
  };
}
