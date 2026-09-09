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
 * 写（自定义监控，2026-09-08 监控中心重做；只给管理员身份，项目级 Key 一律 403）：
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
import { tallyTargetSummaries, type UptimeMonitorService } from '../services/uptime-monitor.js';
import {
  customProbeTargetId,
  describeMonitorProbe,
  evaluateProjectScopedWrite,
  normalizeUptimeMonitorInput,
  probeCustomMonitor,
  type ProjectPreviewHost,
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

/**
 * 项目级 Key 的受限写入闸（2026-09-09）。
 *
 * 这里原本是一条对项目级 Key 无差别 403 的闸（Codex PR #1514 P1）。它的理由是两个
 * 具体风险，不是「项目 Key 一律不可信」：自定义目标的地址由调用方任填、CDS 主机替它
 * 去连，于是一把项目 Key 就能借主机扫回环、内网、别的项目的内部服务；关键字探测还
 * 顺带把响应内容当成 oracle 透出来。所以这里开一条同时堵死这两个风险的窄路，
 * 让 Agent 能用项目 Key 自助登记**自己项目、自己分支**的 health-json 监控：
 * 判据与地址范围都由服务端决定，调用方报什么都没用。
 *
 * 管理员身份（无项目作用域）不走这里，行为完全不变。
 * 返回 null 表示已经回过响应、调用方直接 return。
 */
type WriteScope =
  | { admin: true }
  | { admin: false; projectId: string; keyId: string; boundBranchId: string };

function resolveWriteScope(
  req: unknown,
  res: { status(code: number): { json(body: unknown): void } },
  monitor: Pick<UptimeCustomMonitor, 'kind' | 'url' | 'projectId'>,
  listProjectPreviewHosts?: (projectId: string) => ProjectPreviewHost[],
): WriteScope | null {
  const scope = projectScopeOf(req);
  if (!scope) return { admin: true };

  if (!listProjectPreviewHosts) {
    // 没接线就退回原来的 403：宁可拒绝，也不要在拿不到地址台账时放行——
    // 那等于把「地址必须属于本项目」这条规则悄悄跳过（形状 2：链路只建一半）。
    res.status(403).json({ error: '本实例未启用项目级自助登记（缺少分支地址台账接线）' });
    return null;
  }
  const verdict = evaluateProjectScopedWrite(monitor, scope, listProjectPreviewHosts(scope));
  if (!verdict.ok) {
    res.status(403).json({ error: verdict.error, field: verdict.field });
    return null;
  }
  const keyId = (req as { cdsProjectKey?: { keyId?: string } }).cdsProjectKey?.keyId || '';
  return { admin: false, projectId: scope, keyId, boundBranchId: verdict.boundBranchId };
}

/** 按写入主体盖审计字段：监控中心要答得出「谁加的、从哪加的、绑着哪条分支」。 */
function stampAudit(monitor: UptimeCustomMonitor, req: unknown, scope: WriteScope): void {
  if (scope.admin) {
    const username = (req as { cdsUser?: { username?: string } }).cdsUser?.username;
    if (username) {
      monitor.createdBy = username;
      monitor.createdByKind = 'human';
    } else if (!monitor.createdBy) {
      monitor.createdBy = 'global-key';
      monitor.createdByKind = 'global-key';
    }
    if (!monitor.origin) monitor.origin = 'manual';
    return;
  }
  monitor.projectId = scope.projectId;
  monitor.createdBy = scope.keyId ? `key:${scope.keyId}` : `project:${scope.projectId}`;
  monitor.createdByKind = 'project-key';
  monitor.origin = 'agent-api';
  // 寿命跟着分支走：分支删了这条监控一起消失，不留下一条永远红着的死地址。
  monitor.boundBranchId = scope.boundBranchId;
}

/**
 * 项目级凭据访问单个目标：归属从当前目标定义解析（刚保存、还没进过轮次的目标也算），
 * 找不到或不是本项目的一律 403——不用 404 区分「不存在」与「别人的」，那是枚举 oracle
 * （Codex PR #1514 P2）。
 */
function denyForeignTarget(req: unknown, monitor: UptimeMonitorService, targetId: string, res: { status(code: number): { json(body: unknown): void } }): boolean {
  const scope = projectScopeOf(req);
  if (!scope) return false;
  const owner = monitor.getTargetProjectId(targetId);
  if (owner === scope) return false;
  res.status(403).json({ error: '该监控目标不属于当前项目 Key 的作用域' });
  return true;
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

export function createUptimeRouter(deps: {
  monitor: UptimeMonitorService;
  store?: UptimeMonitorStore;
  /**
   * 某项目名下所有分支的预览主机名。项目级 Key 自助登记时，地址只能落在这份台账里——
   * 它同时是「不许扫内网」的闸和「这条监控绑哪条分支」的来源。
   * 不注入则自助登记整体关闭（退回原来的管理员限定）。
   */
  listProjectPreviewHosts?: (projectId: string) => ProjectPreviewHost[];
}): Router {
  const router = Router();

  router.get('/uptime/summary', (req, res) => {
    const segments = resolveBucketCount(req.query.segments, DEFAULT_BAR_SEGMENTS);
    const summary = deps.monitor.getSummary(segments);
    const scope = projectScopeOf(req);
    if (!scope) {
      res.json(summary);
      return;
    }
    // 收窄到本项目，并按收窄后的集合重算总览计数与覆盖面，避免「只看得到 1 个目标
    // 却显示全实例 139 个」这种对不上的数字；计数口径与全量同一个函数，未实测不会
    // 被算成正常；覆盖面的未纳入清单同样只给本项目的。
    const targets = summary.targets.filter((t) => t.projectId === scope);
    res.json({
      ...summary,
      targets,
      overall: tallyTargetSummaries(targets),
      coverage: deps.monitor.getCoverage(scope),
      projectScope: scope,
    });
  });

  router.get('/uptime/targets/:id/history', (req, res) => {
    const range = parseRange(req.query.range);
    // 默认 180 点；上限由 resolveBucketCount 收敛到 MAX_HISTORY_POINTS，
    // 无论客户端传多大都不会一次吐几万点。
    const points = resolveBucketCount(req.query.points ?? 180, 180);
    // 单 target 详情同样要判归属，否则知道 id 就能读别的项目的时序。
    if (denyForeignTarget(req, deps.monitor, req.params.id, res)) return;
    const history = deps.monitor.getHistory(req.params.id, range.ms, points);
    if (!history) {
      res.status(404).json({ error: '监控目标不存在或尚未产生采样', targetId: req.params.id });
      return;
    }
    res.json({ ...history, range: range.key, maxPoints: MAX_HISTORY_POINTS });
  });

  router.post('/uptime/targets/:id/probe', async (req, res) => {
    if (denyForeignTarget(req, deps.monitor, req.params.id, res)) return;
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
    // 作用域过滤在 getIncidents 内部、截断之前：在外面 filter 拿到的已经是全实例
    // 截过 200 条的结果，别的项目故障多时项目级调用者一条都分不到。
    const incidents = deps.monitor.getIncidents(limit, scope);
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

  /**
   * 一条功能监控的历史观测证据（详情页画廊与判据逐条）。
   *
   * 与摘要分开拉：摘要只带最新一条的精简版，完整证据（判据逐条、请求体）在这里。
   * 一个 20 条证据 × N 个监控的列表接口会被撑得又慢又肥，而列表根本不展示它们。
   */
  router.get('/uptime/monitors/:id/observations', (req, res) => {
    if (!store || storeUnavailable(res)) return;
    const monitor = store.getUptimeMonitor(req.params.id);
    if (!monitor) {
      res.status(404).json({ error: '监控不存在', id: req.params.id });
      return;
    }
    const scope = projectScopeOf(req);
    // 与 denyForeignTarget 同款：不用 404 区分「不存在」与「别人的」，那是枚举 oracle。
    if (scope && monitor.projectId !== scope) {
      res.status(403).json({ error: '该监控不属于当前项目 Key 的作用域' });
      return;
    }
    res.json({
      monitorId: monitor.id,
      name: monitor.name,
      description: describeMonitorProbe(monitor),
      observations: monitor.observations || [],
    });
  });

  /** 试探一次：只回结果，不落库。与轮次同一套探测实现，不另写一份判定。 */
  router.post('/uptime/monitors/test', async (req, res) => {
    const normalized = normalizeUptimeMonitorInput((req.body || {}) as UptimeMonitorInput);
    if (!normalized.ok) {
      res.status(400).json({ error: normalized.error, field: normalized.field });
      return;
    }
    // 试探同样走闸：它真的会让 CDS 主机去连那个地址，不落库不等于没有 SSRF 面。
    // 少了这一行，项目 Key 可以用「试探」把写路由的地址限制整个绕过去。
    if (!resolveWriteScope(req, res, normalized.monitor, deps.listProjectPreviewHosts)) return;
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
    const input = { ...((req.body || {}) as UptimeMonitorInput) };
    const normalized = normalizeUptimeMonitorInput(input);
    if (!normalized.ok) {
      res.status(400).json({ error: normalized.error, field: normalized.field });
      return;
    }
    const monitor = normalized.monitor;
    // 先规范化再判作用域：判据要看规范化后的 kind 与 url，不看调用方原样报的字段。
    const writeScope = resolveWriteScope(req, res, monitor, deps.listProjectPreviewHosts);
    if (!writeScope) return;
    if (monitor.projectId && store.getProject && !store.getProject(monitor.projectId)) {
      res.status(400).json({ error: `项目 ${monitor.projectId} 不存在`, field: 'projectId' });
      return;
    }
    if (store.getUptimeMonitor(monitor.id)) {
      res.status(409).json({ error: `监控 id '${monitor.id}' 已存在`, field: 'id' });
      return;
    }
    stampAudit(monitor, req, writeScope);
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
    const input = { ...((req.body || {}) as UptimeMonitorInput), id: existing.id };
    const normalized = normalizeUptimeMonitorInput(input, { existing });
    if (!normalized.ok) {
      res.status(400).json({ error: normalized.error, field: normalized.field });
      return;
    }
    const monitor = normalized.monitor;
    // 改之前先判**改后的样子**是否仍在允许范围内：只判旧值会让人把一条合规监控
    // 改成打内网的地址（判据必须取变更后的状态，不是变更前的）。
    const writeScope = resolveWriteScope(req, res, monitor, deps.listProjectPreviewHosts);
    if (!writeScope) return;
    // 项目级 Key 还要确认这条**原本**就是自己项目的，否则等于接管别人的监控。
    if (!writeScope.admin) {
      if (existing.projectId !== writeScope.projectId) {
        res.status(403).json({ error: '该监控不属于当前项目 Key 的作用域' });
        return;
      }
      // 与 DELETE 同款：不许改管理员手动加的那些（改判据 = 让它不再报警，
      // 等于变相删除，所以两条路必须一样严）。
      if (existing.origin !== 'agent-api') {
        res.status(403).json({ error: '这条监控由管理员添加，项目级 Key 只能修改自己登记的监控' });
        return;
      }
    }
    if (monitor.projectId && store.getProject && !store.getProject(monitor.projectId)) {
      res.status(400).json({ error: `项目 ${monitor.projectId} 不存在`, field: 'projectId' });
      return;
    }
    stampAudit(monitor, req, writeScope);
    try {
      const saved = store.upsertUptimeMonitor(monitor);
      // 台账立刻跟上新定义（尤其是归属项目），不等下一轮探测。
      deps.monitor.refreshTarget(customProbeTargetId(saved));
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
    // 删只需判归属，不必判地址：删掉一条监控没有 SSRF 面。
    // 但归属不止「同项目」——项目级 Key 只能收回**自己登记的**那些。
    // 管理员手动加的监控是人明确要盯的东西，一把项目 Key 不该能把它删掉：
    // 自助登记要的是「Agent 能追加」，不是「Agent 能替管理员做主」。
    const scope = projectScopeOf(req);
    if (scope) {
      if (existing.projectId !== scope) {
        res.status(403).json({ error: '该监控不属于当前项目 Key 的作用域' });
        return;
      }
      if (existing.origin !== 'agent-api') {
        res.status(403).json({ error: '这条监控由管理员添加，项目级 Key 只能删除自己登记的监控' });
        return;
      }
    }
    store.removeUptimeMonitor(existing.id);
    deps.monitor.forgetTarget(customProbeTargetId(existing));
    res.json({ ok: true, id: existing.id });
  });

  return router;
}
