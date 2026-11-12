import crypto from 'node:crypto';
import type { ScheduledJob, ScheduledJobRun } from '../types.js';
import type { StateService } from './state.js';

export const DEFAULT_SCHEDULE_GRACE_SECONDS = 120;
export type TaskHealthState = 'paused' | 'waiting' | 'event-driven' | 'due' | 'missed' | 'running' | 'success' | 'execution' | 'timeout' | 'artifact-invalid' | 'interrupted';
export interface TaskHealth {
  state: TaskHealthState;
  message: string;
  runId?: string;
  scheduledFor?: string;
  recoveryRequired: boolean;
}
const labels: Record<TaskHealthState, string> = {
  paused: '已暂停', waiting: '未到执行时间', 'event-driven': '等待手动或事件触发', due: '已到执行时间',
  missed: '漏跑', running: '执行中', success: '完成', execution: '执行失败', timeout: '执行超时',
  'artifact-invalid': '产物验证失败', interrupted: '进程中断，结果待核实',
};
export function scheduleGraceMs(job: ScheduledJob): number {
  return Math.max(1, job.scheduleGraceSeconds ?? DEFAULT_SCHEDULE_GRACE_SECONDS) * 1000;
}
export function scheduledJobHealth(job: ScheduledJob, runs: ScheduledJobRun[], now = new Date()): TaskHealth {
  const latest = job.lastScheduledRun || runs.find(r => r.trigger === 'schedule');
  const recovery = runs.find(r => r.id === job.recoveryRequiredRunId) || [job.lastScheduledRun, job.lastManualRequest].find(r => r?.id === job.recoveryRequiredRunId);
  const active = runs.find(r => r.status === 'running' || r.status === 'queued');
  const due = Date.parse(job.nextRunAt || '');
  const timer = job.schedule.type === 'daily' || job.schedule.type === 'interval';
  let state: TaskHealthState;
  if (!job.enabled) state = 'paused';
  else if (job.recoveryRequiredRunId) state = recovery?.failureKind || 'interrupted';
  else if (active) state = Date.parse(active.deadlineAt || '') <= now.getTime() ? 'timeout' : 'running';
  else if (timer && (!Number.isFinite(due) || now.getTime() > due + scheduleGraceMs(job))) state = 'missed';
  else if (latest?.status === 'failed') state = latest.failureKind || 'execution';
  else if (!timer) state = 'event-driven';
  else state = due <= now.getTime() ? 'due' : 'waiting';
  return { state, message: labels[state], runId: job.recoveryRequiredRunId || active?.id || latest?.id,
    scheduledFor: latest?.scheduledFor, recoveryRequired: Boolean(job.recoveryRequiredRunId) };
}

/** 验证归档正文，不接受别的项目、旧报告或仅有元数据的幽灵报告。 */
export async function validateJobReports(state: StateService, run: ScheduledJobRun): Promise<NonNullable<ScheduledJobRun['artifacts']>> {
  const contract = run.completion;
  if (!contract) return [];
  const reports = state.listAcceptanceReports(run.projectId)
    .filter(r => r.scheduledJobRunId === run.id && Date.parse(r.createdAt) >= Date.parse(run.startedAt || run.queuedAt));
  if (reports.length < contract.minCount) throw new Error(`预期至少 ${contract.minCount} 份报告，已归档 ${reports.length} 份`);
  const artifacts: NonNullable<ScheduledJobRun['artifacts']> = [];
  for (const meta of reports) {
    if (contract.requireObjectStorage && (meta.storage !== 'object' || !meta.objectKey)) throw new Error('报告未归档到对象存储');
    if (contract.allowedVerdicts?.length && (!meta.verdict || !contract.allowedVerdicts.includes(meta.verdict))) throw new Error('报告验收结论不符合任务契约');
    const content = await state.readAcceptanceReportContentAsync(meta.id, { requireObjectStorage: contract.requireObjectStorage });
    if (!content?.trim() || Buffer.byteLength(content) !== meta.sizeBytes) throw new Error('报告正文缺失、为空或大小不匹配');
    artifacts.push({ reportId: meta.id, sizeBytes: meta.sizeBytes, sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  return artifacts;
}

/** 复用已有存活探测轮次：即使任务 tick 停摆，仍能观测逾期；绝不执行任务。 */
export function observeScheduledJobs(state: StateService, publish: (type: 'scheduled-job.unhealthy', data: unknown) => void, now = new Date()): void {
  for (const job of state.listScheduledJobs()) {
    const health = scheduledJobHealth(job, state.listScheduledJobRuns({ jobId: job.id, limit: 500 }), now);
    const bad = ['missed', 'execution', 'timeout', 'artifact-invalid', 'interrupted'].includes(health.state);
    const key = bad ? `${health.state}:${health.runId || job.nextRunAt || 'missing-schedule'}` : undefined;
    if (key === job.healthAlertKey) continue;
    if (key) publish('scheduled-job.unhealthy', { projectId: job.projectId, jobId: job.id, runId: health.runId,
      failureKind: health.state, message: `${job.name}：${health.message}；请核实任务和产物` });
    state.upsertScheduledJob({ ...job, healthAlertKey: key });
  }
}
