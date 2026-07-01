import { Router } from 'express';
import { DockerNetworkHealthService } from '../services/docker-network-health.js';
import type { IShellExecutor } from '../types.js';

export function createDockerNetworkHealthRouter(deps: { shell: IShellExecutor }): Router {
  const router = Router();
  const service = new DockerNetworkHealthService(deps.shell);

  router.get('/cds-system/docker-networks', async (_req, res) => {
    try {
      const result = await service.collect();
      if (!result.ok) {
        res.status(503).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({
        ok: false,
        timestamp: new Date().toISOString(),
        error: (err as Error).message,
      });
    }
  });

  return router;
}
