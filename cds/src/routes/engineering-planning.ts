import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { PlanningActor, PlanningCheckupRead } from '../shared/engineering-planning.js';
import type { EngineeringPlanningService } from '../services/engineering-planning.js';
import { PlanningError, planningId, rejectPlanning } from '../services/engineering-planning-input.js';

const route = '/projects/:projectId/planning';

export function normalizedPlanningPath(value: unknown): string | undefined {
  const path = String(value ?? '').split('?')[0].replace(/^\/_cds\/api\//i, '/api/').replace(/\/+$/, '');
  const match = path.match(/^\/api\/projects\/[^/]+\/planning(?:\/(capabilities|commands|decisions|changes|preview|debts|stats|evidence|duplicates|import-preview|checkup)(\/[^/]+)?)?$/i);
  if (!match) return undefined;
  if (match[1]?.toLowerCase() === 'checkup' && match[2]?.toLowerCase() === '/read') return '/api/projects/:projectId/planning/checkup/read';
  return '/api/projects/:projectId/planning' + (match[1] ? '/' + match[1].toLowerCase() : '') + (match[2] ? '/:resourceId' : '');
}

function parseCheckupRead(input: unknown): PlanningCheckupRead {
  if (input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 1) {
    const value = input as Record<string, unknown>;
    if (value.all === true) return { all: true };
    if (value.id !== undefined) return { id: planningId(value.id, 'id') };
  }
  return rejectPlanning(400, 'invalid', '请选择一条通知或标记全部已读');
}

export function createEngineeringPlanningRouter(deps: {
  service: EngineeringPlanningService;
  resolveAccess: (req: Request, projectId: string) => PlanningActor | null | Promise<PlanningActor | null>;
  resolveChanges?: (projectId: string, branchId: string | undefined, includeArchive: boolean) => unknown | Promise<unknown>;
  resolvePreviewEntry?: (projectId: string, number: number, path: unknown, actor: PlanningActor) => unknown | Promise<unknown>;
}): Router {
  const router = express.Router();
  function failure(error: unknown, res: Response) {
    if (error instanceof PlanningError) {
      res.status(error.status).json({ error: error.code, message: error.message, ...(error.candidates ? { candidates: error.candidates } : {}) });
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
  router.get(route, handler(async (req, res, projectId, actor) => res.json(await deps.service.board(projectId, actor, req.query.timeline === '1'))));
  router.get(`${route}/capabilities`, handler((_req, res, projectId, actor) => res.json(deps.service.capabilities(projectId, actor))));
  router.get(`${route}/decisions`, handler(async (req, res, projectId) => res.json(await deps.service.decisions(projectId, req.query))));
  if (deps.resolveChanges) router.get(`${route}/changes`, handler(async (req, res, projectId) => {
    const branchId = req.query.branchId === undefined ? undefined : planningId(req.query.branchId, 'branchId');
    const includeArchive = req.query.archive === '1';
    const changes = await deps.resolveChanges!(projectId, branchId, includeArchive);
    if (includeArchive) res.attachment('cds-config-changes.json');
    res.json(changes);
  }));
  if (deps.resolvePreviewEntry) router.get(`${route}/preview/:number`, handler(async (req, res, projectId, actor) => {
    const number = Number(req.params.number);
    if (!/^[1-9]\d*$/.test(req.params.number) || !Number.isSafeInteger(number)) return rejectPlanning(400, 'invalid', '请填写有效的 PR 编号');
    res.json(await deps.resolvePreviewEntry!(projectId, number, req.query.path, actor));
  }));
  router.get(`${route}/debts`, handler(async (req, res, projectId) => res.json(await deps.service.debts(projectId, req.query))));
  router.get(`${route}/debts/:debtId`, handler(async (req, res, projectId) =>
    res.json(await deps.service.debt(projectId, planningId(req.params.debtId, 'debtId')))));
  router.get(`${route}/duplicates`, handler(async (req, res, projectId) =>
    res.json(await deps.service.duplicates(projectId, req.query.title))));
  router.get(`${route}/stats`, handler(async (req, res, projectId) => res.json(await deps.service.stats(projectId, req.query))));
  router.get(`${route}/checkup`, handler(async (_req, res, projectId, actor) =>
    res.json(await deps.service.checkup(projectId, actor))));
  router.post(`${route}/checkup/read`, express.json({ limit: '4kb' }), handler(async (req, res, projectId, actor) =>
    res.json(await deps.service.markCheckupRead(projectId, actor, parseCheckupRead(req.body)))));
  router.post(`${route}/import-preview`, express.json({ limit: '3mb' }), handler(async (req, res, projectId, actor) =>
    res.json(await deps.service.previewImport(projectId, actor, req.body))));
  router.get(`${route}/evidence/:imageId`, handler(async (req, res, projectId) => {
    const image = await deps.service.evidenceAsset(projectId, planningId(req.params.imageId, 'imageId'));
    res.setHeader('Content-Type', image.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.send(image.bytes);
  }));
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
