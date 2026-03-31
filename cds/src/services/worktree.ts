import type { IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';
import { StateService } from './state.js';

export class WorktreeService {
  private _repoRoot: string;

  constructor(
    private readonly shell: IShellExecutor,
    repoRoot: string,
  ) {
    this._repoRoot = repoRoot;
  }

  get repoRoot(): string {
    return this._repoRoot;
  }

  set repoRoot(value: string) {
    this._repoRoot = value;
  }

  async create(branch: string, targetDir: string): Promise<void> {
    const fetchResult = await this.shell.exec(
      `git fetch origin ${branch}`,
      { cwd: this.repoRoot },
    );
    if (fetchResult.exitCode !== 0) {
      throw new Error(`拉取分支 "${branch}" 失败:\n${combinedOutput(fetchResult)}`);
    }

    // Always prune stale worktree references before creating a new one.
    // This handles the case where git has a registered worktree whose
    // directory no longer exists (e.g. after a crash or manual rm).
    await this.shell.exec('git worktree prune', { cwd: this.repoRoot });

    // Remove leftover directory if it still exists
    const checkDir = await this.shell.exec(`test -d "${targetDir}" && echo exists`);
    if (checkDir.stdout.trim() === 'exists') {
      await this.shell.exec(`rm -rf "${targetDir}"`);
    }

    const addResult = await this.shell.exec(
      `git worktree add "${targetDir}" "origin/${branch}"`,
      { cwd: this.repoRoot },
    );
    if (addResult.exitCode !== 0) {
      throw new Error(`创建工作树 "${branch}" 失败:\n${combinedOutput(addResult)}`);
    }
  }

  /** Pull latest code for an existing worktree.
   *  Returns { head, before, after, updated } so caller can detect "already up to date". */
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

  async remove(targetDir: string): Promise<void> {
    const result = await this.shell.exec(
      `git worktree remove --force "${targetDir}"`,
      { cwd: this.repoRoot },
    );
    if (result.exitCode !== 0) {
      throw new Error(`删除工作树 "${targetDir}" 失败:\n${combinedOutput(result)}`);
    }
  }

  async branchExists(branch: string): Promise<boolean> {
    const result = await this.shell.exec(
      `git ls-remote --heads origin "${branch}"`,
      { cwd: this.repoRoot },
    );
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  }

  /**
   * Find a remote branch whose name ends with the given suffix.
   * Returns the full branch name or null.
   */
  async findBranchBySuffix(suffix: string): Promise<string | null> {
    const result = await this.shell.exec(
      `git ls-remote --heads origin`,
      { cwd: this.repoRoot },
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
  async findBranchBySlug(slug: string): Promise<string | null> {
    const result = await this.shell.exec(
      `git ls-remote --heads origin`,
      { cwd: this.repoRoot },
    );
    if (result.exitCode !== 0) return null;

    const branches = result.stdout.trim().split('\n')
      .map(line => line.replace(/^.*refs\/heads\//, '').trim())
      .filter(Boolean);

    const lowerSlug = slug.toLowerCase();
    return branches.find(b => StateService.slugify(b) === lowerSlug) || null;
  }
}
