import type { IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';
import { StateService } from './state.js';

/**
 * WorktreeService — thin wrapper around `git worktree` for building
 * isolated checkouts of a single repository.
 *
 * ── P4 Part 18 (G1) ─────────────────────────────────────────────
 * Previously this class held a single `_repoRoot` field, set in the
 * constructor and rarely mutated. That worked fine when CDS managed
 * exactly one Git repository bind-mounted at `config.repoRoot`, but
 * the multi-project clone flow (`.cds/repos/<projectId>`) needs the
 * repo root to vary per call. Keeping it as instance state would
 * introduce race conditions between concurrent deploys from
 * different projects.
 *
 * The fix is stateless: every method that touches `git` takes
 * `repoRoot` as its first argument, and callers resolve the right
 * root via `StateService.getProjectRepoRoot(projectId, fallback)`.
 * `pull()` is the one exception — it already uses `targetDir` (the
 * worktree itself) as its `cwd`, so it doesn't need a separate
 * repoRoot at all.
 *
 * The proxy auto-build path, the bootstrap main-branch path, and
 * all executor routes still operate on a single repo — they pass
 * `config.repoRoot` directly, preserving the legacy single-repo
 * behavior for users who haven't yet adopted multi-project.
 */
export class WorktreeService {
  constructor(private readonly shell: IShellExecutor) {}

  async create(repoRoot: string, branch: string, targetDir: string): Promise<void> {
    const fetchResult = await this.shell.exec(
      `git fetch origin ${branch}`,
      { cwd: repoRoot },
    );
    if (fetchResult.exitCode !== 0) {
      throw new Error(`拉取分支 "${branch}" 失败:\n${combinedOutput(fetchResult)}`);
    }

    // Always prune stale worktree references before creating a new one.
    // This handles the case where git has a registered worktree whose
    // directory no longer exists (e.g. after a crash or manual rm).
    await this.shell.exec('git worktree prune', { cwd: repoRoot });

    // Remove leftover directory if it still exists
    const checkDir = await this.shell.exec(`test -d "${targetDir}" && echo exists`);
    if (checkDir.stdout.trim() === 'exists') {
      await this.shell.exec(`rm -rf "${targetDir}"`);
    }

    const addResult = await this.shell.exec(
      `git worktree add "${targetDir}" "origin/${branch}"`,
      { cwd: repoRoot },
    );
    if (addResult.exitCode !== 0) {
      throw new Error(`创建工作树 "${branch}" 失败:\n${combinedOutput(addResult)}`);
    }
  }

  /** Pull latest code for an existing worktree.
   *  Returns { head, before, after, updated } so caller can detect "already up to date".
   *
   *  NOTE: `pull` does not need `repoRoot` because every git command
   *  runs inside `targetDir` (the worktree itself) rather than the
   *  host repo root. Kept at the 2-arg signature for that reason. */
  async pull(branch: string, targetDir: string): Promise<{ head: string; before: string; after: string; updated: boolean }> {
    // Get current SHA before pull
    const beforeResult = await this.shell.exec(
      'git rev-parse --short HEAD',
      { cwd: targetDir },
    );
    const before = beforeResult.stdout.trim();

    // Fetch latest from remote
    const fetchResult = await this.shell.exec(
      `git fetch origin ${branch}`,
      { cwd: targetDir },
    );
    if (fetchResult.exitCode !== 0) {
      throw new Error(`拉取失败:\n${combinedOutput(fetchResult)}`);
    }

    // Hard reset worktree to latest remote HEAD
    const resetResult = await this.shell.exec(
      `git reset --hard origin/${branch}`,
      { cwd: targetDir },
    );
    if (resetResult.exitCode !== 0) {
      throw new Error(`重置失败:\n${combinedOutput(resetResult)}`);
    }

    // Get new SHA after pull
    const afterResult = await this.shell.exec(
      'git rev-parse --short HEAD',
      { cwd: targetDir },
    );
    const after = afterResult.stdout.trim();

    // Return short log of HEAD for confirmation
    const logResult = await this.shell.exec(
      'git log --oneline -1',
      { cwd: targetDir },
    );
    return { head: logResult.stdout.trim(), before, after, updated: before !== after };
  }

  async remove(repoRoot: string, targetDir: string): Promise<void> {
    const result = await this.shell.exec(
      `git worktree remove --force "${targetDir}"`,
      { cwd: repoRoot },
    );
    if (result.exitCode !== 0) {
      throw new Error(`删除工作树 "${targetDir}" 失败:\n${combinedOutput(result)}`);
    }
  }

  async branchExists(repoRoot: string, branch: string): Promise<boolean> {
    const result = await this.shell.exec(
      `git ls-remote --heads origin "${branch}"`,
      { cwd: repoRoot },
    );
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  }

  /**
   * Find a remote branch whose name ends with the given suffix.
   * Returns the full branch name or null.
   */
  async findBranchBySuffix(repoRoot: string, suffix: string): Promise<string | null> {
    const result = await this.shell.exec(
      `git ls-remote --heads origin`,
      { cwd: repoRoot },
    );
    if (result.exitCode !== 0) return null;

    const lowerSuffix = suffix.toLowerCase();
    const branches = result.stdout.trim().split('\n')
      .map(line => line.replace(/^.*refs\/heads\//, '').trim())
      .filter(Boolean);

    // Exact match first
    const exact = branches.find(b => b.toLowerCase() === lowerSuffix);
    if (exact) return exact;

    // Suffix match: branch name ends with the suffix
    const suffixMatch = branches.find(b => {
      const lower = b.toLowerCase();
      return lower.endsWith(`/${lowerSuffix}`) || lower.endsWith(`-${lowerSuffix}`);
    });
    return suffixMatch || null;
  }

  /**
   * Find a remote branch whose slugified name matches the given slug.
   * This handles cases where the slug (e.g. "claude-fix-software-defects-dlxzp")
   * was derived from a branch with "/" (e.g. "claude/fix-software-defects-dlxzp").
   */
  async findBranchBySlug(repoRoot: string, slug: string): Promise<string | null> {
    const result = await this.shell.exec(
      `git ls-remote --heads origin`,
      { cwd: repoRoot },
    );
    if (result.exitCode !== 0) return null;

    const branches = result.stdout.trim().split('\n')
      .map(line => line.replace(/^.*refs\/heads\//, '').trim())
      .filter(Boolean);

    const lowerSlug = slug.toLowerCase();
    return branches.find(b => StateService.slugify(b) === lowerSlug) || null;
  }
}
