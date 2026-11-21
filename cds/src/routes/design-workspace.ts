import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { designId, designPackageLimit } from '../services/design-package.js';
import { decorateDesignPrototype, designPrototypeCsp } from '../services/design-prototype.js';
import type { DesignActor, DesignWorkspaceService } from '../services/design-workspace.js';
import { PlanningError, planningId, rejectPlanning } from '../services/engineering-planning-input.js';
import type { DesignReviewer } from '../shared/design-workspace.js';

const route = '/projects/:projectId/design';
const normalize = /^(?:\/_cds)?\/api\/projects\/[^/]+\/design(?:\/(packages|commands|reviewers|artifacts\/[^/]+))?\/?$/i;
export function normalizedDesignPath(value: unknown): string | undefined {
  const path = String(value ?? '').split('?')[0];
  if (/^(?:\/_cds)?\/api\/auth\/design\/notices\/?$/i.test(path)) return '/api/auth/design/notices';
  const match = path.match(normalize);
  if (!match) return undefined;
  return '/api/projects/:projectId/design' + (match[1] ? '/' + match[1].toLowerCase().replace(/^artifacts\/.+$/, 'artifacts/:artifactId') : '');
}

export function createDesignWorkspaceRouter(deps: {
  service: DesignWorkspaceService;
  resolveAccess: (req: Request, projectId: string) => DesignActor | null | Promise<DesignActor | null>;
  reviewCandidates?: (projectId: string) => Promise<DesignReviewer[]>;
}): Router {
  const router = express.Router();
  function failure(error: unknown, res: Response) {
    if (error instanceof PlanningError) {
      res.status(error.status).json({ error: error.code, message: error.message });
    } else {
      res.status(503).json({ error: 'design_unavailable', message: '设计工作区暂不可用，请使用原请求编号重试' });
    }
  }
  async function authorized(req: Request, res: Response, next: NextFunction) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const projectId = planningId(req.params.projectId, 'projectId');
      const actor = await deps.resolveAccess(req, projectId);
      if (!actor?.permissions.includes('read')) return rejectPlanning(404, 'design_not_found', '没有可访问的设计项目');
      res.locals.designAccess = { actor, projectId };
      next();
    } catch (error) { failure(error, res); }
  }
  function handle(run: (req: Request, res: Response, projectId: string, actor: DesignActor) => unknown) {
    return async (req: Request, res: Response) => {
      const { projectId, actor } = res.locals.designAccess as { projectId: string; actor: DesignActor };
      try { await run(req, res, projectId, actor); } catch (error) { failure(error, res); }
    };
  }

  router.get(route, authorized, handle(async (_req, res, projectId, actor) => res.json(await deps.service.workspace(projectId, actor))));
  router.get(`${route}/reviewers`, authorized, handle(async (_req, res, projectId) => {
    res.json({ projectId, reviewers: await deps.reviewCandidates?.(projectId) ?? [] });
  }));
  router.post(`${route}/packages`, authorized, express.raw({ type: 'application/zip', limit: designPackageLimit, inflate: false }),
    handle(async (req, res, projectId, actor) => {
      const info = await deps.service.publish(projectId, actor, req.query, req.body);
      res.status(info.reused ? 200 : 201).json(info);
    }));
  router.post(`${route}/commands`, authorized, express.json({ limit: '8mb' }),
    handle(async (req, res, projectId, actor) => {
      const info = await deps.service.command(projectId, actor, req.body);
      res.status(info.reused ? 200 : 201).json(info);
    }));
  router.get(`${route}/artifacts/:id`, authorized, handle(async (req, res, projectId, actor) => {
    const artifact = await deps.service.artifact(projectId, actor, designId(req.params.id, '稿件附件'));
    res.setHeader('Content-Type', artifact.mime);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (artifact.mime.startsWith('text/html')) {
      res.setHeader('Content-Security-Policy', designPrototypeCsp);
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    }
    if (artifact.mime.startsWith('text/html') && (req.query.theme === 'light' || req.query.theme === 'dark')) {
      res.send(decorateDesignPrototype(artifact.bytes.toString('utf8')));
      return;
    }
    res.send(artifact.bytes);
  }));
  router.use((error: { status?: number }, req: Request, res: Response, next: NextFunction) => {
    if (!res.locals.designAccess || ![400, 413, 415].includes(error.status ?? 0)) return next(error);
    res.status(error.status!).json({ error: 'invalid_design', message: error.status === 413 ? '稿件或证据超过体积限制' : '请按设计接口提交有效的 ZIP 或 JSON' });
  });
  return router;
}
