/**
 * uptime — 监控中心的 API（状态页 + 自定义监控管理）。
 *
 * 鉴权：不自造中间件。本路由挂在 `/api` 前缀下，走 server.ts 已有的全局
 * 登录网关（cookie / SSO / agent key），与 docker-network-health 等同款。
 *
 * 只读（状态页数据源）：
 *   GET  /api/uptime/summary?segments=90        全量摘要（含柱条，状态页一次拉完）
 *   GET  /api/uptime/targets/:id/history?range= 单 target 时序（已降采样）
 *   GET  /api/uptime/incidents?limit=50         由连续失败自动合成的故障时间线
 *
 * 写（自定义监控，2026-09-08 监控中心重做）：
 *   GET    /api/uptime/monitors                 列出自定义监控定义
 *   POST   /api/uptime/monitors                 新增
 *   PUT    /api/uptime/monitors/:id             修改（含暂停 / 恢复：只传 enabled）
 *   DELETE /api/uptime/monitors/:id             删除（台账在下一轮清理）
 *   POST   /api/uptime/monitors/test            按一份定义试探一次，不落库
 *   POST   /api/uptime/targets/:id/probe        对任一目标立刻探一次并记入台账
 */

import { Router } from 'express';
import type { UptimeCustomMonitor } from '../types.js';
import {
  DEFAULT_BAR_SEGMENTS,
  MAX_HISTORY_POINTS,
  parseRange,
  resolveBucketCount,
} from '../services/uptime-metrics.js';
import type { UptimeMonitorService } from '../services/uptime-monitor.js';
import {
  customProbeTargetId,
  describeMonitorProbe,
  normalizeUptimeMonitorInput,
  probeCustomMonitor,
  type UptimeMonitorInput,
} from '../services/uptime-custom-monitor.js';

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

/** 写入自定义监控时需要的最小状态面（路由不碰 StateService 其它部分）。 */
export interface UptimeMonitorStore {
  listUptimeMonitors(projectId?: string): UptimeCustomMonitor[];
  getUptimeMonitor(id: string): UptimeCustomMonitor | undefined;
  upsertUptimeMonitor(monitor: UptimeCustomMonitor): UptimeCustomMonitor;
  removeUptimeMonitor(id: string): boolean;
  /** 校验归属项目存在；不接则不校验 */
  getProject?(projectId: string): unknown;
}

export function createUptimeRouter(deps: { monitor: UptimeMonitorService; store?: UptimeMonitorStore }): Router {
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

  router.post('/uptime/targets/:id/probe', async (req, res) => {
    const scope = projectScopeOf(req);
    if (scope) {
      const owner = deps.monitor.getRecord(req.params.id)?.projectId;
      if (owner !== undefined && owner !== scope) {
        res.status(403).json({ error: '该监控目标不属于当前项目 Key 的作用域' });
        return;
      }
    }
    try {
      const result = await deps.monitor.probeNow(req.params.id);
      if (!result) {
        res.status(404).json({ error: '监控目标不存在', targetId: req.params.id });
        return;
      }
      if (!result.ok) {
        res.status(409).json({ error: `该目标当前不探测：${result.skipped}`, skipped: result.skipped });
        return;
      }
      res.json({ ok: true, targetId: req.params.id, sample: result.sample, status: result.status });
    } catch (err) {
      res.status(500).json({ error: `探测失败：${(err as Error).message}` });
    }
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

  // ── 自定义监控（写） ──

  const store = deps.store;
  const storeUnavailable = (res: { status(code: number): { json(body: unknown): void } }): boolean => {
    if (store) return false;
    res.status(503).json({ error: '当前实例未接入自定义监控存储' });
    return true;
  };

  router.get('/uptime/monitors', (req, res) => {
    if (!store || storeUnavailable(res)) return;
    const scope = projectScopeOf(req);
    res.json({ monitors: scope ? store.listUptimeMonitors(scope) : store.listUptimeMonitors() });
  });

  /** 试探一次：只回结果，不落库。与轮次同一套探测实现，不另写一份判定。 */
  router.post('/uptime/monitors/test', async (req, res) => {
    const normalized = normalizeUptimeMonitorInput((req.body || {}) as UptimeMonitorInput);
    if (!normalized.ok) {
      res.status(400).json({ error: normalized.error, field: normalized.field });
      return;
    }
    const timeoutMs = normalized.monitor.timeoutMs || deps.monitor.config.timeoutMs;
    const outcome = await probeCustomMonitor(normalized.monitor, timeoutMs);
    res.json({
      ok: true,
      up: outcome.up,
      ms: outcome.ms,
      code: outcome.code,
      err: outcome.err,
      description: describeMonitorProbe(normalized.monitor),
      name: normalized.monitor.name,
      checkedAt: Date.now(),
    });
  });

  router.post('/uptime/monitors', (req, res) => {
    if (!store || storeUnavailable(res)) return;
    const scope = projectScopeOf(req);
    const input = { ...((req.body || {}) as UptimeMonitorInput) };
    // 项目级凭据只能往自己项目里加，传别的项目 id 直接改写成自己的，不给枚举机会。
    if (scope) input.projectId = scope;
    const normalized = normalizeUptimeMonitorInput(input);
    if (!normalized.ok) {
      res.status(400).json({ error: normalized.error, field: normalized.field });
      return;
    }
    const monitor = normalized.monitor;
    if (monitor.projectId && store.getProject && !store.getProject(monitor.projectId)) {
      res.status(400).json({ error: `项目 ${monitor.projectId} 不存在`, field: 'projectId' });
      return;
    }
    if (store.getUptimeMonitor(monitor.id)) {
      res.status(409).json({ error: `监控 id '${monitor.id}' 已存在`, field: 'id' });
      return;
    }
    const actor = (req as { cdsUser?: { username?: string } }).cdsUser?.username;
    if (actor) monitor.createdBy = actor;
    try {
      const saved = store.upsertUptimeMonitor(monitor);
      res.status(201).json({ monitor: saved, description: describeMonitorProbe(saved) });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.put('/uptime/monitors/:id', (req, res) => {
    if (!store || storeUnavailable(res)) return;
    const existing = store.getUptimeMonitor(req.params.id);
    if (!existing) {
      res.status(404).json({ error: '监控不存在', id: req.params.id });
      return;
    }
    const scope = projectScopeOf(req);
    if (scope && existing.projectId !== scope) {
      res.status(403).json({ error: '该监控不属于当前项目 Key 的作用域' });
      return;
    }
    const input = { ...((req.body || {}) as UptimeMonitorInput), id: existing.id };
    if (scope) input.projectId = scope;
    const normalized = normalizeUptimeMonitorInput(input, { existing });
    if (!normalized.ok) {
      res.status(400).json({ error: normalized.error, field: normalized.field });
      return;
    }
    const monitor = normalized.monitor;
    if (monitor.projectId && store.getProject && !store.getProject(monitor.projectId)) {
      res.status(400).json({ error: `项目 ${monitor.projectId} 不存在`, field: 'projectId' });
      return;
    }
    try {
      const saved = store.upsertUptimeMonitor(monitor);
      res.json({ monitor: saved, description: describeMonitorProbe(saved) });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.delete('/uptime/monitors/:id', (req, res) => {
    if (!store || storeUnavailable(res)) return;
    const existing = store.getUptimeMonitor(req.params.id);
    if (!existing) {
      res.status(404).json({ error: '监控不存在', id: req.params.id });
      return;
    }
    const scope = projectScopeOf(req);
    if (scope && existing.projectId !== scope) {
      res.status(403).json({ error: '该监控不属于当前项目 Key 的作用域' });
      return;
    }
    store.removeUptimeMonitor(existing.id);
    deps.monitor.forgetTarget(customProbeTargetId(existing));
    res.json({ ok: true, id: existing.id });
  });

  return router;
}
