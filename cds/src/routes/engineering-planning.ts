import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { PlanningActor } from '../shared/engineering-planning.js';
import type { EngineeringPlanningService } from '../services/engineering-planning.js';
import { PlanningError, planningId, rejectPlanning } from '../services/engineering-planning-input.js';

const route = '/projects/:projectId/planning';

export function normalizedPlanningPath(value: unknown): string | undefined {
  const path = String(value ?? '').split('?')[0].replace(/^\/_cds\/api\//i, '/api/').replace(/\/+$/, '');
  const match = path.match(/^\/api\/projects\/[^/]+\/planning(?:\/(capabilities|commands|debts|stats)(\/[^/]+)?)?$/i);
  if (!match) return undefined;
  return '/api/projects/:projectId/planning' + (match[1] ? '/' + match[1].toLowerCase() : '') + (match[2] ? '/:resourceId' : '');
}

export function createEngineeringPlanningRouter(deps: {
  service: EngineeringPlanningService;
  resolveAccess: (req: Request, projectId: string) => PlanningActor | null | Promise<PlanningActor | null>;
}): Router {
  const router = express.Router();
  function failure(error: unknown, res: Response) {
    if (error instanceof PlanningError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    res.status(503).json({ error: 'planning_unavailable', message: '工程规划暂时无法读取或保存，请稍后用原请求编号重试' });
  }
  function handler(run: (req: Request, res: Response, projectId: string, actor: PlanningActor) => unknown) {
    return async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const projectId = planningId(req.params.projectId, 'projectId');
        const actor = await deps.resolveAccess(req, projectId);
        if (!actor?.permissions.includes('read')) rejectPlanning(404, 'not_found', '没有可访问的工程规划项目');
        await run(req, res, projectId, actor);
      } catch (error) { failure(error, res); }
    };
  }
  router.get(route, handler(async (_req, res, projectId, actor) => res.json(await deps.service.board(projectId, actor))));
  router.get(`${route}/capabilities`, handler((_req, res, projectId, actor) => res.json(deps.service.capabilities(projectId, actor))));
  router.get(`${route}/debts`, handler(async (req, res, projectId) => res.json(await deps.service.debts(projectId, req.query))));
  router.get(`${route}/debts/:debtId`, handler(async (req, res, projectId) =>
    res.json(await deps.service.debt(projectId, planningId(req.params.debtId, 'debtId')))));
  router.get(`${route}/stats`, handler(async (req, res, projectId) => res.json(await deps.service.stats(projectId, req.query))));
  router.post(`${route}/commands`, express.json({ limit: '3mb' }), handler(async (req, res, projectId, actor) => {
    const receipt = await deps.service.command(projectId, actor, req.body);
    res.status(receipt.reused ? 200 : 201).json(receipt);
  }));
  router.use((error: { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (error?.status !== 400 && error?.status !== 413) { next(error); return; }
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(error.status).json({ error: 'invalid', message: error.status === 413 ? '工程规划提交过大，请分批提交' : '请提交有效的 JSON' });
  });
  return router;
}
