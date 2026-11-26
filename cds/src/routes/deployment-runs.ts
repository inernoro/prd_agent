import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AgentKeyAccess, DeploymentRun, DeploymentRunStatus } from '../types.js';
import type { DeploymentRunService } from '../services/deployment-run.js';
import type { DeploymentDiagnosisService } from '../services/deployment-diagnosis.js';
import { canHumanAccessProject, logPayloadForHumanView } from '../services/human-project-access.js';
import { buildGateStatus } from '../services/build-gate.js';
import { deploymentPhaseBudget } from '../services/deployment-phase-budget.js';
import type { StateService } from '../services/state.js';

const DEPLOYMENT_RUN_STATUSES = new Set<DeploymentRunStatus>([
  'pending',
  'queued',
  'preparing',
  'building',
  'starting',
  'verifying',
  'running',
  'failed',
  'cancelled',
]);

const TERMINAL_STATUSES = new Set<DeploymentRunStatus>(['running', 'failed', 'cancelled']);

export interface DeploymentRunsRouterDeps {
  deploymentRunService: DeploymentRunService;
  stateService?: StateService;
  assertProjectAccess: (
    req: Request,
    projectId: string,
  ) => { status: number; body: unknown } | null;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  deploymentDiagnosisService?: DeploymentDiagnosisService;
}

export function createDeploymentRunsRouter(deps: DeploymentRunsRouterDeps): Router {
  const router = Router();
  const pollIntervalMs = Math.max(50, deps.pollIntervalMs || 500);
  const heartbeatIntervalMs = Math.max(1_000, deps.heartbeatIntervalMs || 10_000);

  router.get('/deployment-runs', (req, res) => {
    const projectId = resolveProjectFilter(req, res, deps.assertProjectAccess);
    if (projectId === false) return;

    if (req.query.view === 'active' && deps.stateService) {
      const state = deps.stateService;
      const allowed = new Map<string, boolean>();
      const canRead = (id: string) => {
        if (!allowed.has(id)) allowed.set(id, (!projectId || projectId === id)
          && !deps.assertProjectAccess(req, id) && canHumanAccessProject(req, state, id));
        return allowed.get(id) === true;
      };
      const branches = state.getAllBranches().filter(branch => canRead(branch.projectId || 'default'));
      const branchById = new Map(branches.map(branch => [branch.id, branch]));
      const nameFor = (id: string) => state.getProject(id)?.name || id;
      const visible = deps.deploymentRunService.list({ projectId }).filter(run => canRead(run.projectId));
      const runs = visible.filter(run => !TERMINAL_STATUSES.has(run.status));
      const recent = visible.filter(run => TERMINAL_STATUSES.has(run.status))
        .sort((a, b) => (b.finishedAt || b.updatedAt).localeCompare(a.finishedAt || a.updatedAt)).slice(0, 12);
      const activeTargets = new Set(runs.filter(run => run.commitSha).map(run => `${run.branchId}:${run.commitSha!.toLowerCase()}`));
      const phaseQueue = Object.entries(deploymentPhaseBudget.snapshot()).flatMap(([phase, queue]) =>
        queue.queued.flatMap(item => item.projectId && canRead(item.projectId) ? [{
          phase, projectName: nameFor(item.projectId), branchId: item.branchId,
          branchName: item.branchId ? branchById.get(item.branchId)?.branch : undefined,
          profileId: item.profileId, enqueuedAt: item.enqueuedAt, reason: item.reason,
        }] : []));
      const gate = buildGateStatus();
      const keyAccess = (req as Request & { cdsAccess?: { access: AgentKeyAccess } }).cdsAccess?.access;
      const toRow = (run: DeploymentRun) => {
        const event = run.events.at(-1);
        const branch = branchById.get(run.branchId);
        return {
          id: run.id, projectId: run.projectId, projectName: nameFor(run.projectId), branchId: run.branchId,
          branchName: branch?.branch || run.branchId, commitSha: run.commitSha, status: run.status, phase: run.phase,
          startedAt: run.startedAt, finishedAt: TERMINAL_STATUSES.has(run.status) ? run.finishedAt || run.updatedAt : undefined,
          latestEvent: event && { at: event.at, phase: event.phase, message: event.message, profileIds: event.detail?.profileIds },
          ciUrl: run.commitSha && branch?.ciTargetSha?.toLowerCase() === run.commitSha.toLowerCase() ? branch.ciWorkflowRunUrl : undefined,
        };
      };
      res.set('Cache-Control', 'no-store');
      res.json(logPayloadForHumanView(req, {
        generatedAt: new Date().toISOString(),
        runs: runs.map(toRow),
        recent: recent.map(toRow),
        ci: branches.filter(branch => branch.ciImageStatus === 'waiting'
          && !activeTargets.has(`${branch.id}:${branch.ciTargetSha?.toLowerCase()}`)).map(branch => ({
          branchId: branch.id, branchName: branch.branch, projectName: nameFor(branch.projectId || 'default'),
          commitSha: branch.ciTargetSha, since: branch.ciWaitingSince || branch.lastPushAt,
          label: branch.ciDiagnosis?.title, ciUrl: branch.ciDiagnosis?.actionUrl || branch.ciWorkflowRunUrl,
        })),
        buildQueue: branches.flatMap(branch => branch.buildQueue ? [{
          branchId: branch.id, branchName: branch.branch, projectName: nameFor(branch.projectId || 'default'),
          ahead: branch.buildQueue.ahead, queuedAt: branch.buildQueue.queuedAt, serviceIds: branch.buildQueue.serviceIds,
        }] : []).sort((a, b) => a.ahead - b.ahead),
        buildCapacity: projectId || keyAccess && keyAccess.projects !== 'all'
          ? null : { active: gate.active, queued: gate.queued, max: gate.max },
        phaseQueue,
      }));
      return;
    }

    const statusValue = cleanQuery(req.query.status);
    if (statusValue && !DEPLOYMENT_RUN_STATUSES.has(statusValue as DeploymentRunStatus)) {
      res.status(400).json({ error: '部署运行状态无效' });
      return;
    }

    const branchId = cleanQuery(req.query.branch) || cleanQuery(req.query.branchId);
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const runs = deps.deploymentRunService.list({
      projectId,
      branchId,
      status: statusValue as DeploymentRunStatus | undefined,
    }).slice(0, limit).map(toRunSummary);

    res.json(logPayloadForHumanView(req, { runs, total: runs.length }));
  });

  router.get('/deployment-runs/:id/stream', (req, res) => {
    const initialRun = deps.deploymentRunService.get(req.params.id);
    if (!initialRun) {
      res.status(404).json({ error: '部署运行不存在' });
      return;
    }
    const access = deps.assertProjectAccess(req, initialRun.projectId);
    if (access) {
      res.status(access.status).json(access.body);
      return;
    }

    const headerSeq = cleanQuery(req.headers['last-event-id']);
    let afterSeq = clampInt(req.query.afterSeq ?? headerSeq, 0, 0, Number.MAX_SAFE_INTEGER);
    let closed = false;
    let pollTimer: NodeJS.Timeout | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let snapshotSent = false;

    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const stop = (): void => {
      if (closed) return;
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    };

    const emitPending = (): void => {
      if (closed) return;
      const result = deps.deploymentRunService.getEventsAfter(initialRun.id, afterSeq);
      if (!snapshotSent) {
        writeSse(res, 'snapshot', {
          run: toRunSummary(result.run),
          afterSeq,
          firstEventSeq: result.run.firstEventSeq,
          latestSeq: result.run.seq,
          truncated: result.truncated,
        });
        snapshotSent = true;
      }
      for (const event of result.events) {
        writeSse(res, 'deployment-event', event, event.seq);
        afterSeq = event.seq;
      }
      if (TERMINAL_STATUSES.has(result.run.status)) {
        writeSse(res, 'done', {
          runId: result.run.id,
          status: result.run.status,
          phase: result.run.phase,
          latestSeq: result.run.seq,
        });
        stop();
        res.end();
      }
    };

    req.on('close', stop);
    emitPending();
    if (closed) return;

    pollTimer = setInterval(() => {
      try {
        emitPending();
      } catch (err) {
        writeSse(res, 'error', { error: (err as Error).message });
        stop();
        res.end();
      }
    }, pollIntervalMs);
    heartbeatTimer = setInterval(() => {
      if (!closed) res.write(': keepalive\n\n');
    }, heartbeatIntervalMs);
  });

  router.get('/deployment-runs/:id/diagnosis', (req, res) => {
    const run = deps.deploymentRunService.get(req.params.id);
    if (!run) { res.status(404).json({ error: '部署运行不存在' }); return; }
    const access = deps.assertProjectAccess(req, run.projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    if (!deps.deploymentDiagnosisService) {
      res.status(503).json({ error: '部署诊断服务未启用' });
      return;
    }
    res.json(logPayloadForHumanView(req, { diagnosis: deps.deploymentDiagnosisService.deterministic(run.id) }));
  });

  router.get('/deployment-runs/:id/diagnosis/stream', async (req, res) => {
    const run = deps.deploymentRunService.get(req.params.id);
    if (!run) { res.status(404).json({ error: '部署运行不存在' }); return; }
    const access = deps.assertProjectAccess(req, run.projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    if (!deps.deploymentDiagnosisService) {
      res.status(503).json({ error: '部署诊断服务未启用' });
      return;
    }
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const deterministic = deps.deploymentDiagnosisService.deterministic(run.id);
    writeSse(res, 'facts-ready', deterministic);
    if (req.query.ai === '1' || req.query.ai === 'true') {
      writeSse(res, 'ai-stage', { stage: 'explaining', message: 'AI Gateway 正在解释结构化部署事实' });
      const diagnosis = await deps.deploymentDiagnosisService.explain(run.id);
      writeSse(res, 'explanation', diagnosis.ai);
      writeSse(res, 'complete', diagnosis);
    } else {
      writeSse(res, 'complete', deterministic);
    }
    res.end();
  });

  router.get('/deployment-runs/:id', (req, res) => {
    const run = deps.deploymentRunService.get(req.params.id);
    if (!run) {
      res.status(404).json({ error: '部署运行不存在' });
      return;
    }
    const access = deps.assertProjectAccess(req, run.projectId);
    if (access) {
      res.status(access.status).json(access.body);
      return;
    }
    res.json(logPayloadForHumanView(req, { run }));
  });

  return router;
}

function resolveProjectFilter(
  req: Request,
  res: Response,
  assertProjectAccess: DeploymentRunsRouterDeps['assertProjectAccess'],
): string | undefined | false {
  const requested = cleanQuery(req.query.project) || cleanQuery(req.query.projectId);
  const projectKey = (req as Request & { cdsProjectKey?: { projectId: string } }).cdsProjectKey;
  const projectId = requested || projectKey?.projectId;
  if (!projectId) return undefined;
  const access = assertProjectAccess(req, projectId);
  if (access) {
    res.status(access.status).json(access.body);
    return false;
  }
  return projectId;
}

function toRunSummary(run: DeploymentRun): Omit<DeploymentRun, 'events'> & {
  eventCount: number;
  latestEvent?: DeploymentRun['events'][number];
} {
  const { events, ...summary } = run;
  return { ...summary, eventCount: events.length, latestEvent: events.at(-1) };
}

function writeSse(res: Response, eventName: string, data: unknown, id?: number): void {
  if (id !== undefined) res.write(`id: ${id}\n`);
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(logPayloadForHumanView(res.locals.cdsHumanRequest, data))}\n\n`);
}

function cleanQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}
