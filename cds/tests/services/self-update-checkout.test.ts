import { describe, expect, it } from 'vitest';
import type { ExecOptions, ExecResult, IShellExecutor } from '../../src/types.js';
import {
  checkoutSelfUpdateTarget,
  evaluateSelfUpdateTransition,
  recommendSelfUpdateTargetBranch,
  resolveRemoteDefaultBranch,
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

  it('does not treat detached HEAD as a branch', () => {
    expect(resolveSelfUpdateTargetBranch('HEAD')).toBe('');
    expect(resolveSelfUpdateTargetBranch('  HEAD\n')).toBe('');
  });
});

describe('self-update branch recommendation', () => {
  it('resolves the remote default branch from common symbolic-ref shapes', () => {
    expect(resolveRemoteDefaultBranch('refs/remotes/origin/main')).toBe('main');
    expect(resolveRemoteDefaultBranch('origin/release')).toBe('release');
    expect(resolveRemoteDefaultBranch('origin')).toBe('');
  });

  it('prefers the remote default when HEAD is detached', () => {
    expect(recommendSelfUpdateTargetBranch('HEAD', ['release', 'main'], 'origin/release')).toBe('release');
  });

  it('falls back to main instead of exposing HEAD', () => {
    expect(recommendSelfUpdateTargetBranch('HEAD', ['feature/test', 'main'])).toBe('main');
  });
});

describe('self-update production transition guard', () => {
  const currentSha = 'dfbb677fc6068bac729a07cfaaba9675fb4dc95d';
  const targetSha = 'f167b2fed365292c2f6c13f9f7154adc60d6db2d';

  it('keeps legacy clients compatible for same-sha restart', () => {
    expect(evaluateSelfUpdateTransition({
      currentSha,
      targetSha: currentSha,
      targetContainsCurrent: true,
    })).toMatchObject({ allowed: true, mode: 'same-sha' });
  });

  it('keeps legacy clients compatible for fast-forward updates', () => {
    expect(evaluateSelfUpdateTransition({
      currentSha,
      targetSha,
      targetContainsCurrent: true,
    })).toMatchObject({ allowed: true, mode: 'fast-forward' });
  });

  it('blocks a non-fast-forward branch replacement without explicit intent', () => {
    expect(evaluateSelfUpdateTransition({
      currentSha,
      targetSha,
      targetContainsCurrent: false,
    })).toEqual({
      allowed: false,
      code: 'non_fast_forward_update_requires_intent',
      message: '目标版本不包含当前 CDS 提交；必须显式声明 release 或 rollback。',
    });
  });

  it('requires optimistic locking and an audit reason for an explicit release', () => {
    expect(evaluateSelfUpdateTransition({
      currentSha,
      targetSha,
      targetContainsCurrent: false,
      intent: 'release',
      expectedFromSha: '319d2a0ef',
      reason: '发布新的控制面能力',
    })).toMatchObject({ allowed: false, code: 'expected_from_sha_mismatch' });

    expect(evaluateSelfUpdateTransition({
      currentSha,
      targetSha,
      targetContainsCurrent: false,
      intent: 'release',
      expectedFromSha: currentSha,
      reason: 'short',
    })).toMatchObject({ allowed: false, code: 'transition_reason_required' });
  });

  it('allows an intentional non-fast-forward release with current-SHA lock', () => {
    expect(evaluateSelfUpdateTransition({
      currentSha,
      targetSha,
      targetContainsCurrent: false,
      intent: 'release',
      expectedFromSha: 'dfbb677fc',
      reason: '把已验证的共享控制面修复纳入新的发布基线',
    })).toEqual({
      allowed: true,
      mode: 'release',
      reason: '把已验证的共享控制面修复纳入新的发布基线',
    });
  });

  it('rejects control characters in audit reasons', () => {
    expect(evaluateSelfUpdateTransition({
      currentSha,
      targetSha,
      targetContainsCurrent: false,
      intent: 'rollback',
      expectedFromSha: currentSha,
      reason: '回滚到稳定版本\n伪造日志',
    })).toMatchObject({ allowed: false, code: 'transition_reason_required' });
  });
});
