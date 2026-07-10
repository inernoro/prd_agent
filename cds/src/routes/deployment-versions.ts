import { Router, type Request } from 'express';
import type { DeploymentVersion } from '../types.js';
import type { DeploymentVersionService } from '../services/deployment-version.js';

export interface VersionDispatchResult {
  accepted: boolean;
  status: number;
  runId?: string;
  error?: string;
}

export interface DeploymentVersionsRouterDeps {
  deploymentVersionService: DeploymentVersionService;
  assertProjectAccess: (req: Request, projectId: string) => { status: number; body: unknown } | null;
  dispatchVersion: (version: DeploymentVersion, trigger: 'manual' | 'rollback') => Promise<VersionDispatchResult>;
}

export function createDeploymentVersionsRouter(deps: DeploymentVersionsRouterDeps): Router {
  const router = Router();

  router.get('/deployment-versions', (req, res) => {
    const projectKey = (req as Request & { cdsProjectKey?: { projectId: string } }).cdsProjectKey;
    const requestedProject = cleanQuery(req.query.project) || cleanQuery(req.query.projectId);
    const projectId = requestedProject || projectKey?.projectId;
    if (projectId) {
      const access = deps.assertProjectAccess(req, projectId);
      if (access) { res.status(access.status).json(access.body); return; }
    }
    const versions = deps.deploymentVersionService.list({
      projectId,
      branchId: cleanQuery(req.query.branch) || cleanQuery(req.query.branchId),
      commitSha: cleanQuery(req.query.commit) || cleanQuery(req.query.commitSha),
    });
    res.json({ versions, total: versions.length });
  });

  router.get('/deployment-versions/:id', (req, res) => {
    const version = deps.deploymentVersionService.get(req.params.id);
    if (!version) { res.status(404).json({ error: '部署版本不存在' }); return; }
    const access = deps.assertProjectAccess(req, version.projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    res.json({ version });
  });

  router.post('/deployment-versions/:id/deploy', async (req, res) => {
    const version = deps.deploymentVersionService.get(req.params.id);
    if (!version) { res.status(404).json({ error: '部署版本不存在' }); return; }
    const access = deps.assertProjectAccess(req, version.projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      deps.deploymentVersionService.assertReusable(version);
    } catch (err) {
      res.status(409).json({
        error: 'deployment_version_not_reusable',
        message: (err as Error).message,
        versionId: version.id,
      });
      return;
    }
    const result = await deps.dispatchVersion(version, 'manual');
    if (!result.accepted) {
      res.status(result.status || 500).json({ error: result.error || '版本部署未被接受', versionId: version.id });
      return;
    }
    res.status(202).json({
      accepted: true,
      versionId: version.id,
      branchId: version.branchId,
      runId: result.runId,
      streamUrl: result.runId ? `/api/deployment-runs/${result.runId}/stream` : undefined,
    });
  });

  router.post('/branches/:branchId/rollback', async (req, res) => {
    const requestedVersionId = typeof req.body?.versionId === 'string' ? req.body.versionId.trim() : '';
    const version = deps.deploymentVersionService.resolveRollbackTarget(req.params.branchId, requestedVersionId || undefined);
    if (!version) { res.status(404).json({ error: '没有可回滚的部署版本' }); return; }
    const access = deps.assertProjectAccess(req, version.projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      deps.deploymentVersionService.assertReusable(version);
    } catch (err) {
      res.status(409).json({ error: 'deployment_version_not_reusable', message: (err as Error).message, versionId: version.id });
      return;
    }
    const result = await deps.dispatchVersion(version, 'rollback');
    if (!result.accepted) {
      res.status(result.status || 500).json({ error: result.error || '版本回滚未被接受', versionId: version.id });
      return;
    }
    res.status(202).json({
      accepted: true,
      rollback: true,
      versionId: version.id,
      branchId: version.branchId,
      runId: result.runId,
      streamUrl: result.runId ? `/api/deployment-runs/${result.runId}/stream` : undefined,
    });
  });

  return router;
}

function cleanQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}
