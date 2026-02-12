import type { IShellExecutor } from '../types.js';

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
      throw new Error(`Failed to fetch branch "${branch}": ${fetchResult.stderr}`);
    }

    const addResult = await this.shell.exec(
      `git worktree add "${targetDir}" "origin/${branch}"`,
      { cwd: this.repoRoot },
    );
    if (addResult.exitCode !== 0) {
      throw new Error(`Failed to create worktree for "${branch}": ${addResult.stderr}`);
    }
  }

  async remove(targetDir: string): Promise<void> {
    const result = await this.shell.exec(
      `git worktree remove --force "${targetDir}"`,
      { cwd: this.repoRoot },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to remove worktree "${targetDir}": ${result.stderr}`);
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
