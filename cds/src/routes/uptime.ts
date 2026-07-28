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

/**
 * 取本次请求的项目作用域：项目级 cdsp_ / 单项目 cdsg_ key 会被 server.ts 的
 * 全局门盖上 `req.cdsProjectKey`；人类 cookie 与全局 AI key 没有这个戳。
 *
 * 存活监控是跨项目的运维面板，默认吐全量。但项目级凭据只能看自己项目——
 * 否则一把项目 Key 就能枚举出全实例每个项目的分支名、服务名、故障原因与
 * 时间线（Codex PR #1273 P1）。与 cds-events.ts 的同款守卫口径一致。
 */
function projectScopeOf(req: unknown): string | null {
  return (req as { cdsProjectKey?: { projectId: string } }).cdsProjectKey?.projectId ?? null;
}

export function createUptimeRouter(deps: { monitor: UptimeMonitorService }): Router {
  const router = Router();

  router.get('/uptime/summary', (req, res) => {
    const segments = resolveBucketCount(req.query.segments, DEFAULT_BAR_SEGMENTS);
    const summary = deps.monitor.getSummary(segments);
    const scope = projectScopeOf(req);
    if (!scope) {
      res.json(summary);
      return;
    }
    // 收窄到本项目，并按收窄后的集合重算总览计数，避免「只看得到 1 个目标
    // 却显示全实例 139 个」这种对不上的数字。
    const targets = summary.targets.filter((t) => t.projectId === scope);
    const tally = { total: targets.length, up: 0, down: 0, paused: 0, unknown: 0, excluded: 0 };
    for (const t of targets) {
      if (t.excluded) tally.excluded += 1;
      else if (t.status === 'up') tally.up += 1;
      else if (t.status === 'down') tally.down += 1;
      else if (t.status === 'paused') tally.paused += 1;
      else tally.unknown += 1;
    }
    res.json({ ...summary, targets, overall: { ...tally, ok: tally.down === 0 }, projectScope: scope });
  });

  router.get('/uptime/targets/:id/history', (req, res) => {
    const range = parseRange(req.query.range);
    // 默认 180 点；上限由 resolveBucketCount 收敛到 MAX_HISTORY_POINTS，
    // 无论客户端传多大都不会一次吐几万点。
    const points = resolveBucketCount(req.query.points ?? 180, 180);
    const scope = projectScopeOf(req);
    if (scope) {
      // 单 target 详情同样要判归属，否则知道 id 就能读别的项目的时序。
      const owner = deps.monitor.getRecord(req.params.id)?.projectId;
      if (owner && owner !== scope) {
        res.status(403).json({ error: '该监控目标不属于当前项目 Key 的作用域' });
        return;
      }
    }
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
    const scope = projectScopeOf(req);
    // 先按作用域过滤再截断：反过来会让项目级调用者拿到「前 N 条里恰好属于我的」
    // 那几条，看起来故障变少了。
    const incidents = scope
      ? deps.monitor.getIncidents(Number.MAX_SAFE_INTEGER).filter((i) => i.projectId === scope).slice(0, limit)
      : deps.monitor.getIncidents(limit);
    res.json({ incidents, generatedAt: Date.now() });
  });

  return router;
}
