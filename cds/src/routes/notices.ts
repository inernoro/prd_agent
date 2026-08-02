/**
 * notices — 服务端站内信账本的读写 API。
 *
 * 鉴权：不自造中间件。本路由挂在 `/api` 前缀下，走 server.ts 已有的全局登录网关
 * （cookie / SSO / agent key），与 uptime、bug-reports 同款。
 *
 *   GET  /api/notices              列出未忽略的通知 + 外发配置状态 + 各状态计数
 *   POST /api/notices              记录一条通知（前端 window 'cds:notice:upsert' 的兼容入口）
 *   POST /api/notices/read-all     全部标已读
 *   POST /api/notices/:id/dismiss  不再提醒
 *   POST /api/notices/:id/handling 推进处理状态机（认领 / 退回 / 标记已解决）
 */

import { Router } from 'express';
import { apiNoticeDedupeKey, normalizeNoticeStatus, NOTICE_STATUSES } from '../services/notice-ledger.js';
import type {
  NoticeLedgerService,
  CdsNoticeLevel,
  CdsNoticeActor,
  CdsNoticeStatus,
} from '../services/notice-ledger.js';
import { resolveActorFromRequest } from '../services/actor-resolver.js';

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

/**
 * 共享凭据造出来的伪 id：`legacyAuthUser` 在 basic 模式下把 id 造成 `basic:<username>`、
 * disabled 模式造成 `anonymous`（server.ts:539）。这两种都不是「人」——一把共享口令背后
 * 可能是整个团队。当前这两个值只用于 `/api/me` 响应体、并不会写回 request，但这里仍然
 * 显式拒收：万一哪天有人把它挂到 req.cdsUser 上，默认部署会立刻退化成「每条通知都被
 * 同一个人认领」，界面看着有责任人、实际一个都没有，而且不报任何错。
 */
function isRealIdentity(id: string): boolean {
  return !!id && id !== 'anonymous' && !id.startsWith('basic:');
}

/**
 * 取「这次状态变更是谁做的」——本轨道唯一的身份取值口径，只此一处。
 *
 * channel 永远有值（调用通道），userId/userLabel 只有真实账号会话才有：
 *  - github 模式：`github-auth.ts` 在校验会话后挂 req.cdsUser；
 *  - ticket SSO：`server.ts` 挂 `id = sso:<subject>` 的 cdsUser；
 *  - basic / disabled 模式、项目级 cdsp_ Key：**没有 req.cdsUser**，一律 null。
 *
 * 取不到就返回 null，绝不用 channel 桶名（'user' / 'ai'）兜底——那是通道不是人。
 */
export function noticeActorOf(req: unknown): CdsNoticeActor {
  const channel = resolveActorFromRequest(req);
  const user = (req as {
    cdsUser?: { id?: unknown; name?: unknown; username?: unknown; githubLogin?: unknown; authProvider?: unknown };
  }).cdsUser;
  const rawId = typeof user?.id === 'string' ? user.id : '';
  if (!isRealIdentity(rawId)) {
    return { channel, userId: null, userLabel: null, provider: null };
  }
  const userLabel = [user?.name, user?.username, user?.githubLogin]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? null;
  const provider = typeof user?.authProvider === 'string' && user.authProvider ? user.authProvider : null;
  return { channel, userId: rawId, userLabel, provider };
}

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
    // 未指定 status 时不过滤（拿全部）。**不能**用 normalizeNoticeStatus 兜底——
    // 它把未知值归 open，那样 `GET /api/notices`（不带参数）会只返回待处理的，
    // 已在处理的通知从面板上凭空消失。只有显式合法值才过滤。
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : '';
    const statusFilter = NOTICE_STATUSES.includes(rawStatus as CdsNoticeStatus)
      ? (rawStatus as CdsNoticeStatus)
      : undefined;
    // 计数永远按整个作用域算（不受 status 过滤影响），否则筛选条上的数字与铃铛角标
    // 会随当前选中项跳变，用户没法回答「还有几条没人处理」。
    const { counts, unread } = deps.ledger.summary(scope);
    res.json({
      notices: deps.ledger.list({ limit, projectId: scope, ...(statusFilter ? { status: statusFilter } : {}) }),
      counts,
      unread,
      outbound: deps.getOutboundStatus(),
      ...(statusFilter ? { statusFilter } : {}),
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
      // 前端来源的 id 是稳定的内容键（如 `env-missing:<projectId>`），但它由调用方
      // 控制，不能直接当全局合并键——键空间与作用域段见 apiNoticeDedupeKey。
      dedupeKey: apiNoticeDedupeKey(scope, id),
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

  /**
   * 推进处理状态机。一个端点覆盖三个动作（认领 = working、退回 = open、
   * 解决 = resolved），因为三者的作用域校验、身份取值、落库路径完全一样——
   * 拆成三条路由等于把同一份判据抄三遍，改一处忘两处（形状 3）。
   */
  router.post('/notices/:id/handling', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = typeof body.status === 'string' ? body.status : '';
    // 这里必须严格白名单而不是 normalizeNoticeStatus：把 'resolvedd' 这种 typo
    // 静默归成 open，调用方会以为自己标记成功了，实际状态反着走。
    if (!NOTICE_STATUSES.includes(raw as CdsNoticeStatus)) {
      res.status(400).json({ error: `不支持的处理状态：${String(body.status)}（可选：${NOTICE_STATUSES.join(' / ')}）` });
      return;
    }
    const notice = deps.ledger.setHandling(
      req.params.id,
      normalizeNoticeStatus(raw),
      noticeActorOf(req),
      projectScopeOf(req),
    );
    if (!notice) {
      res.status(404).json({ error: '通知不存在、不在当前作用域内，或已被「不再提醒」' });
      return;
    }
    res.json({ ok: true, notice });
  });

  return router;
}
