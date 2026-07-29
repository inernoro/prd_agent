/**
 * notices — 服务端站内信账本的读写 API。
 *
 * 鉴权：不自造中间件。本路由挂在 `/api` 前缀下，走 server.ts 已有的全局登录网关
 * （cookie / SSO / agent key），与 uptime、bug-reports 同款。
 *
 *   GET  /api/notices              列出未忽略的通知 + 外发配置状态
 *   POST /api/notices              记录一条通知（前端 window 'cds:notice:upsert' 的兼容入口）
 *   POST /api/notices/read-all     全部标已读
 *   POST /api/notices/:id/dismiss  不再提醒
 */

import { Router } from 'express';
import type { NoticeLedgerService, CdsNoticeLevel } from '../services/notice-ledger.js';

/**
 * 取本次请求的项目作用域：项目级 cdsp_ / 单项目 cdsg_ key 会被 server.ts 的全局门
 * 盖上 `req.cdsProjectKey`；人类 cookie 与全局 AI key 没有这个戳。
 *
 * 项目级凭据只能看自己项目的通知——否则一把项目 Key 就能读到全实例每个项目的
 * 项目名、发布目标名与故障原因。口径与 routes/uptime.ts、cds-events.ts 一致。
 */
function projectScopeOf(req: unknown): string | null {
  return (req as { cdsProjectKey?: { projectId: string } }).cdsProjectKey?.projectId ?? null;
}

/** 前端 window 事件的既有来源取值（BranchListPage 四处 dispatch）+ 服务端事件来源。 */
const ALLOWED_SOURCES = new Set([
  'env', 'schema', 'ops', 'release', 'uptime', 'drift', 'self-update', 'system',
]);

const ALLOWED_LEVELS = new Set<CdsNoticeLevel>(['info', 'warning', 'danger']);

export interface NoticesRouterDeps {
  ledger: NoticeLedgerService;
  /** 外发是否已配置凭据；未配置时前端必须如实显示「仅记录在本地」。 */
  getOutboundStatus: () => { configured: boolean; reason?: string };
}

export function createNoticesRouter(deps: NoticesRouterDeps): Router {
  const router = Router();

  router.get('/notices', (req, res) => {
    // 惰性清理指向已删除项目的死链通知（前端旧版是打开面板时逐个探活，搬到服务端）。
    deps.ledger.pruneDeletedProjects();
    const scope = projectScopeOf(req);
    const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    res.json({
      notices: deps.ledger.list({ limit, projectId: scope }),
      outbound: deps.getOutboundStatus(),
      ...(scope ? { projectScope: scope } : {}),
    });
  });

  router.post('/notices', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!id || !title) {
      res.status(400).json({ error: 'id 与 title 必填' });
      return;
    }
    const source = typeof body.source === 'string' ? body.source : 'system';
    if (!ALLOWED_SOURCES.has(source)) {
      res.status(400).json({ error: `不支持的通知来源：${source}` });
      return;
    }
    const level = (typeof body.level === 'string' ? body.level : 'info') as CdsNoticeLevel;
    if (!ALLOWED_LEVELS.has(level)) {
      res.status(400).json({ error: `不支持的通知级别：${String(body.level)}` });
      return;
    }
    const scope = projectScopeOf(req);
    const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
    if (scope && projectId && projectId !== scope) {
      res.status(403).json({ error: '该通知不属于当前项目 Key 的作用域' });
      return;
    }
    const { record } = deps.ledger.upsert({
      id,
      // 前端来源的 id 已经是稳定的内容键（如 `env-missing:<projectId>`），直接当合并键。
      dedupeKey: id,
      level,
      title,
      body: typeof body.body === 'string' ? body.body : '',
      source,
      ...(projectId ? { projectId } : scope ? { projectId: scope } : {}),
      ...(typeof body.projectName === 'string' ? { projectName: body.projectName } : {}),
      ...(typeof body.projectSlug === 'string' ? { projectSlug: body.projectSlug } : {}),
      ...(typeof body.href === 'string' ? { href: body.href } : {}),
      ...(typeof body.actionLabel === 'string' ? { actionLabel: body.actionLabel } : {}),
    });
    res.json({ notice: record });
  });

  router.post('/notices/read-all', (req, res) => {
    const changed = deps.ledger.markAllRead(projectScopeOf(req));
    res.json({ ok: true, changed });
  });

  router.post('/notices/:id/dismiss', (req, res) => {
    const ok = deps.ledger.dismiss(req.params.id, projectScopeOf(req));
    if (!ok) {
      res.status(404).json({ error: '通知不存在或不在当前作用域内' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
