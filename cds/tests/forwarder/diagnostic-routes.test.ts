/**
 * Forwarder 诊断路由 — TDD 契约
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md 维度 4.2 / 7.2
 * 实现位置(尚未存在):cds/src/forwarder/diagnostic-routes.ts
 *
 * Forwarder 自身暴露 /__forwarder/* 给运维诊断,只接受回环(127.0.0.1)。
 */
import { describe, it } from 'vitest';

describe('Forwarder /__forwarder/healthz', () => {
  it.todo('[C-7.2] 200 + JSON { status: "ok", uptime, routesCount, routesHealthState }');
  it.todo('[C-7.2] mongo 断线时 status="degraded",routesHealthState="fallback"');
});

describe('Forwarder /__forwarder/routes', () => {
  it.todo('[C-7.2] 返回当前内存路由表完整 dump(host / pathPrefix / upstreamPort / weight / healthState)');
  it.todo('[C-7.2] 每条记录带 dataSource 字段(mongo / json-fallback)');
  it.todo('[C-4.2] 非回环 IP 请求返回 403');
  it.todo('[C-4.2] 通过 X-Forwarded-For 伪造来源仍然 403(只信 socket remoteAddress)');
});

describe('Forwarder /__forwarder/stats', () => {
  it.todo('[C-7.2] 返回 schema:{ totalRequests, requestsByHost, statusCounts, p50Latency, p99Latency, last60sRps }');
  it.todo('[C-7.2] 503 错误数单独统计(便于运维盯)');
  it.todo('[C-7.2] 每个 host 的命中数单独统计');
  it.todo('[C-4.2] 非回环 IP 拒绝');
});
