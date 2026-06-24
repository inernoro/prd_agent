/**
 * CDS 网络拓扑路由(B'.6,系统级)
 *
 * 对应 doc/design.cds.control-data-split.md §7.3
 * 对应 doc/report.cds.forwarder-success.md
 *
 * GET /api/cds-system/network-topology
 *   返回完整网络图(域名 / nginx upstream / forwarder / admin / containers / edges)
 *   供前端 ReactFlow 渲染。
 *
 * 认证:已挂在全局 auth middleware 之后(server.ts 在 createCdsSystemTopologyRouter 之前 use 了 auth)。
 *
 * 工厂签名 createCdsSystemTopologyRouter({ aggregator }) — aggregator 来自
 * services/topology-aggregator,所有 IO 都在 aggregator 内部 mock。Router 本身只
 * 做"调用 + 序列化",方便 server.ts wire dep 时把 aggregator 注入。
 */

import { Router } from 'express';

import type { TopologyAggregator } from '../services/topology-aggregator.js';

export interface CdsSystemTopologyRouterDeps {
  aggregator: TopologyAggregator;
}

export function createCdsSystemTopologyRouter(
  deps: CdsSystemTopologyRouterDeps,
): Router {
  const router = Router();

  router.get('/cds-system/network-topology', async (_req, res) => {
    try {
      const payload = await deps.aggregator.build();
      res.json(payload);
    } catch (err) {
      res.status(500).json({
        error: 'topology-aggregate-failed',
        message: (err as Error).message,
      });
    }
  });

  return router;
}
