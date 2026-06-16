/**
 * Forwarder 诊断路由(B'.2-forwarder)
 *
 * 对应 doc/report.cds-forwarder-success.md
 *
 * 三个端点:
 *   - /__forwarder/healthz     :任何 IP 可访问(用于 nginx 健康检查 + 容器探针)
 *   - /__forwarder/routes      :回环 only,dump 当前路由表
 *   - /__forwarder/stats       :回环 only,dump 滑动窗口统计
 *
 * 回环判定**只看** req.socket.remoteAddress;不信任 X-Forwarded-For(因为
 * forwarder 自己处理的就是 X-Forwarded-For,被外网穿透即等于自洞穿)。
 */

import { Router } from 'express';
import type { Request } from 'express';
import type { ProxyHandler } from './proxy-handler.js';
import type { RouteWatcher } from './route-watcher.js';
import type { RouteResolverFn } from './index.js';
import type { HttpActiveRequestFilter, HttpLogRecord, HttpRequestKind } from '../services/http-log-store.js';

export interface DiagnosticRouterOptions {
  watcher: RouteWatcher;
  proxy: ProxyHandler;
  /** 可选:resolver(目前 diagnostic 不主动用,但保留兼容契约) */
  resolver?: RouteResolverFn;
  /** 自定义 isLoopback 判定(测试可注入) */
  isLoopback?: (req: Request) => boolean;
  /** 启动时间戳(ms,默认 Date.now()),用于 uptime 计算 */
  startedAt?: number;
}

const LOOPBACK_RE = /^(127\.|::1$|::ffff:127\.)/;

function defaultIsLoopback(req: Request): boolean {
  const ip = (req.socket?.remoteAddress ?? '').toString();
  if (!ip) return false;
  return LOOPBACK_RE.test(ip);
}

function parseLayer(value: unknown): HttpLogRecord['layer'] | undefined {
  return value === 'master' || value === 'master-proxy' || value === 'forwarder' ? value : undefined;
}

function parseRequestKind(value: unknown): HttpRequestKind | undefined {
  return value === 'user-traffic'
    || value === 'control-plane'
    || value === 'deploy'
    || value === 'container-op'
    || value === 'polling'
    || value === 'sse'
    ? value
    : undefined;
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseActiveFilter(query: Request['query']): HttpActiveRequestFilter {
  const limitRaw = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : undefined;
  const minAgeRaw = typeof query.minAgeMs === 'string' ? Number.parseInt(query.minAgeMs, 10) : undefined;
  return {
    limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
    requestId: stringQuery(query.requestId),
    host: stringQuery(query.host),
    layer: parseLayer(query.layer),
    method: stringQuery(query.method),
    pathContains: stringQuery(query.pathContains) || stringQuery(query.path),
    branchId: stringQuery(query.branchId),
    profileId: stringQuery(query.profileId),
    requestKind: parseRequestKind(query.requestKind),
    minAgeMs: Number.isFinite(minAgeRaw) ? minAgeRaw : undefined,
    sort: query.sort === 'started' ? 'started' : 'age',
  };
}

export function createDiagnosticRouter(opts: DiagnosticRouterOptions): Router {
  const r = Router();
  const startedAt = opts.startedAt ?? Date.now();
  const isLoopback = opts.isLoopback ?? defaultIsLoopback;

  // healthz:任何 IP 可访问
  r.get('/__forwarder/healthz', (_req, res) => {
    const routesHealthState = opts.watcher.healthState();
    const status = routesHealthState === 'live' ? 'ok' : 'degraded';
    res.status(200).json({
      status,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      routesCount: opts.watcher.getRoutes().length,
      routesHealthState,
    });
  });

  // routes:回环 only
  r.get('/__forwarder/routes', (req, res) => {
    if (!isLoopback(req)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const routes = opts.watcher.getRoutes();
    const dataSource = opts.watcher.getDataSource();
    res.status(200).json({
      count: routes.length,
      routesHealthState: opts.watcher.healthState(),
      routes: routes.map((rt) => ({
        _id: rt._id,
        host: rt.host,
        pathPrefix: rt.pathPrefix,
        upstreamHost: rt.upstreamHost,
        upstreamPort: rt.upstreamPort,
        weight: rt.weight,
        healthState: rt.healthState,
        dataSource: rt.dataSource ?? dataSource,
      })),
    });
  });

  // stats:回环 only
  r.get('/__forwarder/stats', (req, res) => {
    if (!isLoopback(req)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const stats = opts.proxy.getStats();
    res.status(200).json({
      totalRequests: stats.totalRequests,
      requestsByHost: stats.requestsByHost,
      statusCounts: stats.statusCounts,
      p50Latency: stats.p50LatencyMs,
      p99Latency: stats.p99LatencyMs,
      last60sRps: stats.last60sRps,
      errorCount: stats.errorCount,
      error503Count: stats.error503Count,
    });
  });

  // active:回环 only。master 用它把 forwarder 进程内的 in-flight 请求合并进
  // /api/http-logs/active 和 /api/perf/overview。
  r.get('/__forwarder/active', (req, res) => {
    if (!isLoopback(req)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const active = opts.proxy.getActiveRequests(parseActiveFilter(req.query));
    res.status(200).json({
      active,
      total: active.length,
      generatedAt: new Date().toISOString(),
    });
  });

  return r;
}
