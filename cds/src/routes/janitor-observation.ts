import { Router } from 'express';
import type { JanitorService } from '../services/janitor.js';
import { isAuthenticatedHuman, isHumanSystemOwner } from '../services/human-auth.js';

export function createJanitorObservationRouter(service?: Pick<JanitorService, 'previewDeploymentSources'>): Router {
  const router = Router();
  router.get('/janitor/deployment-sources', async (req, res) => {
    if (!service) { res.status(503).json({ error: '源码回收观测尚未接入' }); return; }
    const projectId = (req as unknown as { cdsProjectKey?: { projectId: string } }).cdsProjectKey?.projectId;
    if (!projectId && isAuthenticatedHuman(req) && !isHumanSystemOwner(req)) {
      res.status(403).json({ error: '完整宿主盘点需要系统所有者身份；Agent 请使用项目授权。' }); return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000); timer.unref();
    res.on('close', () => ctrl.abort());
    try { res.json(await service.previewDeploymentSources(projectId, ctrl.signal)); }
    catch { res.status(503).json({ error: '无法完整查询源码回收候选，相关对象保持保护，请稍后重试。' }); }
    finally { clearTimeout(timer); }
  });
  return router;
}
