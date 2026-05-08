/**
 * CDS Internal routes — supervisor 与 daemon 之间的私有控制面(B'.2)
 *
 * 端点:
 *   POST /api/_internal/promote         standby → active
 *   POST /api/_internal/standby         active → standby
 *
 * 安全模型:
 *   - 严格回环 IP 校验:req.socket.remoteAddress 必须是 127.0.0.1 / ::1 / ::ffff:127.0.0.1
 *   - **不**信任 X-Forwarded-For / X-Real-IP / Forwarded 头(防伪造,C-4.1)
 *   - supervisor 永远从同一台主机的 127.0.0.1 调,所以这条规则不会误伤
 *
 * 与 standby-guard 的关系:
 *   - guard 已豁免 _internal/* 路径,所以即使在 standby 模式 promote 请求也能到达本路由
 *   - 本路由的回环校验是第二道防线(纵深防御)
 */

import express from 'express';
import type { StandbyController } from '../services/standby-controller.js';

export interface CdsInternalRouterDeps {
  controller: StandbyController;
}

/** 判断 socket 远端是否是回环地址。Node 把 IPv4 over IPv6 写成 ::ffff:127.0.0.1。 */
export function isLoopbackAddress(remoteAddr: string | undefined): boolean {
  if (!remoteAddr) return false;
  const v = remoteAddr.toLowerCase();
  return v === '127.0.0.1'
    || v === '::1'
    || v === '::ffff:127.0.0.1';
}

export function createCdsInternalRouter(deps: CdsInternalRouterDeps): express.Router {
  const router = express.Router();
  const { controller } = deps;

  // 通用回环校验 middleware:每个 _internal/* 端点都过一遍。
  router.use((req, res, next) => {
    const remoteAddr = req.socket?.remoteAddress;
    if (!isLoopbackAddress(remoteAddr)) {
      res.status(403).json({
        error: 'forbidden',
        message: '_internal 接口仅接受回环(127.0.0.1)请求',
        // 不暴露 remoteAddr 避免给攻击者反馈,但日志里打,运维能看
      });
      console.warn(`[cds-internal] reject non-loopback request: remoteAddr=${remoteAddr}`);
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
