/**
 * Standby Guard middleware — 写入隔离(B'.2 / C-4.6)
 *
 * 当 daemon 处于 standby 模式时,所有 POST/PUT/DELETE/PATCH 请求 503,
 * 例外仅限 _internal 路由(回环鉴权)。GET 全部放行(只读)。
 *
 * 设计要点:
 *   - 只看 method,不依赖 url 业务语义。webhook(POST /api/github/webhook)
 *     也算写入,必须拒绝(C-4.6 防 standby 副作用)
 *   - _internal/* 路由的回环校验在路由内做,这里只豁免 path
 *   - 当 controller.isActive() == true 时纯穿透,零开销
 *   - 503 + JSON { error: "standby", ... } 让 supervisor 探测能区分"实例存在但未激活"
 *     vs"实例挂了"
 */

import type { Request, Response, NextFunction } from 'express';
import type { StandbyController } from '../services/standby-controller.js';

/** 写入方法集合(case-insensitive)。GET / HEAD / OPTIONS 永远放行。 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * 路径白名单:standby 模式下允许穿透的写入路径。当前只有 _internal/* 系列。
 *
 * 注意 — 这里不要把 /api/github/webhook 加进来:webhook 在 active 实例处理,
 * standby 实例必须返 503 让 supervisor / GitHub 重试到 active 那边(规则要求,
 * see C-4.6)。同理 Bridge command / branches deploy 也不豁免。
 */
function isInternalPromoteOrStandbyPath(path: string): boolean {
  // 匹配 /api/_internal/* 任意子路径(不含查询串,Express 已 strip)
  return path === '/api/_internal/promote'
    || path === '/api/_internal/standby'
    || path === '/api/_internal/graceful-shutdown';
}

export interface StandbyGuardOptions {
  controller: StandbyController;
}

/**
 * 创建 middleware。挂载位置:auth middleware 之后、所有业务 router 之前。
 * 这样 _internal 路由(在本 middleware 之后注册)能照常处理 promote 请求,
 * 而所有业务 POST/PUT/DELETE 都会被拦下。
 */
export function createStandbyGuard(opts: StandbyGuardOptions) {
  const { controller } = opts;
  return function standbyGuard(req: Request, res: Response, next: NextFunction): void {
    if (controller.isActive()) {
      return next(); // active 模式纯穿透
    }
    const method = (req.method || '').toUpperCase();
    if (!WRITE_METHODS.has(method)) {
      return next(); // 只读放行
    }
    if (isInternalPromoteOrStandbyPath(req.path)) {
      return next(); // _internal 自身允许穿透,内部再做回环校验
    }
    // 拒绝业务写入。文案中文,告诉调用方此 daemon 当前是 standby、应该走 active。
    res.status(503).json({
      error: 'standby',
      message: '当前 daemon 处于 standby(备用)模式,业务写入请求请走 active 实例',
      mode: 'standby',
      hint: 'supervisor 完成切换后此实例会自动 promote;如需手动激活请调 POST /api/_internal/promote',
    });
  };
}
