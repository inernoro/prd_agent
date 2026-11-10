import type { CodeReviewTask } from './code-review.js';

export const REVIEW_LIST_SOURCES = ['source', 'report', 'all'] as const;
export const REVIEW_LIST_STATUSES = ['all', 'active', 'attention', 'partial', 'completed', 'failed', 'cancelled', 'queued', 'preparing', 'running', 'archiving'] as const;
export type ReviewListSource = typeof REVIEW_LIST_SOURCES[number];
export type ReviewListStatus = typeof REVIEW_LIST_STATUSES[number];
const active = (task: CodeReviewTask) => ['queued', 'preparing', 'running', 'archiving'].includes(task.status);
const partial = (task: CodeReviewTask) => task.sourceType !== 'report' && !active(task)
  && task.progress.scannedFiles > 0 && task.progress.scannedFiles < task.progress.totalFiles;
const time = (task: CodeReviewTask) => Date.parse(task.createdAt) || 0;

/** Input must already be restricted to the caller's projects. The cutoff keeps refreshes stable. */
export function pageCodeReviewTasks(tasks: CodeReviewTask[], options: {
  source: ReviewListSource; status: ReviewListStatus; query: string; history: boolean; offset: number; limit: number; snapshotAt?: string;
}) {
  const snapshotAt = options.snapshotAt || new Date(tasks.reduce((latest, task) => Math.max(latest, time(task)), Date.now())).toISOString();
  const cutoff = Date.parse(snapshotAt);
  const overview = (input: CodeReviewTask[]) => {
    if (options.history) return input;
    const latest = new Map<string, CodeReviewTask>();
    for (const task of input) if (task.sourceType !== 'report') {
      const previous = latest.get(task.projectId);
      if (!previous || time(task) > time(previous) || time(task) === time(previous) && task.id < previous.id) latest.set(task.projectId, task);
    }
    return [...latest.values(), ...input.filter(task => task.sourceType === 'report')];
  };
  const search = options.query.trim().toLocaleLowerCase();
  const matches = (task: CodeReviewTask) => {
    if (options.source !== 'all' && (task.sourceType === 'report') !== (options.source === 'report')) return false;
    if (options.status === 'active' && !active(task)) return false;
    if (options.status === 'partial' && !partial(task)) return false;
    if (options.status === 'attention' && !(task.status === 'failed' || task.status === 'cancelled' || partial(task) || task.delivery.status === 'failed'
      || task.sourceType !== 'report' && task.status === 'completed' && task.progress.scannedFiles <= 0)) return false;
    if (!['all', 'active', 'partial', 'attention'].includes(options.status) && task.status !== options.status) return false;
    return !search || [task.title, task.sourceName, task.id, task.branchName || task.ref || '', task.commitSha || '', task.sourceHash || '']
      .some(value => value.toLocaleLowerCase().includes(search));
  };
  const eligible = tasks.filter(task => time(task) <= cutoff);
  const stable = overview(eligible);
  const records = stable.filter(matches).sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id));
  const offset = Math.min(options.offset, Math.max(0, Math.floor((records.length - 1) / options.limit) * options.limit));
  return { tasks: records.slice(offset, offset + options.limit), snapshotAt,
    newCount: tasks.filter(task => time(task) > cutoff && matches(task)).length,
    totals: { source: stable.filter(task => task.sourceType !== 'report').length, report: stable.filter(task => task.sourceType === 'report').length, all: stable.length },
    historyCount: eligible.length - stable.length,
    page: { offset, limit: options.limit, total: records.length, nextOffset: offset + options.limit < records.length ? offset + options.limit : null } };
}
