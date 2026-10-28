import type { BranchEntry } from '../types.js';
import { analyzeChangeImpact } from './change-impact-analyzer.js';
import { isCommitShaLike } from './release-commit-clock.js';
import type { ReleaseGitRunner } from './release-git-reader.js';
import { reconcileStuckDeployStates, type ReconcileStuckDeployOptions, type DeployStuckReconcileResult } from './deploy-stuck-reconciler.js';

interface Options {
  getBranches: () => BranchEntry[];
  getOptions: () => ReconcileStuckDeployOptions;
  git: ReleaseGitRunner;
  onReconciled?: (results: DeployStuckReconcileResult[]) => void;
}
interface Candidate { key: string; args: string[]; immutable: boolean }
const MAX_READS = 16;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_CACHE_ENTRIES = 512;
const MAX_CACHE_BYTES = 1024 * 1024;

function keyOf(branch: BranchEntry): string | undefined {
  if (!branch.worktreePath || !branch.ciTargetSha || !branch.githubCommitSha ||
    !isCommitShaLike(branch.ciTargetSha) || !isCommitShaLike(branch.githubCommitSha)) return;
  const key = JSON.stringify([branch.worktreePath, branch.ciTargetSha, branch.githubCommitSha]);
  return Buffer.byteLength(key) <= MAX_KEY_BYTES ? key : undefined;
}

/** 生命周期立即收敛；Git结束后重读权威状态，绝不写回await前的分支快照。 */
export class AsyncStuckDeployReconciler {
  private cursor = 0;
  private inflight?: Promise<void>;
  private cacheBytes = 0;
  private readonly cache = new Map<string, { runtime: boolean; bytes: number }>();
  constructor(private readonly options: Options) {}

  run(): Promise<void> {
    if (this.inflight) return this.inflight;
    const run = this.runOnce();
    this.inflight = run;
    void run.then(() => { this.inflight = undefined; }, () => { this.inflight = undefined; });
    return run;
  }

  private remember(key: string, runtime: boolean): void {
    if (this.cache.has(key)) return;
    const bytes = Buffer.byteLength(key);
    while (this.cache.size >= MAX_CACHE_ENTRIES || this.cacheBytes + bytes > MAX_CACHE_BYTES) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      this.cache.delete(oldest[0]); this.cacheBytes -= oldest[1].bytes;
    }
    this.cache.set(key, { runtime, bytes }); this.cacheBytes += bytes;
  }

  private apply(branches: Iterable<BranchEntry>, diffRuntimePaths: (branch: BranchEntry) => boolean): void {
    const results = reconcileStuckDeployStates(branches, { ...this.options.getOptions(), diffRuntimePaths });
    if (results.length) this.options.onReconciled?.(results);
  }

  private async runOnce(): Promise<void> {
    const branches = this.options.getBranches();
    const pending = new Map<string, Candidate>();
    const start = this.cursor % Math.max(1, branches.length);
    let currentIndex = start;
    function* rotated(): Iterable<BranchEntry> {
      for (let count = 0; count < branches.length; count++) {
        currentIndex = (start + count) % branches.length;
        yield branches[currentIndex];
      }
    }
    this.apply(rotated(), branch => {
      const key = keyOf(branch);
      if (!key) return false;
      const cached = this.cache.get(key);
      if (cached) return cached.runtime;
      if (pending.size < MAX_READS && !pending.has(key)) {
        pending.set(key, { key, args: ['-C', branch.worktreePath, 'diff', '--name-only', `${branch.ciTargetSha}..${branch.githubCommitSha}`, '--'],
          immutable: branch.ciTargetSha!.length === 40 && branch.githubCommitSha!.length === 40 });
        this.cursor = currentIndex + 1;
      }
      return false; // 没有成功证据不告警；不是缓存的确定false。
    });
    if (!pending.size) return;
    const currentReads = new Map<string, boolean>();
    await Promise.all([...pending.values()].map(async candidate => {
      try {
        const output = await this.options.git(candidate.args);
        if (Buffer.byteLength(output) > 256 * 1024) return;
        const impact = analyzeChangeImpact(output.split('\n').filter(Boolean));
        const runtime = impact.needsRestart || impact.hotReloadablePaths.length > 0;
        currentReads.set(candidate.key, runtime);
        // 短SHA仍可读取和当轮告警；不把缩写解析当永久不可变证据缓存。
        if (candidate.immutable) this.remember(candidate.key, runtime);
      } catch { /* 不缓存失败，下轮轮转重试；不影响其他分支的生命周期收敛。 */ }
    }));
    this.apply(this.options.getBranches(), branch => {
      const key = keyOf(branch);
      return key ? currentReads.get(key) ?? this.cache.get(key)?.runtime ?? false : false;
    });
  }
}
