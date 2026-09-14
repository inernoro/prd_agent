/**
 * 公开状态页：`/api/public/status/:token`（匿名）+ 项目侧的开关（要登录）。
 *
 * 为什么可以匿名：token 是 16 字节随机串，不可枚举，它的全部意义就是给没有
 * 账号的人看——挂在登录网关后面等于没做。与验收报告的 `/r/:token` 同款。
 *
 * 为什么载荷安全：对外内容由 public-status-board 白名单构造，这个文件不往里
 * 加任何字段。它只负责「取哪些监控」与「取几天数据」，取完就交给那一个构造器。
 */
import { Router } from 'express';

import type { Project, UptimeCustomMonitor } from '../types.js';
import {
  buildPublicStatusBoard,
  type PublicBoardPayload,
  type PublicBoardSourceItem,
} from '../services/public-status-board.js';

const DAY_MS = 24 * 3600 * 1000;
/** 对外条带固定 7 天：够看出「最近稳不稳」，又不至于变成一份运营史。 */
const PUBLIC_DAYS = 7;

export interface PublicStatusDeps {
  state: {
    getProjectByStatusPageToken(token: string): Project | undefined;
    getProject(idOrSlug: string): Project | undefined;
    listUptimeMonitors(projectId?: string): UptimeCustomMonitor[];
    openProjectStatusPage(projectId: string): Project | undefined;
    closeProjectStatusPage(projectId: string): Project | undefined;
  };
  monitor: {
    getSummary(barSegments?: number): {
      generatedAt: number;
      targets: Array<{
        id: string;
        status: 'up' | 'down' | 'paused' | 'unknown';
        measured: boolean;
        sampleCount?: number;
        observeMode?: 'active' | 'passive';
      }>;
    };
    getHistory(targetId: string, rangeMs: number, bucketCount: number): {
      points: Array<{ from: number; up: number; down: number }>;
    } | null;
  };
  /** 公开页多久刷一次的提示（秒）。与探测间隔同源，别在页面上另写一个数。 */
  refreshHintSeconds: number;
  now?: () => number;
}

function customTargetId(monitorId: string): string {
  return `monitor@${monitorId}`;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 取一个项目当下的对外载荷。找不到 token 时返回 null，由调用方回 404。 */
export function buildPayloadForProject(
  deps: PublicStatusDeps,
  project: Project,
): PublicBoardPayload {
  const now = deps.now ? deps.now() : Date.now();
  const summary = deps.monitor.getSummary();
  const byId = new Map(summary.targets.map((t) => [t.id, t]));

  const items: PublicBoardSourceItem[] = [];
  for (const monitor of deps.state.listUptimeMonitors(project.id)) {
    // 显式公开、且没被暂停的才出去。暂停的监控对外是一条永远灰着的条带，
    // 只会让读者以为服务坏了。
    if (!monitor.publicVisible || monitor.enabled === false) continue;
    const target = byId.get(customTargetId(monitor.id));
    if (!target) continue;
    const history = deps.monitor.getHistory(customTargetId(monitor.id), PUBLIC_DAYS * DAY_MS, PUBLIC_DAYS);
    items.push({
      name: monitor.name,
      ...(monitor.publicName ? { publicName: monitor.publicName } : {}),
      status: target.status,
      measured: target.measured,
      ...(target.sampleCount === undefined ? {} : { sampleCount: target.sampleCount }),
      ...(target.observeMode ? { observeMode: target.observeMode } : {}),
      days: (history?.points || []).map((p) => ({ day: dayKey(p.from), up: p.up, down: p.down })),
    });
  }

  return buildPublicStatusBoard({
    // 对外标题用项目的对外别名，没有才退回内部名——内部名常带部门缩写。
    title: project.aliasName || project.name || project.id,
    items,
    now,
    refreshHintSeconds: deps.refreshHintSeconds,
  });
}

export function createPublicStatusRouter(deps: PublicStatusDeps): Router {
  const router = Router();

  /** 匿名只读。撤销后立刻 404——不留缓存副本，也不区分「没这个 token」与「关了」。 */
  router.get('/public/status/:token', (req, res) => {
    const project = deps.state.getProjectByStatusPageToken(String(req.params.token || ''));
    if (!project) {
      res.status(404).json({ error: '这个状态页不存在或已关闭' });
      return;
    }
    // 公开页是给人看的，不该被中间缓存留副本：撤销之后旧链接必须立刻打不开。
    res.setHeader('cache-control', 'no-store');
    res.json(buildPayloadForProject(deps, project));
  });

  return router;
}

/** 项目设置里的开关。挂在登录网关后面，与公开读取那条路分开注册。 */
export function createStatusPageAdminRouter(deps: PublicStatusDeps): Router {
  const router = Router();

  router.get('/projects/:id/status-page', (req, res) => {
    const project = deps.state.getProject(String(req.params.id));
    if (!project) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    res.json({
      open: Boolean(project.statusPageToken),
      path: project.statusPageToken ? `/s/${project.statusPageToken}` : null,
      openedAt: project.statusPageOpenedAt || null,
    });
  });

  router.post('/projects/:id/status-page', (req, res) => {
    const project = deps.state.openProjectStatusPage(String(req.params.id));
    if (!project) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    res.json({ open: true, path: `/s/${project.statusPageToken}`, openedAt: project.statusPageOpenedAt || null });
  });

  router.delete('/projects/:id/status-page', (req, res) => {
    const project = deps.state.closeProjectStatusPage(String(req.params.id));
    if (!project) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    res.json({ open: false, path: null, openedAt: null });
  });

  return router;
}
