import { Router } from 'express';
import type { Project } from '../types.js';
import { parseProjectInspection, type ProjectInspection } from '../services/project-inspections.js';
import { assertUnscopedAdmin } from '../services/unscoped-admin-guard.js';
import { projectScopeOf } from './uptime.js';
import { assertProjectAccess } from './projects.js';

export function createProjectInspectionsRouter(store: {
  getProject(id: string): Project | undefined;
  save(projectId: string, inspections: ProjectInspection[]): void;
}): Router {
  const router = Router();
  router.get('/projects/:id/inspection-checks', (req, res) => {
    const project = store.getProject(String(req.params.id));
    const denied = assertProjectAccess(req as Parameters<typeof assertProjectAccess>[0], project?.id || String(req.params.id));
    if (denied) { res.status(denied.status).json(denied.body); return; }
    if (!project) { res.status(404).json({ message: '项目不存在' }); return; }
    res.json({ projectId: project.id, inspections: project.monitoringInspections ?? [] });
  });
  router.put('/projects/:id/inspection-checks/:inspectionId', (req, res) => {
    const project = store.getProject(String(req.params.id)), scope = projectScopeOf(req);
    const accessDenied = assertProjectAccess(req as Parameters<typeof assertProjectAccess>[0], project?.id || String(req.params.id));
    if (accessDenied) { res.status(accessDenied.status).json(accessDenied.body); return; }
    if (!scope) { const denied = assertUnscopedAdmin(req as Parameters<typeof assertUnscopedAdmin>[0]); if (denied) { res.status(denied.status).json(denied.body); return; } }
    if (!project) { res.status(404).json({ message: '项目不存在' }); return; }
    try {
      const actor = scope ? `project:${scope}` : (req as unknown as { cdsUser?: { username?: string } }).cdsUser?.username || 'admin-api';
      const next = parseProjectInspection(String(req.params.inspectionId), req.body, actor);
      const entries = project.monitoringInspections ?? [], previous = entries.find(i => i.id === next.id);
      if (previous?.lastCompletedAt && (!next.lastCompletedAt || Date.parse(next.lastCompletedAt) < Date.parse(previous.lastCompletedAt))) { res.status(409).json({ message: '不能用旧巡检覆盖较新的检查结果' }); return; }
      if (!previous && entries.length >= 50) { res.status(409).json({ message: '项目巡检计划数量已达上限' }); return; }
      next.registeredAt = previous?.registeredAt || next.registeredAt;
      store.save(project.id, [...entries.filter(i => i.id !== next.id), next]);
      res.json({ inspection: next });
    } catch (error) { res.status(400).json({ message: (error as Error).message }); }
  });
  return router;
}
