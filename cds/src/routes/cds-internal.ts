/**
 * CDS Internal routes — supervisor 与 daemon 之间的私有控制面(B'.2 + B'.5.1 hotfix)
 *
 * 端点:
 *   POST /api/_internal/promote         standby → active
 *   POST /api/_internal/standby         active → standby
 *
 * 安全模型(B'.5.1 hotfix):
 *   - **Layer 1 — token 双因子认证**:supervisor 调用必须携带
 *     `X-CDS-Internal-Token: <secret>` header,daemon 用 timing-safe 比对内存里
 *     启动时生成的 secret。secret 落盘 .cds/internal-token(0600 权限),只有
 *     daemon 进程 owner 能读 → 同主机其他进程 / nginx 容器 / 攻击者均无法获取。
 *     这是真正的防线(C-4.1)。
 *   - **Layer 2 — nginx 顶层 403**:nginx 模板加 `location /api/_internal/ { return 403; }`,
 *     让外部请求根本到不了 daemon(纵深防御)。
 *
 * 历史教训:
 *   - 2026-05-08 cds.miduo.org 冒烟发现公网可调 promote。
 *   - 根因:原版本只校验 socket.remoteAddress,但 nginx 反代场景下 daemon 永远
 *     看到 127.0.0.1,IP 校验完全失效。
 *   - 修复后即使攻击者拿到 token 也需要文件读权限,且 nginx 顶层兜底 403。
 *
 * 与 standby-guard 的关系:
 *   - guard 已豁免 _internal/* 路径,所以即使在 standby 模式 promote 请求也能到达本路由
 *   - 本路由的 token 校验是核心防线
 */

import express from 'express';
import type { StandbyController } from '../services/standby-controller.js';
import type { InternalTokenStore } from '../services/internal-token-store.js';

export interface CdsInternalRouterDeps {
  controller: StandbyController;
  tokenStore: InternalTokenStore;
}

export const INTERNAL_TOKEN_HEADER = 'x-cds-internal-token';

export function createCdsInternalRouter(deps: CdsInternalRouterDeps): express.Router {
  const router = express.Router();
  const { controller, tokenStore } = deps;

  // Token 校验 middleware:每个 _internal/* 端点都过一遍。
  // 不再依赖 IP 校验 — 在 nginx 反代场景下 socket.remoteAddress 永远是 127.0.0.1,
  // IP 校验完全失效(2026-05-08 冒烟发现)。
  router.use((req, res, next) => {
    const received = req.header(INTERNAL_TOKEN_HEADER);
    if (!tokenStore.verify(received)) {
      // 不暴露 received token,不暴露内存 token,不暴露 remoteAddr。
      // 给攻击者最少的反馈,日志里只记一句拒绝事件。
      res.status(403).json({
        error: 'forbidden',
        message: '_internal 接口需要合法的 internal token',
      });
      const remoteAddr = req.socket?.remoteAddress;
      console.warn(`[cds-internal] reject internal request without valid token: remoteAddr=${remoteAddr} hasHeader=${received ? 'yes' : 'no'}`);
      return;
    }
    next();
  });

  /** POST /api/_internal/promote — supervisor 让 standby 转 active。幂等。 */
  router.post('/promote', async (_req, res) => {
    try {
      const wasActive = controller.isActive();
      await controller.promote();
      res.json({
        ok: true,
        mode: controller.mode(),
        wasActive,
        promotedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'promote-failed',
        message: (err as Error).message,
      });
    }
  });

  /** POST /api/_internal/standby — 反向降级(运维手动)。幂等。 */
  router.post('/standby', async (_req, res) => {
    try {
      const wasActive = controller.isActive();
      await controller.enterStandby();
      res.json({
        ok: true,
        mode: controller.mode(),
        wasActive,
        enteredAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'enter-standby-failed',
        message: (err as Error).message,
      });
    }
  });

  return router;
}

/** Deprecated:回环 IP 判断在 nginx 反代下永远 true,失去意义。仅保留导出供测试历史比对。 */
export function isLoopbackAddress(remoteAddr: string | undefined): boolean {
  if (!remoteAddr) return false;
  const v = remoteAddr.toLowerCase();
  return v === '127.0.0.1' || v === '::1' || v === '::ffff:127.0.0.1';
}
