import { Router } from 'express';
import { isHumanSystemOwner } from '../services/human-auth.js';
import type { HostCapacityObservationService } from '../services/host-capacity-observation.js';

export function createHostCapacityObservationRouter(service: HostCapacityObservationService): Router {
  const router = Router();
  router.get('/host-capacity/observation', (req, res) => {
    if ((req as any).cdsProjectKey || !isHumanSystemOwner(req)) {
      res.status(403).json({ error: '仅 CDS 系统所有者可查看宿主容量观测' }); return;
    }
    res.json(service.getSnapshot());
  });
  return router;
}
