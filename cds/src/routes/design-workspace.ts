import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { designId, designPackageLimit, invalidDesign } from '../services/design-package.js';
import { decorateDesignPrototype, designPrototypeCsp } from '../services/design-prototype.js';
import type { DesignShareHandoffConfig } from '../services/design-share-handoff.js';
import type { DesignActor, DesignWorkspaceRead, DesignWorkspaceService } from '../services/design-workspace.js';
import { PlanningError, planningId, rejectPlanning } from '../services/engineering-planning-input.js';
import type { DesignReviewer } from '../shared/design-workspace.js';

const route = '/projects/:projectId/design';
const readVersion = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
const normalize = /^(?:\/_cds)?\/api\/projects\/[^/]+\/design(?:\/(packages|commands|acceptance\/recheck|feedback(?:\/attachments)?|reviewers|intake|diff|installed|viewed|artifacts\/[^/]+|shares\/[^/]+\/handoff))?\/?$/i;
export function normalizedDesignPath(value: unknown): string | undefined {
  const path = String(value ?? '').split('?')[0];
  if (/^(?:\/_cds)?\/api\/auth\/design\/notices\/?$/i.test(path)) return '/api/auth/design/notices';
  const match = path.match(normalize);
  if (!match) return undefined;
  return '/api/projects/:projectId/design' + (match[1] ? '/' + match[1].toLowerCase().replace(/^artifacts\/.+$/, 'artifacts/:artifactId')
    .replace(/^shares\/[^/]+\/handoff$/, 'shares/:preparationId/handoff') : '');
}

export function createDesignWorkspaceRouter(deps: {
  service: DesignWorkspaceService;
  resolveAccess: (req: Request, projectId: string) => DesignActor | null | Promise<DesignActor | null>;
  reviewCandidates?: (projectId: string) => Promise<DesignReviewer[]>;
  mapShareHandoff?: () => DesignShareHandoffConfig | undefined;
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

  router.get(route, authorized, handle(async (req, res, projectId, actor) => {
    const { view, designId: id, version, fromVersion } = req.query;
    let projection: DesignWorkspaceRead | undefined;
    if (view === 'summary' && id === undefined && version === undefined && fromVersion === undefined) projection = { summary: true };
    else if (view === undefined && id !== undefined) projection = { designId: designId(id, '稿件编号'),
      ...(version === undefined ? {} : { version: readVersion(version) }),
      ...(fromVersion === undefined ? {} : { fromVersion: readVersion(fromVersion) }) };
    else if (view !== undefined || version !== undefined || fromVersion !== undefined) return invalidDesign('请指定稿件和需要读取的版本');
    res.json(await deps.service.workspace(projectId, actor, projection));
  }));
  router.get(`${route}/intake`, authorized, handle(async (_req, res, projectId, actor) => res.json(await deps.service.intake(projectId, actor))));
  router.get(`${route}/diff`, authorized, handle(async (req, res, projectId, actor) => {
    res.json(await deps.service.diff(projectId, actor, designId(req.query.designId, '稿件编号'), readVersion(req.query.from), readVersion(req.query.to)));
  }));
  router.get(`${route}/installed`, authorized, handle(async (_req, res, projectId, actor) => {
    res.json(await deps.service.installed(projectId, actor));
  }));
  router.post(`${route}/viewed`, authorized, express.json({ limit: '2kb' }),
    handle(async (req, res, projectId, actor) => res.json(await deps.service.viewed(projectId, actor, req.body))));
  router.get(`${route}/reviewers`, authorized, handle(async (_req, res, projectId) => {
    res.json({ projectId, reviewers: await deps.reviewCandidates?.(projectId) ?? [] });
  }));
  router.post(`${route}/packages`, authorized, express.raw({ type: 'application/zip', limit: designPackageLimit, inflate: false }),
    handle(async (req, res, projectId, actor) => {
      const info = await deps.service.publish(projectId, actor, req.query, req.body);
      res.status(info.reused ? 200 : 201).json(info);
    }));
  router.post(`${route}/feedback`, authorized, express.json({ limit: '48kb' }),
    handle(async (req, res, projectId, actor) => {
      const receipt = await deps.service.feedback(projectId, actor, req.body);
      res.status(receipt.reused ? 200 : 201).json(receipt);
    }));
  router.post(`${route}/feedback/attachments`, authorized, express.json({ limit: '2.1mb', inflate: false }),
    handle(async (req, res, projectId, actor) => {
      if (req.body?.type !== 'feedback.attach') return invalidDesign('请提交反馈对照图');
      const receipt = await deps.service.feedback(projectId, actor, req.body);
      res.status(receipt.reused ? 200 : 201).json(receipt);
    }));
  router.post(`${route}/commands`, authorized, express.json({ limit: '8mb' }),
    handle(async (req, res, projectId, actor) => {
      const info = await deps.service.command(projectId, actor, req.body);
      res.status(info.reused ? 200 : 201).json(info);
    }));
  router.post(`${route}/acceptance/recheck`, authorized, express.json({ limit: '2kb' }),
    handle(async (req, res, projectId, actor) => {
      if (req.body?.type !== 'acceptance.recheck') return invalidDesign('请提交独立复验请求');
      const info = await deps.service.command(projectId, actor, req.body);
      res.status(info.reused ? 200 : 201).json(info);
    }));
  router.post(`${route}/shares/:preparationId/handoff`, authorized, express.json({ limit: '2kb' }),
    handle(async (req, res, projectId, actor) => {
      res.json(await deps.service.shareHandoff(projectId, actor, designId(req.params.preparationId, '分享准备编号'), req.body,
        deps.mapShareHandoff?.()));
    }));
  router.get(`${route}/artifacts/:id`, authorized, handle(async (req, res, projectId, actor) => {
    const artifactId = designId(req.params.id, '稿件附件');
    const artifact = await deps.service.artifact(projectId, actor, artifactId);
    if (req.query.view === 'text') {
      if (!artifact.file?.text) return invalidDesign('这个附件可下载，无法按 UTF-8 文本读取');
      const parse = (value: unknown, fallback: number) => value === undefined ? fallback
        : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
      const offset = parse(req.query.offset, 0);
      const limit = parse(req.query.limit, 12_000);
      const content = artifact.bytes.toString('utf8');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length
        || !Number.isInteger(limit) || limit < 1 || limit > 16_000) return invalidDesign('请使用有效的文本起点及长度');
      let end = Math.min(offset + limit, content.length);
      const nextChar = content.charCodeAt(end);
      if (nextChar >= 0xdc00 && nextChar <= 0xdfff) end++;
      return res.json({ artifactId, path: artifact.file.path, sha256: artifact.file.sha256, offset,
        nextOffset: end < content.length ? end : null, text: content.slice(offset, end) });
    }
    const attachment = artifact.attachment ?? (req.query.download === 'true' ? artifact.file?.path.split('/').at(-1) : undefined);
    if (attachment) res.attachment(attachment);
    res.setHeader('Content-Type', artifact.mime);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (artifact.mime.startsWith('text/html')) {
      // CDN rewriting can inject analytics into an immutable sandboxed document.
      res.setHeader('Cache-Control', 'private, no-store, no-transform');
      res.setHeader('Content-Security-Policy', designPrototypeCsp);
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    }
    if (artifact.mime.startsWith('text/html') && (req.query.theme === 'light' || req.query.theme === 'dark')) {
      res.send(decorateDesignPrototype(artifact.bytes.toString('utf8')));
      return;
    }
    if (artifact.mime === 'video/mp4') {
      const size = artifact.bytes.length;
      res.setHeader('Accept-Ranges', 'bytes');
      const ranges = req.range(size);
      if (ranges === -1) {
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.sendStatus(416);
      }
      if (Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1) {
        const [{ start, end }] = ranges;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        return res.status(206).send(artifact.bytes.subarray(start, end + 1));
      }
    }
    res.send(artifact.bytes);
  }));
  router.use((error: { status?: number }, req: Request, res: Response, next: NextFunction) => {
    if (!res.locals.designAccess || ![400, 413, 415].includes(error.status ?? 0)) return next(error);
    if (error.status === 413 && normalizedDesignPath(req.originalUrl) === '/api/projects/:projectId/design/packages') {
      return res.status(413).json({ error: 'G-09', message: 'G-09 稿件包超过压缩体积限制' });
    }
    res.status(error.status!).json({ error: 'invalid_design', message: error.status === 413 ? '稿件或证据超过体积限制' : '请按设计接口提交有效的 ZIP 或 JSON' });
  });
  return router;
}
