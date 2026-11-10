import { Router, type Request, type Response } from 'express';
import { assertUnscopedAdmin } from '../services/unscoped-admin-guard.js';
import { MonitorOnboardingService, OnboardingError } from '../services/monitor-onboarding.js';

export function createMonitorOnboardingRouter(service: MonitorOnboardingService): Router {
  const router = Router();
  const error = (res: Response, e: unknown): void => {
    if (e instanceof OnboardingError) res.status(e.status).json({ error: e.message });
    else res.status(400).json({ error: '接入请求格式无效，请检查后重试。' });
  };
  const owner = (req: Request, res: Response): boolean => {
    const user = (req as Request & { cdsUser?: { isSystemOwner?: boolean } }).cdsUser;
    if (user && user.isSystemOwner !== true) { res.status(403).json({ error: '仅系统所有者可以管理监控接入会话。' }); return false; }
    const denied = assertUnscopedAdmin(req as unknown as Parameters<typeof assertUnscopedAdmin>[0]);
    if (denied) { res.status(denied.status).json(denied.body); return false; }
    return true;
  };
  const token = (req: Request): string => /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '')?.[1] || '';
  router.post('/uptime/onboarding', (req, res) => {
    if (!owner(req, res)) return;
    try { res.setHeader('Cache-Control', 'no-store'); res.status(201).json(service.create(req.body)); } catch (e) { error(res, e); }
  });
  router.get('/uptime/onboarding/:id', (req, res) => {
    if (!owner(req, res)) return;
    try { res.setHeader('Cache-Control', 'no-store'); res.json(service.view(req.params.id)); } catch (e) { error(res, e); }
  });
  router.delete('/uptime/onboarding/:id', (req, res) => {
    if (!owner(req, res)) return;
    try { service.revoke(req.params.id); res.json({ ok: true }); } catch (e) { error(res, e); }
  });
  router.post('/uptime/onboarding/:id/confirm', async (req, res) => {
    if (!owner(req, res)) return;
    try { res.status(201).json(await service.confirm(req.params.id, req.body || {})); } catch (e) { error(res, e); }
  });
  router.get('/uptime/onboarding-agent/:id/instructions', (req, res) => {
    try { res.setHeader('Cache-Control', 'no-store'); res.json(service.instructions(req.params.id, token(req), req.headers['x-agent-name'])); } catch (e) { error(res, e); }
  });
  router.post('/uptime/onboarding-agent/:id/proposals', (req, res) => {
    try { res.status(202).json(service.submit(req.params.id, token(req), req.body)); } catch (e) { error(res, e); }
  });
  return router;
}
