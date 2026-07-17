import { describe, expect, it } from 'vitest';
import type { ExecOptions, ExecResult, IShellExecutor } from '../../src/types.js';
import {
  checkoutSelfUpdateTarget,
  resolveSelfUpdateTargetBranch,
  SELF_UPDATE_RUNTIME_BRANCH_PREFIX,
} from '../../src/services/self-update-checkout.js';

class SequenceShell implements IShellExecutor {
  readonly commands: string[] = [];

  constructor(private readonly results: ExecResult[]) {}

  async exec(command: string, _options?: ExecOptions): Promise<ExecResult> {
    this.commands.push(command);
    return this.results.shift() || { exitCode: 1, stdout: '', stderr: 'missing result' };
  }
}

const ok = (): ExecResult => ({ exitCode: 0, stdout: '', stderr: '' });
const fail = (stderr: string): ExecResult => ({ exitCode: 1, stdout: '', stderr });

describe('checkoutSelfUpdateTarget', () => {
  it('uses the requested branch when direct checkout succeeds', async () => {
    const shell = new SequenceShell([ok()]);

    await expect(checkoutSelfUpdateTarget(shell, '/repo', 'main')).resolves.toEqual({
      ok: true,
      actualBranch: 'main',
      usedRuntimeBranch: false,
    });
    expect(shell.commands).toEqual(['git checkout -f main']);
  });

  it('creates a tracking branch when the branch is not local yet', async () => {
    const shell = new SequenceShell([fail('unknown branch'), ok()]);

    await expect(checkoutSelfUpdateTarget(shell, '/repo', 'feature/test')).resolves.toEqual({
      ok: true,
      actualBranch: 'feature/test',
      usedRuntimeBranch: false,
    });
    expect(shell.commands[1]).toBe('git checkout -f -b feature/test origin/feature/test');
  });

  it('uses an isolated runtime branch when another worktree owns main', async () => {
    const shell = new SequenceShell([
      fail("fatal: 'main' is already used by worktree"),
      fail("fatal: a branch named 'main' already exists"),
      ok(),
    ]);

    await expect(checkoutSelfUpdateTarget(shell, '/repo', 'main')).resolves.toEqual({
      ok: true,
      actualBranch: `${SELF_UPDATE_RUNTIME_BRANCH_PREFIX}main`,
      usedRuntimeBranch: true,
    });
    expect(shell.commands[2]).toBe(
      'git checkout -f -B cds-self-update-runtime/main origin/main',
    );
  });

  it('returns the final checkout error when all strategies fail', async () => {
    const shell = new SequenceShell([fail('direct'), fail('create'), fail('isolated')]);

    await expect(checkoutSelfUpdateTarget(shell, '/repo', 'main')).resolves.toMatchObject({
      ok: false,
      error: 'isolated',
    });
  });
});

describe('resolveSelfUpdateTargetBranch', () => {
  it('restores the remote target from a runtime branch', () => {
    expect(resolveSelfUpdateTargetBranch('cds-self-update-runtime/codex/example')).toBe('codex/example');
  });

  it('keeps ordinary branches unchanged', () => {
    expect(resolveSelfUpdateTargetBranch('main')).toBe('main');
  });
});
