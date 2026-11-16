import { Router } from 'express';
import { isHumanSystemOwner } from '../services/human-auth.js';
import type { HostCapacitySamplingService } from '../services/host-capacity-sampling.js';
export function createHostCapacitySamplingRouter(service: HostCapacitySamplingService): Router {
  const router = Router();
  router.use('/host-capacity/sampling', (req, res, next) => {
    if ((req as any).cdsProjectKey || !isHumanSystemOwner(req)) {
      res.status(403).json({ error: '仅 CDS 系统所有者可配置只读容量采样' }); return;
    }
    next();
  });
  router.get('/host-capacity/sampling', (_req, res) => res.json(service.getStatus()));
  router.put('/host-capacity/sampling', async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean' || Object.keys(req.body).some(k => k !== 'enabled')) {
      res.status(400).json({ error: '只接受容量采样启用开关，不接受目录、命令或阈值' }); return;
    }
    try { await service.setEnabled(req.body.enabled); res.json(service.getStatus()); }
    catch { res.status(409).json({ error: '容量采样配置未能确认，请检查持久存储或已有外部采样配置后重试' }); }
  });
  router.post('/host-capacity/sampling/run', (req, res) => {
    if (Object.keys(req.body || {}).length || Object.keys(req.query).length) {
      res.status(400).json({ error: '立即采样不接受目录或命令参数' }); return;
    }
    try { service.requestSample(); res.status(202).json(service.getStatus()); }
    catch { res.status(409).json({ error: '容量采样未启用、正在保存配置或已有采样在运行，请稍后重试' }); }
  });
  return router;
}
