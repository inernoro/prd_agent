import type { BranchEntry, IShellExecutor } from '../types.js';
import { analyzeChangeImpact } from './change-impact-analyzer.js';

interface DiffRequest { key: string; identity: string; cwd: string; from: string; to: string; projectId: string; queuedAt: number; }

/** Read-only evidence cache. Unknown evidence suppresses an alarm, never a deployment. */
export class StuckDeployRuntimeDiff {
  private readonly cache = new Map<string, boolean>();
  private readonly pending = new Set<string>();
  private readonly queue: DiffRequest[] = [];
  private active = false;
  private scheduled = false;
  private lastAttemptedIdentity: string | undefined;

  constructor(private readonly shell: IShellExecutor, private readonly now = Date.now) {}

  hasRuntimeChanges(branch: BranchEntry): boolean {
    const from = branch.ciTargetSha;
    const to = branch.githubCommitSha;
    const cwd = branch.worktreePath;
    if (typeof from !== 'string' || typeof to !== 'string' ||
      !/^[a-f0-9]{40}$/.test(from) || !/^[a-f0-9]{40}$/.test(to) ||
      typeof cwd !== 'string' || !cwd || cwd.length > 4096) return false;
    const projectId = branch.projectId || 'default';
    const key = JSON.stringify([projectId, branch.id, cwd, from, to]);
    const job: DiffRequest = { key, identity: JSON.stringify([projectId, branch.id]), cwd, from, to, projectId, queuedAt: this.now() };
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    if (this.pending.has(key)) return false;
    if (this.pending.size >= 64) {
      // Keep the nearest targets AFTER the last attempted project/branch identity, regardless of
      // the caller's enumeration order. Never evict the one executing request.
      this.queue.sort((a, b) => this.compare(a, b));
      const worst = this.queue.at(-1);
      if (!worst || this.compare(job, worst) >= 0) return false;
      this.queue.pop();
      this.pending.delete(worst.key);
    }
    this.pending.add(key);
    this.queue.push(job);
    // Gather this synchronous watchdog scan before selecting its first target.
    if (!this.active && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => { this.scheduled = false; void this.drain(); });
    }
    return false;
  }

  private compare(a: DiffRequest, b: DiffRequest): number {
    const after = (identity: string) => this.lastAttemptedIdentity === undefined || identity > this.lastAttemptedIdentity;
    if (after(a.identity) !== after(b.identity)) return after(a.identity) ? -1 : 1;
    if (a.identity !== b.identity) return a.identity < b.identity ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length) {
        this.queue.sort((a, b) => this.compare(a, b));
        const job = this.queue.shift()!;
        try {
          if (this.now() - job.queuedAt > 5000) continue;
          // Advance on failure too. Expired/unexecuted work does not advance the cursor.
          this.lastAttemptedIdentity = job.identity;
          // cwd is never shell interpolated. Revisions contain only verified hex.
          const result = await this.shell.exec(`git diff --name-only ${job.from}..${job.to} --`, {
            cwd: job.cwd, timeout: 5000, priority: 'diagnostic', schedulingGroup: `stuck-diff:${job.projectId}`,
          });
          if (result.exitCode !== 0) continue;
          const impact = analyzeChangeImpact(result.stdout.split('\n').filter(Boolean));
          if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(job.key, impact.needsRestart || impact.hotReloadablePaths.length > 0);
        } catch { /* Failed evidence stays unknown; a later watchdog scan may retry fairly. */ }
        finally { this.pending.delete(job.key); }
      }
    } finally { this.active = false; }
  }
}
