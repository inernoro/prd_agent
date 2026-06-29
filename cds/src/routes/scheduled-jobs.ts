import { Router } from 'express';
import crypto from 'node:crypto';
import type { StateService } from '../services/state.js';
import type { ScheduledJob, ScheduledJobAction, ScheduledJobSchedule, ScheduledJobTarget } from '../types.js';
import type { ScheduledJobService } from '../services/scheduled-job-service.js';

export interface ScheduledJobsRouterDeps {
  stateService: StateService;
  scheduledJobService: ScheduledJobService;
  assertProjectAccess: (req: any, projectId: string) => { status: number; body: unknown } | null;
}

export function createScheduledJobsRouter(deps: ScheduledJobsRouterDeps): Router {
  const router = Router();
  const { stateService, scheduledJobService } = deps;

  router.get('/scheduled-jobs', (req, res) => {
    const projectId = resolveProjectFilter(req, res, deps.assertProjectAccess);
    if (projectId === false) return;
    const jobs = stateService.listScheduledJobs(projectId)
      .sort((a, b) => String(a.nextRunAt || '').localeCompare(String(b.nextRunAt || '')));
    res.json({ jobs });
  });

  router.get('/scheduled-jobs/runs', (req, res) => {
    let projectId = resolveProjectFilter(req, res, deps.assertProjectAccess);
    if (projectId === false) return;
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
    if (jobId) {
      const job = stateService.getScheduledJob(jobId);
      if (!job) { res.json({ runs: [] }); return; }
      const access = deps.assertProjectAccess(req, job.projectId);
      if (access) { res.status(access.status).json(access.body); return; }
      if (projectId && projectId !== job.projectId) { res.json({ runs: [] }); return; }
      projectId = job.projectId;
    }
    const runs = stateService.listScheduledJobRuns({
      projectId,
      jobId,
      limit: Number(req.query.limit || 100),
    });
    res.json({ runs });
  });

  router.post('/scheduled-jobs/check-target', async (req, res) => {
    const projectId = cleanText(req.body?.projectId, 120);
    if (!projectId) { res.status(400).json({ error: 'projectId 必填' }); return; }
    const project = stateService.getProject(projectId);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return; }
    const access = deps.assertProjectAccess(req, projectId);
    if (access) { res.status(access.status).json(access.body); return; }

    const target = parseTarget(req.body?.target);
    if ('error' in target) { res.status(400).json({ error: target.error }); return; }

    try {
      const result = await scheduledJobService.checkTarget(
        target,
        clampInt(req.body?.timeoutSeconds, 30, 1, 300)
      );
      res.json({ result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/scheduled-jobs', (req, res) => {
    const input = parseJobInput(req.body);
    if ('error' in input) { res.status(400).json({ error: input.error }); return; }
    const project = stateService.getProject(input.projectId);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return; }
    const access = deps.assertProjectAccess(req, input.projectId);
    if (access) { res.status(access.status).json(access.body); return; }

    const now = new Date().toISOString();
    const job = scheduledJobService.normalizeJob({
      id: `sjob_${crypto.randomBytes(8).toString('hex')}`,
      projectId: input.projectId,
      name: input.name,
      description: input.description,
      enabled: input.enabled,
      schedule: input.schedule,
      target: input.actions[0],
      actions: input.actions,
      timeoutSeconds: input.timeoutSeconds,
      retryCount: input.retryCount,
      concurrencyPolicy: 'skip',
      createdAt: now,
      updatedAt: now,
    });
    stateService.upsertScheduledJob(job);
    res.status(201).json({ job });
  });

  router.patch('/scheduled-jobs/:id', (req, res) => {
    const existing = stateService.getScheduledJob(req.params.id);
    if (!existing) { res.status(404).json({ error: '任务不存在' }); return; }
    const access = deps.assertProjectAccess(req, existing.projectId);
    if (access) { res.status(access.status).json(access.body); return; }

    const input = parseJobInput({ ...existing, ...req.body, projectId: existing.projectId });
    if ('error' in input) { res.status(400).json({ error: input.error }); return; }

    const job = scheduledJobService.normalizeJob({
      ...existing,
      name: input.name,
      description: input.description,
      enabled: input.enabled,
      schedule: input.schedule,
      target: input.actions[0],
      actions: input.actions,
      timeoutSeconds: input.timeoutSeconds,
      retryCount: input.retryCount,
      updatedAt: new Date().toISOString(),
    });
    stateService.upsertScheduledJob(job);
    res.json({ job });
  });

  router.delete('/scheduled-jobs/:id', (req, res) => {
    const existing = stateService.getScheduledJob(req.params.id);
    if (!existing) { res.status(404).json({ error: '任务不存在' }); return; }
    const access = deps.assertProjectAccess(req, existing.projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    stateService.deleteScheduledJob(existing.id);
    res.json({ ok: true });
  });

  router.post('/scheduled-jobs/:id/run', async (req, res) => {
    const existing = stateService.getScheduledJob(req.params.id);
    if (!existing) { res.status(404).json({ error: '任务不存在' }); return; }
    const access = deps.assertProjectAccess(req, existing.projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const run = await scheduledJobService.runJob(existing.id, 'manual');
      res.json({ run });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

function resolveProjectFilter(
  req: any,
  res: any,
  assertProjectAccess: ScheduledJobsRouterDeps['assertProjectAccess'],
): string | undefined | false {
  const requested = typeof req.query?.project === 'string' ? req.query.project : undefined;
  const projectKey = req.cdsProjectKey as { projectId: string; keyId: string } | undefined;
  const projectId = requested || projectKey?.projectId;
  const access = assertProjectAccess(req, projectId);
  if (access) {
    res.status(access.status).json(access.body);
    return false;
  }
  return projectId;
}

function parseJobInput(body: any): {
  projectId: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: ScheduledJobSchedule;
  actions: ScheduledJobAction[];
  timeoutSeconds: number;
  retryCount: number;
} | { error: string } {
  const projectId = cleanText(body?.projectId, 120);
  const name = cleanText(body?.name, 120);
  if (!projectId) return { error: 'projectId 必填' };
  if (!name) return { error: '任务名称必填' };

  const schedule = parseSchedule(body?.schedule);
  if ('error' in schedule) return schedule;
  const actions = parseActions(body?.actions, body?.target);
  if ('error' in actions) return actions;

  return {
    projectId,
    name,
    description: cleanText(body?.description, 500) || undefined,
    enabled: body?.enabled !== false,
    schedule,
    actions,
    timeoutSeconds: clampInt(body?.timeoutSeconds, 300, 1, 3600),
    retryCount: clampInt(body?.retryCount, 0, 0, 5),
  };
}

function parseSchedule(raw: any): ScheduledJobSchedule | { error: string } {
  const type = raw?.type === 'manual' || raw?.type === 'interval' || raw?.type === 'daily' ? raw.type : '';
  const timezone = cleanText(raw?.timezone, 80) || 'Asia/Shanghai';
  if (!type) return { error: '调度类型无效' };
  if (type === 'manual') return { type, timezone };
  if (type === 'interval') {
    return { type, intervalMinutes: clampInt(raw?.intervalMinutes, 60, 1, 60 * 24 * 30), timezone };
  }
  const timeOfDay = cleanText(raw?.timeOfDay, 5);
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(timeOfDay)) return { error: '每日时间必须是 HH:mm' };
  return { type, timeOfDay, timezone };
}

function parseActions(rawActions: any, legacyTarget: any): ScheduledJobAction[] | { error: string } {
  const source = Array.isArray(rawActions) && rawActions.length > 0 ? rawActions : legacyTarget ? [legacyTarget] : [];
  if (source.length === 0) return { error: '至少需要一个动作' };
  const actions: ScheduledJobAction[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const target = parseTarget(source[index]);
    if ('error' in target) return { error: `动作 ${index + 1}: ${target.error}` };
    actions.push({
      ...target,
      id: cleanText(source[index]?.id, 80) || `action_${index + 1}`,
      name: cleanText(source[index]?.name, 120) || (target.type === 'http' ? '调用 HTTP 接口' : '执行命令脚本'),
    });
  }
  return actions;
}

function parseTarget(raw: any): ScheduledJobTarget | { error: string } {
  if (raw?.type === 'http') {
    const url = cleanText(raw.url, 2000);
    if (!url) return { error: 'HTTP URL 必填' };
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(raw.method) ? raw.method : 'POST';
    const headers = parseStringRecord(raw.headers);
    return {
      type: 'http',
      method,
      url,
      ...(headers ? { headers } : {}),
      ...(typeof raw.body === 'string' && raw.body.trim() ? { body: raw.body } : {}),
    };
  }
  if (raw?.type === 'command') {
    const command = cleanText(raw.command, 4000);
    if (!command) return { error: '命令必填' };
    const cwd = cleanText(raw.cwd, 1000);
    if (cwd && !isSafeRelativeCommandCwd(cwd)) return { error: '工作目录必须是 sandbox 内的相对路径' };
    return {
      type: 'command',
      command,
      ...(cwd ? { cwd } : {}),
    };
  }
  return { error: '执行目标类型无效' };
}

function isSafeRelativeCommandCwd(cwd: string): boolean {
  if (cwd.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(cwd)) return false;
  const normalized = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return normalized.every((part) => part !== '..');
}

function parseStringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const k = cleanText(key, 120);
    const v = cleanText(value, 2000);
    if (k && v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}
