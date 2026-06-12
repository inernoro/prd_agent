import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { StateService } from '../services/state.js';
import type { ReleaseTarget } from '../types.js';
import { ReleaseService } from '../services/release-service.js';
import { releaseEvents } from '../services/release-events.js';
import { resolveActorFromRequest } from '../services/actor-resolver.js';
import { assertProjectAccess } from './projects.js';

export interface ReleasesRouterDeps {
  stateService: StateService;
}

export function createReleasesRouter(deps: ReleasesRouterDeps): Router {
  const router = Router();
  const service = new ReleaseService(deps.stateService);

  router.get('/releases/targets', (req, res) => {
    const projectId = resolveReadableProjectId(req, res);
    if (projectId === false) return;
    if (projectId) service.ensureDefaultPlans(projectId);
    res.json({
      targets: deps.stateService.getReleaseTargets(projectId),
      plans: deps.stateService.getReleasePlans(projectId),
      remoteHosts: deps.stateService.getRemoteHosts().map((host) => ({
        id: host.id,
        name: host.name,
        host: host.host,
        sshPort: host.sshPort,
        sshUser: host.sshUser,
        fingerprint: host.sshPrivateKeyFingerprint,
        isEnabled: host.isEnabled,
      })),
    });
  });

  router.post('/releases/targets', (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const access = rejectProjectMismatch(req, res, typeof body.projectId === 'string' ? body.projectId : undefined);
    if (access) return;
    const validation = validateSshTargetBody(body, false);
    if (validation) {
      res.status(400).json({ error: validation });
      return;
    }
    if (rejectPrivateKeyRefMismatch(
      req,
      res,
      deps.stateService,
      String(body.projectId).trim(),
      String(body.privateKeyRef).trim(),
    )) return;
    const now = new Date().toISOString();
    const target: ReleaseTarget = {
      id: typeof body.id === 'string' && body.id.trim() ? body.id.trim() : `rt_${crypto.randomBytes(6).toString('hex')}`,
      projectId: String(body.projectId).trim(),
      name: String(body.name).trim(),
      type: 'ssh',
      createdAt: now,
      updatedAt: now,
      createdBy: resolveActorFromRequest(req),
      isEnabled: body.isEnabled !== false,
      ssh: {
        host: String(body.host).trim(),
        port: Number(body.port || 22),
        user: String(body.user).trim(),
        privateKeyRef: String(body.privateKeyRef).trim(),
        appPath: String(body.appPath).trim(),
        deployCommand: String(body.deployCommand).trim(),
        rollbackCommand: typeof body.rollbackCommand === 'string' ? body.rollbackCommand.trim() : '',
        healthcheckUrl: String(body.healthcheckUrl).trim(),
      },
    };
    try {
      service.ensureDefaultPlans(target.projectId);
      res.status(201).json({ target: deps.stateService.upsertReleaseTarget(target) });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.patch('/releases/targets/:id', (req, res) => {
    const existing = deps.stateService.getReleaseTarget(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'release target not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, existing.projectId)) return;
    const body = (req.body || {}) as Record<string, unknown>;
    const mergedBody = {
      projectId: existing.projectId,
      name: existing.name,
      host: existing.ssh?.host,
      port: existing.ssh?.port,
      user: existing.ssh?.user,
      privateKeyRef: existing.ssh?.privateKeyRef,
      appPath: existing.ssh?.appPath,
      deployCommand: existing.ssh?.deployCommand,
      rollbackCommand: existing.ssh?.rollbackCommand,
      healthcheckUrl: existing.ssh?.healthcheckUrl,
      isEnabled: existing.isEnabled,
      ...body,
    };
    const validation = validateSshTargetBody(mergedBody, true);
    if (validation) {
      res.status(400).json({ error: validation });
      return;
    }
    if (rejectProjectMismatch(req, res, typeof mergedBody.projectId === 'string' ? mergedBody.projectId : undefined)) return;
    if (rejectPrivateKeyRefMismatch(
      req,
      res,
      deps.stateService,
      String(mergedBody.projectId).trim(),
      String(mergedBody.privateKeyRef).trim(),
    )) return;
    const updated: ReleaseTarget = {
      ...existing,
      projectId: String(mergedBody.projectId).trim(),
      name: String(mergedBody.name).trim(),
      isEnabled: mergedBody.isEnabled !== false,
      ssh: {
        host: String(mergedBody.host).trim(),
        port: Number(mergedBody.port || 22),
        user: String(mergedBody.user).trim(),
        privateKeyRef: String(mergedBody.privateKeyRef).trim(),
        appPath: String(mergedBody.appPath).trim(),
        deployCommand: String(mergedBody.deployCommand).trim(),
        rollbackCommand: typeof mergedBody.rollbackCommand === 'string' ? mergedBody.rollbackCommand.trim() : '',
        healthcheckUrl: String(mergedBody.healthcheckUrl).trim(),
      },
    };
    res.json({ target: deps.stateService.upsertReleaseTarget(updated) });
  });

  router.delete('/releases/targets/:id', (req, res) => {
    const existing = deps.stateService.getReleaseTarget(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'release target not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, existing.projectId)) return;
    const runs = deps.stateService.getReleaseRuns({ targetId: req.params.id });
    if (runs.length > 0) {
      res.status(409).json({ error: 'target has release runs and cannot be deleted' });
      return;
    }
    if (!deps.stateService.removeReleaseTarget(req.params.id)) {
      res.status(404).json({ error: 'release target not found' });
      return;
    }
    res.status(204).end();
  });

  router.post('/releases/branches/:branchId/preflight', async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    if (typeof body.targetId !== 'string' || !body.targetId.trim()) {
      res.status(400).json({ error: 'targetId is required' });
      return;
    }
    if (rejectBranchAndTargetMismatch(req, res, deps.stateService, req.params.branchId, body.targetId.trim())) return;
    try {
      const result = await service.preflight({
        branchId: req.params.branchId,
        targetId: body.targetId.trim(),
        previewUrl: typeof body.previewUrl === 'string' ? body.previewUrl : '',
        operator: resolveActorFromRequest(req),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/releases/branches/:branchId/runs', async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    if (typeof body.targetId !== 'string' || !body.targetId.trim()) {
      res.status(400).json({ error: 'targetId is required' });
      return;
    }
    if (rejectBranchAndTargetMismatch(req, res, deps.stateService, req.params.branchId, body.targetId.trim())) return;
    try {
      const run = await service.startRelease({
        branchId: req.params.branchId,
        targetId: body.targetId.trim(),
        previewUrl: typeof body.previewUrl === 'string' ? body.previewUrl : '',
        operator: resolveActorFromRequest(req),
      });
      res.status(202).json({ run, streamUrl: `/api/releases/runs/${run.releaseId}/stream` });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.get('/releases/runs', (req, res) => {
    const projectId = resolveReadableProjectId(req, res);
    if (projectId === false) return;
    res.json({
      runs: deps.stateService.getReleaseRuns({
        projectId,
        targetId: typeof req.query.targetId === 'string' ? req.query.targetId : undefined,
        branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
      }),
    });
  });

  router.get('/releases/runs/:id', (req, res) => {
    const run = deps.stateService.getReleaseRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'release run not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, run.projectId)) return;
    res.json({ run });
  });

  router.post('/releases/runs/:id/rollback', async (req, res) => {
    const existing = deps.stateService.getReleaseRun(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'ReleaseRun not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, existing.projectId)) return;
    try {
      const run = await service.startRollback(req.params.id, resolveActorFromRequest(req));
      res.status(202).json({ run, streamUrl: `/api/releases/runs/${run.releaseId}/stream` });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.get('/releases/runs/:id/stream', (req, res) => {
    const run = deps.stateService.getReleaseRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'release run not found' });
      return;
    }
    if (rejectProjectMismatch(req, res, run.projectId)) return;
    const afterSeq = Number(req.query.afterSeq || 0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown): void => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };
    send('snapshot', {
      run,
      logs: run.logs.filter((log) => log.seq > afterSeq),
    });
    const handler = (envelope: any): void => {
      if (!envelope?.payload || envelope.payload.releaseId !== req.params.id) return;
      send(envelope.type, envelope.payload);
    };
    releaseEvents.on('any', handler);
    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch { /* ignore */ }
    }, 10_000);
    req.on('close', () => {
      clearInterval(keepalive);
      releaseEvents.off('any', handler);
    });
  });

  router.get('/releases/center', (req, res) => {
    const projectId = resolveReadableProjectId(req, res);
    if (projectId === false) return;
    if (projectId) service.ensureDefaultPlans(projectId);
    const targets = deps.stateService.getReleaseTargets(projectId);
    const runs = deps.stateService.getReleaseRuns(projectId ? { projectId } : {});
    const rows = targets.map((target) => {
      const targetRuns = runs.filter((run) => run.targetId === target.id);
      const current = targetRuns.find((run) => run.status === 'success');
      const latest = targetRuns[0];
      return {
        target,
        currentVersion: current?.releaseId || '',
        currentCommit: current?.commitSha || '',
        latestRun: latest,
        lastReleasedAt: current?.finishedAt || current?.startedAt || '',
        healthStatus: latest?.status === 'success' ? 'healthy' : latest?.status?.includes('failed') ? 'failed' : latest?.status || 'unknown',
        lastOperator: latest?.operator || '',
        canRollback: Boolean(current?.previousReleaseId || deps.stateService.getLatestSuccessfulReleaseRun(target.id, current?.releaseId)),
      };
    });
    res.json({ rows, plans: deps.stateService.getReleasePlans(projectId), runs: runs.slice(0, 50) });
  });

  return router;
}

function requestProjectKey(req: Request): { projectId: string; keyId: string } | undefined {
  return (req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } }).cdsProjectKey;
}

function rejectProjectMismatch(req: Request, res: Response, projectId: string | undefined): boolean {
  const mismatch = assertProjectAccess(req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } }, projectId);
  if (!mismatch) return false;
  res.status(mismatch.status).json(mismatch.body);
  return true;
}

function rejectPrivateKeyRefMismatch(
  req: Request,
  res: Response,
  stateService: StateService,
  projectId: string,
  privateKeyRef: string,
): boolean {
  const projectKey = requestProjectKey(req);
  if (!projectKey) return false;
  if (projectKey.projectId !== projectId) return false;
  const alreadyProvisionedForProject = stateService
    .getReleaseTargets(projectId)
    .some((target) => target.ssh?.privateKeyRef === privateKeyRef);
  if (alreadyProvisionedForProject) return false;

  res.status(403).json({
    error: 'remote_host_scope',
    projectId,
    keyId: projectKey.keyId,
    message: '项目级 key 不能引入未由本项目发布目标使用过的服务器凭据，请先用系统权限创建发布目标。',
  });
  return true;
}

function resolveReadableProjectId(req: Request, res: Response): string | undefined | false {
  const queryProject = typeof req.query.project === 'string' ? req.query.project : undefined;
  const projectKey = requestProjectKey(req);
  const projectId = queryProject || projectKey?.projectId;
  if (rejectProjectMismatch(req, res, projectId)) return false;
  return projectId;
}

function rejectBranchAndTargetMismatch(
  req: Request,
  res: Response,
  stateService: StateService,
  branchId: string,
  targetId: string,
): boolean {
  const branch = stateService.getBranch(branchId);
  const target = stateService.getReleaseTarget(targetId);
  if (rejectProjectMismatch(req, res, branch?.projectId)) return true;
  if (rejectProjectMismatch(req, res, target?.projectId)) return true;
  return false;
}

function validateSshTargetBody(body: Record<string, unknown>, allowExisting: boolean): string | null {
  const required = ['projectId', 'name', 'host', 'user', 'privateKeyRef', 'appPath', 'deployCommand', 'healthcheckUrl'];
  for (const key of required) {
    if (typeof body[key] !== 'string' || !String(body[key]).trim()) {
      return `${key} is required`;
    }
  }
  const port = Number(body.port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port must be an integer in [1, 65535]';
  try {
    const url = new URL(String(body.healthcheckUrl));
    if (!['http:', 'https:'].includes(url.protocol)) return 'healthcheckUrl must be http or https';
  } catch {
    return 'healthcheckUrl must be a valid URL';
  }
  if (!allowExisting && typeof body.id === 'string' && body.id && !/^[A-Za-z0-9_-]{2,80}$/.test(body.id)) {
    return 'id must match [A-Za-z0-9_-]{2,80}';
  }
  return null;
}
