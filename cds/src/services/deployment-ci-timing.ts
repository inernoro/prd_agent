import type { DeploymentStageSummary } from './deployment-stage-timing.js';

export interface CiTimingTarget { installationId: number; repository: string; branch: string; headSha: string; }
export interface CiTimingJob {
  id: number; createdAt: string | null; startedAt: string | null; completedAt: string | null;
  outcome: 'open' | 'completed' | 'failed' | 'cancelled' | 'unknown';
}
export interface CiTimingRecord {
  version: 1; provider: 'github'; repository: string; headBranch: string; headSha: string;
  workflowPath: '.github/workflows/branch-image.yml'; event: 'push' | 'workflow_dispatch';
  runId: number; runAttempt: number; jobs: CiTimingJob[]; truncated: boolean;
}
export const CI_TIMING_JOB_LIMIT = 100;
export function isCiTimingTarget(value: CiTimingTarget): boolean {
  return Boolean(value && Number.isSafeInteger(value.installationId) && value.installationId > 0
    && typeof value.repository === 'string' && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value.repository)
    && typeof value.branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value.branch)
    && typeof value.headSha === 'string' && /^[a-f0-9]{40}$/i.test(value.headSha));
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const canonical = new Date(ms).toISOString();
  return canonical.slice(0, 19) === value.slice(0, 19) ? canonical : null;
}
/** Only exact provider identities are accepted; no run/step timestamp substitution. */
export function projectCiTiming(target: CiTimingTarget, run: any, response: any): CiTimingRecord | null {
  if (!isCiTimingTarget(target) || !run || !positive(run.id) || !positive(run.run_attempt)
    || run.path !== '.github/workflows/branch-image.yml' || !['push', 'workflow_dispatch'].includes(run.event)
    || run.repository?.full_name !== target.repository || run.head_repository?.full_name !== target.repository
    || run.head_branch !== target.branch || run.head_sha !== target.headSha
    || !response || !Array.isArray(response.jobs) || !Number.isSafeInteger(response.total_count) || response.total_count < 0) return null;
  const value: CiTimingRecord = { version: 1, provider: 'github', repository: target.repository,
    headBranch: target.branch, headSha: target.headSha, workflowPath: '.github/workflows/branch-image.yml', event: run.event,
    runId: run.id, runAttempt: run.run_attempt, jobs: [],
    truncated: response.total_count !== response.jobs.length || response.jobs.length > CI_TIMING_JOB_LIMIT };
  const seen = new Set<number>();
  for (const job of response.jobs.slice(0, CI_TIMING_JOB_LIMIT)) {
    if (!job || !positive(job.id) || seen.has(job.id) || job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== target.headSha) {
      value.truncated = true; continue;
    }
    seen.add(job.id);
    const outcome: CiTimingJob['outcome'] = job.status === 'queued' || job.status === 'in_progress' || job.status === 'waiting' ? 'open'
      : job.status !== 'completed' ? 'unknown' : job.conclusion === 'success' ? 'completed'
        : job.conclusion === 'cancelled' ? 'cancelled' : ['failure', 'timed_out', 'action_required'].includes(job.conclusion) ? 'failed' : 'unknown';
    value.jobs.push({ id: job.id, createdAt: timestamp(job.created_at), startedAt: timestamp(job.started_at), completedAt: timestamp(job.completed_at), outcome });
  }
  return value;
}
/** Re-project persisted/external records: reject malformed identity and remove arbitrary fields. */
export function sanitizeCiTiming(value: CiTimingRecord | null | undefined, target: CiTimingTarget): CiTimingRecord | null {
  if (!value || value.version !== 1 || value.provider !== 'github' || !Array.isArray(value.jobs)) return null;
  const run = { id: value.runId, run_attempt: value.runAttempt, path: value.workflowPath, event: value.event,
    repository: { full_name: value.repository }, head_repository: { full_name: value.repository }, head_branch: value.headBranch, head_sha: value.headSha };
  const result = projectCiTiming(target, run, { total_count: value.jobs.length, jobs: value.jobs.slice(0, CI_TIMING_JOB_LIMIT).map(job => ({ id: job?.id,
    run_id: value.runId, run_attempt: value.runAttempt, head_sha: value.headSha, created_at: job?.createdAt,
    started_at: job?.startedAt, completed_at: job?.completedAt, status: job?.outcome === 'open' ? 'in_progress' : 'completed',
    conclusion: ({ completed: 'success', failed: 'failure', cancelled: 'cancelled' } as Record<string, string>)[job?.outcome] })) });
  if (result) result.truncated ||= value.truncated === true;
  return result;
}
function empty(): DeploymentStageSummary { return { status: 'not-observed', completedWallMs: null, workMs: null, intervals: 0, open: 0, unknown: 0, completed: 0, failed: 0, cancelled: 0 }; }
function union(ranges: [number, number][]): number | null {
  if (!ranges.length) return null;
  ranges.sort((a, b) => a[0] - b[0]); let total = 0, [start, end] = ranges[0];
  for (const [s, e] of ranges.slice(1)) { if (s <= end) end = Math.max(end, e); else { total += end - start; start = s; end = e; } }
  return total + end - start;
}
export function summarizeCiTiming(record: CiTimingRecord | null | undefined) {
  const target = { installationId: 1, repository: record?.repository || '', branch: record?.headBranch || '', headSha: record?.headSha || '' };
  const value = sanitizeCiTiming(record, target), runner = empty(), build = empty();
  const a: [number, number][] = [], b: [number, number][] = [];
  function measure(summary: DeploymentStageSummary, ranges: [number, number][], start: string | null, end: string | null, outcome: CiTimingJob['outcome']) {
    summary.intervals++;
    if (outcome === 'open') { summary.open++; return; }
    if (!start || !end || outcome === 'unknown' || Date.parse(end) < Date.parse(start)) { summary.unknown++; return; }
    summary[outcome]++;
    const s = Date.parse(start), e = Date.parse(end); ranges.push([s, e]); summary.workMs = (summary.workMs ?? 0) + e - s;
  }
  for (const job of value?.jobs || []) {
    measure(runner, a, job.createdAt, job.startedAt, job.startedAt ? 'completed' : job.outcome);
    measure(build, b, job.startedAt, job.completedAt, job.outcome);
  }
  for (const [summary, ranges] of [[runner, a], [build, b]] as const) {
    summary.completedWallMs = union(ranges);
    summary.status = summary.intervals === 0 ? 'not-observed' : summary.unknown || summary.open || value?.truncated ? 'incomplete' : 'observed';
  }
  return { version: 1 as const, clock: 'github-provider' as const, runnerMeaning: 'job-pre-start' as const, buildMeaning: 'job-execution' as const,
    incomplete: !value || value.truncated || runner.status !== 'observed' || build.status !== 'observed', truncated: Boolean(value?.truncated), runner, build,
    provenance: value ? { repository: value.repository, headBranch: value.headBranch, headSha: value.headSha, workflowPath: value.workflowPath,
      event: value.event, runId: value.runId, runAttempt: value.runAttempt, jobs: value.jobs.length } : null };
}

interface Ticket { target: CiTimingTarget; publish: (value: CiTimingRecord | null) => void; controller: AbortController; timer: ReturnType<typeof setTimeout>; done: boolean; }
/** No deploy wait. A timed-out underlying call retains its slot until it actually settles. */
export class CiTimingCollector {
  private active = 0;
  private queue: Ticket[] = [];
  private cache = new Map<string, { at: number; value: CiTimingRecord }>();
  private readonly maxActive: number;
  private readonly maxQueued: number;
  private readonly timeoutMs: number;
  constructor(private readonly fetch: (target: CiTimingTarget, signal: AbortSignal) => Promise<CiTimingRecord | null>,
    options: { maxActive?: number; maxQueued?: number; timeoutMs?: number } = {}) {
    this.maxActive = Math.max(1, Math.min(4, Math.trunc(options.maxActive || 4)));
    this.maxQueued = Math.max(1, Math.min(16, Math.trunc(options.maxQueued || 16)));
    this.timeoutMs = Math.max(1, Math.min(3000, Math.trunc(options.timeoutMs || 3000)));
  }
  private key(t: CiTimingTarget) { return JSON.stringify([t.installationId, t.repository, t.branch, t.headSha]); }
  capture(target: CiTimingTarget, publish: Ticket['publish']): boolean {
    if (!isCiTimingTarget(target) || this.queue.length >= this.maxQueued) return false;
    const own = { ...target }, key = this.key(own), cached = this.cache.get(key);
    if (cached && Date.now() >= cached.at && Date.now() - cached.at < 30000) { queueMicrotask(() => { try { publish(structuredClone(cached.value)); } catch { /* Observation only. */ } }); return true; }
    if (cached) this.cache.delete(key);
    const ticket: Ticket = { target: own, publish, controller: new AbortController(), done: false, timer: undefined as any };
    ticket.timer = setTimeout(() => {
      this.finish(ticket, null); ticket.controller.abort(); this.queue = this.queue.filter(item => item !== ticket);
    }, this.timeoutMs);
    this.queue.push(ticket); queueMicrotask(() => this.drain()); return true;
  }
  private finish(ticket: Ticket, value: CiTimingRecord | null) {
    if (ticket.done) return; ticket.done = true; clearTimeout(ticket.timer);
    try { ticket.publish(value && structuredClone(value)); } catch { /* Never change deploy work or log provider data. */ }
  }
  private drain() {
    while (this.active < this.maxActive && this.queue.length) {
      const ticket = this.queue.shift()!; if (ticket.done) continue; this.active++;
      Promise.resolve().then(() => this.fetch(ticket.target, ticket.controller.signal)).then(raw => {
        if (ticket.done) return;
        const value = sanitizeCiTiming(raw, ticket.target);
        if (value) {
          const key = this.key(ticket.target); this.cache.delete(key); this.cache.set(key, { at: Date.now(), value });
          while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
        }
        this.finish(ticket, value);
      }, () => this.finish(ticket, null)).finally(() => { this.active--; this.drain(); });
    }
  }
}
