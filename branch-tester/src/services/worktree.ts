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

  /** Pull latest code for an existing worktree */
  async pull(branch: string, targetDir: string): Promise<string> {
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

    // Return short log of HEAD for confirmation
    const logResult = await this.shell.exec(
      'git log --oneline -1',
      { cwd: targetDir },
    );
    return logResult.stdout.trim();
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
