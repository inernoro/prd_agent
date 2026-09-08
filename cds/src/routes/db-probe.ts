// 分支级库探测（收敛 0「可信数据面」，2026-09-03）
//
//   GET /api/branches/:id/db-probe[?profileId=]
//     → 每个服务三列：配置说的（折算）/ 容器持有（docker inspect）/ 连上的库（应用凭据实测）
//       + 机器判定与人话原因。只读，不写库，不落密码。
//
// 探测本体在 services/db-probe.ts；这里只做分支归属鉴权与参数解析。
// 项目归属经分支反查后走 assertProjectAccess（与 replica-sets 路由同款）。

import { Router, type Request } from 'express';
import type { StateService } from '../services/state.js';
import { probeBranchDb, type DbProbeExec } from '../services/db-probe.js';

export interface DbProbeRouterDeps {
  stateService: StateService;
  assertProjectAccess: (req: Request, projectId: string) => { status: number; body: unknown } | null;
  /** 测试注入；生产走 runDockerExec */
  exec?: DbProbeExec;
}

export function createDbProbeRouter(deps: DbProbeRouterDeps): Router {
  const router = Router();

  router.get('/branches/:id/db-probe', async (req, res) => {
    const branch = deps.stateService.getBranch(req.params.id);
    if (!branch) { res.status(404).json({ error: `分支不存在: ${req.params.id}` }); return; }
    const access = deps.assertProjectAccess(req, branch.projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    const profileId = typeof req.query.profileId === 'string' && req.query.profileId.trim() ? req.query.profileId.trim() : undefined;
    try {
      const report = await probeBranchDb(deps.stateService, branch.id, { profileId, exec: deps.exec });
      res.json(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(/不存在/.test(message) ? 404 : 500).json({ error: message });
    }
  });

  return router;
}
