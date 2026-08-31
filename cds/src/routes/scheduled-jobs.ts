import { Router } from 'express';
import crypto from 'node:crypto';
import type { StateService } from '../services/state.js';
import type { ReleaseJobSource, ScheduledJob, ScheduledJobAction, ScheduledJobSchedule, ScheduledJobTarget } from '../types.js';
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
    // 时间轴右半边要画一串待触发点。序列一律由服务端出，前端不复制到期判定。
    const horizon = Math.min(Math.max(Number(req.query.nextRuns || 0), 0), 64);
    if (!horizon) { res.json({ jobs }); return; }
    const now = new Date();
    res.json({
      jobs: jobs.map((job) => ({
        ...job,
        nextRuns: job.enabled ? scheduledJobService.computeNextRuns(job.schedule, horizon, now) : [],
      })),
    });
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

    const target = parseTarget(req.body?.target, { projectId, stateService });
    if ('error' in target) { res.status(400).json({ error: target.error }); return; }

    try {
      const result = await scheduledJobService.checkTarget(
        target,
        // release 的试运行要跑一整轮预检（SSH + 上线地址探测），30 秒不够；
        // 它不发布，放宽超时没有生产风险。
        clampInt(req.body?.timeoutSeconds, target.type === 'release' ? 120 : 30, 1, 300)
      );
      res.json({ result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/scheduled-jobs', (req, res) => {
    const input = parseJobInput(req.body, stateService);
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

    const input = parseJobInput({ ...existing, ...req.body, projectId: existing.projectId }, stateService);
    if ('error' in input) { res.status(400).json({ error: input.error }); return; }

    const preserveNextRunAt = existing.enabled === input.enabled && schedulesEqual(existing.schedule, input.schedule);
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
      // 人工重新启用 = 认领了这条规则，连续失败计数与自动停用痕迹一并清掉；
      // 不清的话下一次失败就直接触顶，规则刚开又被关掉。
      ...(input.enabled && !existing.enabled
        ? { consecutiveFailureCount: 0, autoDisabledAt: undefined, autoDisabledReason: undefined }
        : {}),
      updatedAt: new Date().toISOString(),
    }, { preserveNextRunAt });
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

function parseJobInput(body: any, stateService: StateService): {
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
  const actions = parseActions(body?.actions, body?.target, {
    projectId,
    stateService,
    // 只有事件驱动规则才允许留空来源分支——定时规则仍然必须绑定一个具体分支，
    // 否则到点了没人知道要发什么。
    allowDeferredBranch: schedule.type === 'push',
  });
  if ('error' in actions) return actions;

  const hasRelease = actions.some((action) => action.type === 'release');

  return {
    projectId,
    name,
    description: cleanText(body?.description, 500) || undefined,
    enabled: body?.enabled !== false,
    schedule,
    actions,
    // 发布默认要等一整轮部署 + 健康检查（发布执行超时本身就是 30 分钟量级），
    // 沿用 300 秒默认值会让绝大多数定时发布在还没跑完时就被记成失败，制造假告警。
    timeoutSeconds: clampInt(body?.timeoutSeconds, hasRelease ? 3600 : 300, 1, 3600),
    // 一次生产部署失败自动重放是危险动作；恢复走 rollbackOnFailure，不走 retry。
    retryCount: hasRelease ? 0 : clampInt(body?.retryCount, 0, 0, 5),
  };
}

const SCHEDULE_TYPES = ['manual', 'interval', 'daily', 'push'] as const;

function parseSchedule(raw: any): ScheduledJobSchedule | { error: string } {
  const type = SCHEDULE_TYPES.includes(raw?.type) ? (raw.type as typeof SCHEDULE_TYPES[number]) : '';
  const timezone = cleanText(raw?.timezone, 80) || 'Asia/Shanghai';
  if (!type) return { error: '调度类型无效' };
  if (!isValidTimeZone(timezone)) return { error: '时区无效' };
  if (type === 'manual') return { type, timezone };
  if (type === 'push') {
    // 分支 glob 必须给：留空会匹配不到任何分支，规则建了却永远不触发，
    // 而且没有任何地方会报错——这种「静默不生效」比直接拒绝糟得多。
    const branchPattern = cleanText(raw?.branchPattern, 200);
    if (!branchPattern) return { error: '分支匹配不能为空（例如 main 或 release/*）' };
    const event = raw?.event === 'pr-open' ? 'pr-open' : 'push';
    const pathPattern = cleanText(raw?.pathPattern, 200);
    return { type, branchPattern, event, ...(pathPattern ? { pathPattern } : {}), timezone };
  }
  if (type === 'interval') {
    return { type, intervalMinutes: clampInt(raw?.intervalMinutes, 60, 1, 60 * 24 * 30), timezone };
  }
  const timeOfDay = cleanText(raw?.timeOfDay, 5);
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(timeOfDay)) return { error: '每日时间必须是 HH:mm' };
  return { type, timeOfDay, timezone };
}

/** 校验 release 动作所需的语境：跨项目发布必须在这一层就被拒。 */
interface ParseTargetContext {
  projectId: string;
  stateService: StateService;
  /** push 规则专用：来源分支由事件决定，建规则时允许留空。 */
  allowDeferredBranch?: boolean;
}

function parseActions(rawActions: any, legacyTarget: any, ctx: ParseTargetContext): ScheduledJobAction[] | { error: string } {
  const source = Array.isArray(rawActions) && rawActions.length > 0 ? rawActions : legacyTarget ? [legacyTarget] : [];
  if (source.length === 0) return { error: '至少需要一个动作' };
  const actions: ScheduledJobAction[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const target = parseTarget(source[index], ctx);
    if ('error' in target) return { error: `动作 ${index + 1}: ${target.error}` };
    actions.push({
      ...target,
      id: cleanText(source[index]?.id, 80) || `action_${index + 1}`,
      name: cleanText(source[index]?.name, 120) || defaultActionName(target),
    });
  }
  return actions;
}

function defaultActionName(target: ScheduledJobTarget): string {
  if (target.type === 'release') return '发布到环境';
  return target.type === 'http' ? '调用 HTTP 接口' : '执行命令脚本';
}

function parseTarget(raw: any, ctx: ParseTargetContext): ScheduledJobTarget | { error: string } {
  if (raw?.type === 'release') {
    const targetId = cleanText(raw.targetId, 120);
    if (!targetId) return { error: '发布目标必填' };
    const releaseTarget = ctx.stateService.getReleaseTarget(targetId);
    if (!releaseTarget) return { error: `发布目标不存在: ${targetId}` };
    // ScheduledJob.projectId 与 ReleaseTarget.projectId 是两条独立的项目归属；
    // 不比对就能用 A 项目的定时任务去发 B 项目的生产（scheduled-jobs 的
    // assertProjectAccess 只认 job.projectId，看不见发布目标那一侧）。
    if (releaseTarget.projectId !== ctx.projectId) {
      return { error: `发布目标属于项目 ${releaseTarget.projectId}，与任务所属项目 ${ctx.projectId} 不一致，禁止跨项目定时发布` };
    }
    const source = parseReleaseSource(raw.source, ctx);
    if ('error' in source) return source;
    return {
      type: 'release',
      targetId,
      source,
      ...(raw.dryRun === true ? { dryRun: true } : {}),
      ...(raw.requireApproval === true ? { requireApproval: true } : {}),
      ...(raw.rollbackOnFailure === true ? { rollbackOnFailure: true } : {}),
      ...(raw.skipWhenUnchanged === true ? { skipWhenUnchanged: true } : {}),
    };
  }
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

function parseReleaseSource(raw: any, ctx: ParseTargetContext): ReleaseJobSource | { error: string } {
  if (raw?.kind === 'promote') {
    const fromTargetId = cleanText(raw.fromTargetId, 120);
    if (!fromTargetId) return { error: '提升来源环境必填' };
    const fromTarget = ctx.stateService.getReleaseTarget(fromTargetId);
    if (!fromTarget) return { error: `提升来源环境不存在: ${fromTargetId}` };
    if (fromTarget.projectId !== ctx.projectId) {
      return { error: `提升来源环境属于项目 ${fromTarget.projectId}，与任务所属项目不一致` };
    }
    return { kind: 'promote', fromTargetId };
  }
  if (raw?.kind === 'branch') {
    const branchId = cleanText(raw.branchId, 120);
    // 事件驱动规则（schedule.type = 'push'）存的是分支 **glob**，发哪个分支要等事件
    // 发生才知道，由 runPushRules 现场覆盖。所以这里允许留空——若照定时规则那样
    // 要求填一个固定分支，`release/*` 这条规则就只能绑死其中一个 release 分支。
    if (!branchId) {
      if (ctx.allowDeferredBranch) return { kind: 'branch', branchId: '' };
      return { error: '来源分支必填' };
    }
    const branch = ctx.stateService.getBranch(branchId);
    if (!branch) return { error: `来源分支不存在: ${branchId}` };
    if (branch.projectId !== ctx.projectId) {
      return { error: `来源分支属于项目 ${branch.projectId}，与任务所属项目不一致` };
    }
    return { kind: 'branch', branchId };
  }
  return { error: '发布来源无效，必须是 branch 或 promote' };
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

function schedulesEqual(a: ScheduledJobSchedule, b: ScheduledJobSchedule): boolean {
  return normalizeScheduleForCompare(a) === normalizeScheduleForCompare(b);
}

function normalizeScheduleForCompare(schedule: ScheduledJobSchedule): string {
  return JSON.stringify({
    type: schedule.type,
    intervalMinutes: schedule.type === 'interval' ? schedule.intervalMinutes : undefined,
    timeOfDay: schedule.type === 'daily' ? schedule.timeOfDay : undefined,
    // push 规则的三个字段也要参与比较：漏掉的话改了分支 glob 却被判成
    // 「调度没变」，nextRunAt 被原样保留（push 规则恒为 null 倒是无害），
    // 但更要命的是 UI 的「有未保存更改」判据也会跟着失灵。
    branchPattern: schedule.type === 'push' ? schedule.branchPattern : undefined,
    event: schedule.type === 'push' ? schedule.event : undefined,
    pathPattern: schedule.type === 'push' ? schedule.pathPattern || '' : undefined,
    timezone: schedule.timezone || 'Asia/Shanghai',
  });
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
