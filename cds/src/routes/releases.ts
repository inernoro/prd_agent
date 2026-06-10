import crypto from 'node:crypto';
import { Router } from 'express';
import type { StateService } from '../services/state.js';
import type { ReleaseTarget } from '../types.js';
import { ReleaseService } from '../services/release-service.js';
import { releaseEvents } from '../services/release-events.js';
import { resolveActorFromRequest } from '../services/actor-resolver.js';

export interface ReleasesRouterDeps {
  stateService: StateService;
}

export function createReleasesRouter(deps: ReleasesRouterDeps): Router {
  const router = Router();
  const service = new ReleaseService(deps.stateService);

  router.get('/releases/targets', (req, res) => {
    const projectId = typeof req.query.project === 'string' ? req.query.project : undefined;
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
    const validation = validateSshTargetBody(body, false);
    if (validation) {
      res.status(400).json({ error: validation });
      return;
    }
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
    res.json({
      runs: deps.stateService.getReleaseRuns({
        projectId: typeof req.query.project === 'string' ? req.query.project : undefined,
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
    res.json({ run });
  });

  router.post('/releases/runs/:id/rollback', async (req, res) => {
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
    const projectId = typeof req.query.project === 'string' ? req.query.project : undefined;
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
