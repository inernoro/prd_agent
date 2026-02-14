import type { IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';

export class WorktreeService {
  constructor(
    private readonly shell: IShellExecutor,
    private readonly repoRoot: string,
  ) {}

  async create(branch: string, targetDir: string): Promise<void> {
    const fetchResult = await this.shell.exec(
      `git fetch origin ${branch}`,
      { cwd: this.repoRoot },
    );
    if (fetchResult.exitCode !== 0) {
      throw new Error(`Failed to fetch branch "${branch}":\n${combinedOutput(fetchResult)}`);
    }

    const addResult = await this.shell.exec(
      `git worktree add "${targetDir}" "origin/${branch}"`,
      { cwd: this.repoRoot },
    );
    if (addResult.exitCode !== 0) {
      throw new Error(`Failed to create worktree for "${branch}":\n${combinedOutput(addResult)}`);
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
      throw new Error(`Failed to fetch:\n${combinedOutput(fetchResult)}`);
    }

    // Hard reset worktree to latest remote HEAD
    const resetResult = await this.shell.exec(
      `git reset --hard origin/${branch}`,
      { cwd: targetDir },
    );
    if (resetResult.exitCode !== 0) {
      throw new Error(`Failed to reset:\n${combinedOutput(resetResult)}`);
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
      throw new Error(`Failed to remove worktree "${targetDir}":\n${combinedOutput(result)}`);
    }
  }

  async branchExists(branch: string): Promise<boolean> {
    const result = await this.shell.exec(
      `git ls-remote --heads origin "${branch}"`,
      { cwd: this.repoRoot },
    );
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  }
}
