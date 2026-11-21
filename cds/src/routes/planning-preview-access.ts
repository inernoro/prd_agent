import express, { type Request, type Router } from 'express';
import type { CdsUser } from '../domain/auth.js';
import { isAuthenticatedHuman, isHumanSystemOwner } from '../services/human-auth.js';
import { previewReturnPath, type PlanningPreviewAccess, type PreviewAccessClient, type PreviewAccessPerson } from '../services/planning-preview-access.js';
import { planningText, PlanningError } from '../services/engineering-planning-input.js';

export function normalizedPreviewAccessPath(value: unknown): string | undefined {
  const path = String(value ?? '').split('?')[0].replace(/^\/_cds\/api\//i, '/api/').replace(/\/+$/, '');
  if (/^\/preview\/authorize$|^\/preview-access$/i.test(path)) return path.toLowerCase();
  if (/^\/api\/auth\/(?:preview\/(?:token|access|requests|notices)|sso\/(?:start|exchange))$/i.test(path)) return path.toLowerCase();
  if (/^\/api\/projects\/[^/]+\/planning\/preview\/[^/]+$/i.test(path)) return '/api/projects/:projectId/planning/preview/:number';
  return undefined;
}

function human(req: Request): PreviewAccessPerson | undefined {
  const request = req as Request & { cdsUser?: CdsUser; cdsProjectKey?: unknown; cdsAccess?: unknown; _aiSession?: unknown };
  const user = request.cdsUser;
  if (!user || !isAuthenticatedHuman(req) || user.id === 'anonymous' || user.status !== 'active'
    || request.cdsProjectKey || request.cdsAccess || request._aiSession) return undefined;
  return { id: user.id, username: user.username || user.githubLogin, name: user.name || user.username || user.githubLogin, owner: isHumanSystemOwner(req) };
}

export function createPreviewTokenRouter(service: PlanningPreviewAccess): Router {
  const router = express.Router();
  router.post('/api/auth/preview/token', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    try {
      const result = await service.consume(req.body ?? {});
      if (result) return res.json({ success: true, data: result });
      res.status(401).json({ success: false, error: { message: '预览进入票据无效、已使用或已过期' } });
    } catch {
      res.status(503).json({ success: false, error: { message: '暂时无法核对预览访问权限' } });
    }
  });
  return router;
}

export function createPlanningPreviewAccessRouter(
  service: PlanningPreviewAccess, projectIds: () => string[], decisionLink: (client: PreviewAccessClient) => Promise<string | undefined>,
): Router {
  const router = express.Router();
  router.get('/preview/authorize', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const person = human(req);
    if (!person) return res.redirect(303, '/login?redirect=' + encodeURIComponent(req.originalUrl));
    try {
      const client = await service.client(req.query.client_id);
      if (!client || req.query.redirect_uri !== client.callback) return res.status(404).send('预览链接已失效或预览未开通 CDS 登录');
      const path = previewReturnPath(req.query.return_to ?? client.path);
      if (!path) return res.status(400).send('预览入口不在允许的路径内');
      const destination = await service.issue(client, person, req.query.state, req.query.redirect_uri);
      if (destination) return res.redirect(303, destination);
      res.redirect(303, '/preview-access?' + new URLSearchParams({ client: client.id, path }).toString());
    } catch { res.status(503).send('暂时无法核对预览访问权限'); }
  });
  router.get('/api/auth/preview/access', async (req, res) => {
    res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    const person = human(req);
    if (!person) return res.status(401).json({ message: '请先登录 CDS' });
    try {
      const request = req.query.request === undefined ? undefined : await service.findRequest(projectIds(), req.query.request, person);
      if (req.query.request !== undefined && !request) return res.status(404).json({ message: '没有可访问的预览申请' });
      const client = await service.client(request?.clientId ?? req.query.client);
      if (!client) return res.status(404).json({ message: '预览链接已失效' });
      if (request && (request.projectId !== client.projectId || request.branchId !== client.branchId)) {
        return res.status(404).json({ message: '预览链接已失效' });
      }
      const path = previewReturnPath(request ? request.returnPath ?? client.path : req.query.path ?? client.path);
      if (!path) return res.status(400).json({ message: '预览路径无效' });
      const allowed = await service.allowed(person, client.projectId);
      const pending = allowed ? undefined : request ?? (await service.requests(client.projectId))
        .find(row => row.clientId === client.id && row.branchId === client.branchId && row.subject === person.id);
      const startUrl = new URL('/api/auth/sso/start', client.origin);
      startUrl.searchParams.set('redirect', path);
      const decisionUrl = allowed ? await decisionLink(client).catch(() => undefined) : undefined;
      res.json({ project: client.projectName, branch: client.branchName, pullRequest: client.pullRequest,
        state: allowed ? 'ready' : pending ? 'requested' : 'forbidden',
        ...(pending ? { requestedAt: pending.createdAt } : {}),
        ...(allowed ? { startUrl: startUrl.href, decisionUrl } : {}) });
    } catch { res.status(503).json({ message: '暂时无法读取预览访问权限' }); }
  });
  router.post('/api/auth/preview/access', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const person = human(req);
    if (!person) return res.status(401).json({ message: '请先登录 CDS' });
    if (req.headers['sec-fetch-site'] === 'cross-site' || !req.is('application/json')) return res.status(403).json({ message: '请在 CDS 页面发起申请' });
    try {
      const client = await service.client(req.body?.client);
      if (!client) return res.status(404).json({ message: '预览链接已失效' });
      const path = previewReturnPath(req.body?.path ?? client.path);
      if (!path) return res.status(400).json({ message: '预览路径无效' });
      const value = req.body?.note;
      const note = value === undefined || typeof value === 'string' && !value.trim() ? '' : planningText(value, '申请说明', 300);
      const request = await service.request(client, person, note, path);
      res.status(request ? 201 : 200).json(request ? { state: 'requested', id: request.id } : { state: 'ready' });
    } catch (error) {
      res.status(error instanceof PlanningError ? error.status : 503).json({ message: error instanceof PlanningError ? error.message : '暂时无法保存申请' });
    }
  });
  router.get('/api/auth/preview/notices', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const person = human(req);
    if (!person) return res.status(401).json({ message: '请先登录 CDS' });
    try {
      const notices = await service.notices(projectIds(), person);
      res.locals.cdsSkipHttpLog = true;
      res.json(notices);
    }
    catch { res.status(503).json({ message: '暂时无法读取预览访问通知' }); }
  });
  router.get('/api/auth/preview/requests', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!isHumanSystemOwner(req)) return res.status(403).json({ message: '请由 CDS 系统所有者处理访问申请' });
    try {
      const lists = await Promise.all(projectIds().map(project => service.requests(project)));
      const requests = await Promise.all(lists.flat().map(async ({ returnPath: _returnPath, ...row }) => ({ ...row,
        state: await service.allowed({ id: row.subject, username: row.name, name: row.name, owner: false }, row.projectId) ? 'ready' : 'requested',
      })));
      res.json({ requests });
    } catch { res.status(503).json({ message: '暂时无法读取预览访问申请' }); }
  });
  return router;
}
