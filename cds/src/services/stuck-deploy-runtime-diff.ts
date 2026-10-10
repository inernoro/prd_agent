import type { BranchEntry, IShellExecutor } from '../types.js';
import { analyzeChangeImpact } from './change-impact-analyzer.js';

interface DiffRequest { key: string; cwd: string; from: string; to: string; projectId: string; queuedAt: number; }

/** Read-only evidence cache. Unknown evidence suppresses an alarm, never a deployment. */
export class StuckDeployRuntimeDiff {
  private readonly cache = new Map<string, boolean>();
  private readonly pending = new Set<string>();
  private readonly queue: DiffRequest[] = [];
  private active = false;

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
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    if (!this.pending.has(key) && this.pending.size < 64) {
      this.pending.add(key);
      this.queue.push({ key, cwd, from, to, projectId, queuedAt: this.now() });
      void this.drain();
    }
    return false;
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try {
          if (this.now() - job.queuedAt > 5000) continue;
          // cwd is never shell interpolated. Revisions contain only verified hex.
          const result = await this.shell.exec(`git diff --name-only ${job.from}..${job.to} --`, {
            cwd: job.cwd, timeout: 5000, priority: 'diagnostic', schedulingGroup: `stuck-diff:${job.projectId}`,
          });
          if (result.exitCode !== 0) continue;
          const impact = analyzeChangeImpact(result.stdout.split('\n').filter(Boolean));
          if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(job.key, impact.needsRestart || impact.hotReloadablePaths.length > 0);
        } catch { /* Failed evidence stays unknown; next watchdog tick may retry. */ }
        finally { this.pending.delete(job.key); }
      }
    } finally { this.active = false; }
  }
}
