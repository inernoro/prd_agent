/**
 * uptime — 自建存活监控的只读 API（状态页数据源）。
 *
 * 鉴权：不自造中间件。本路由挂在 `/api` 前缀下，走 server.ts 已有的全局
 * 登录网关（cookie / SSO / agent key），与 docker-network-health 等同款。
 *
 * 三个端点：
 *   GET /api/uptime/summary?segments=90        全量摘要（含柱条，状态页一次拉完）
 *   GET /api/uptime/targets/:id/history?range= 单 target 时序（已降采样）
 *   GET /api/uptime/incidents?limit=50         由连续失败自动合成的故障时间线
 */

import { Router } from 'express';
import {
  DEFAULT_BAR_SEGMENTS,
  MAX_HISTORY_POINTS,
  parseRange,
  resolveBucketCount,
} from '../services/uptime-metrics.js';
import type { UptimeMonitorService } from '../services/uptime-monitor.js';

export function createUptimeRouter(deps: { monitor: UptimeMonitorService }): Router {
  const router = Router();

  router.get('/uptime/summary', (req, res) => {
    const segments = resolveBucketCount(req.query.segments, DEFAULT_BAR_SEGMENTS);
    res.json(deps.monitor.getSummary(segments));
  });

  router.get('/uptime/targets/:id/history', (req, res) => {
    const range = parseRange(req.query.range);
    // 默认 180 点；上限由 resolveBucketCount 收敛到 MAX_HISTORY_POINTS，
    // 无论客户端传多大都不会一次吐几万点。
    const points = resolveBucketCount(req.query.points ?? 180, 180);
    const history = deps.monitor.getHistory(req.params.id, range.ms, points);
    if (!history) {
      res.status(404).json({ error: '监控目标不存在或尚未产生采样', targetId: req.params.id });
      return;
    }
    res.json({ ...history, range: range.key, maxPoints: MAX_HISTORY_POINTS });
  });

  router.get('/uptime/incidents', (req, res) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50;
    res.json({ incidents: deps.monitor.getIncidents(limit), generatedAt: Date.now() });
  });

  return router;
}
