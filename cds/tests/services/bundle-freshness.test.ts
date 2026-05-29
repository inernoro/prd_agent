import { describe, expect, it } from 'vitest';
import { computeBundleFreshness } from '../../src/services/bundle-freshness.js';
import type { ExecOptions, ExecResult, IShellExecutor } from '../../src/types.js';

function shellWithDiff(stdout: string, exitCode = 0, stderr = ''): IShellExecutor {
  return {
    async exec(_command: string, _options?: ExecOptions): Promise<ExecResult> {
      return {
        exitCode,
        stdout,
        stderr,
      };
    },
  };
}

describe('computeBundleFreshness', () => {
  it('treats matching short/full sha prefixes as fresh without diffing', async () => {
    let called = false;
    const result = await computeBundleFreshness({
      repoRoot: '/repo',
      shell: {
        async exec(): Promise<ExecResult> {
          called = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      headSha: '0168f3904',
      bundleSha: '0168f3904abc1234567890abcdef1234567890ab',
    });

    expect(called).toBe(false);
    expect(result.bundleStale).toBe(false);
    expect(result.staleReason).toBe('matched');
  });

  it('does not mark the bundle stale when the only changed files are tests/docs', async () => {
    const result = await computeBundleFreshness({
      repoRoot: '/repo',
      shell: shellWithDiff('cds/tests/services/branch-operation-coordinator.test.ts\nREADME.md\n'),
      headSha: 'abcdef1',
      bundleSha: '1234567',
    });

    expect(result.bundleStale).toBe(false);
    expect(result.staleReason).toBe('irrelevant-only');
    expect(result.changeImpact?.irrelevantPaths).toHaveLength(2);
  });

  it('marks runtime code diffs as stale', async () => {
    const result = await computeBundleFreshness({
      repoRoot: '/repo',
      shell: shellWithDiff('cds/src/routes/branches.ts\n'),
      headSha: 'abcdef1',
      bundleSha: '1234567',
    });

    expect(result.bundleStale).toBe(true);
    expect(result.staleReason).toBe('runtime-diff');
    expect(result.changeImpact?.hotReloadablePaths).toEqual(['cds/src/routes/branches.ts']);
  });

  it('keeps build errors stale even when sha matches', async () => {
    const result = await computeBundleFreshness({
      repoRoot: '/repo',
      shell: shellWithDiff(''),
      headSha: 'abcdef1',
      bundleSha: 'abcdef1',
      buildError: 'vite failed',
    });

    expect(result.bundleStale).toBe(true);
    expect(result.staleReason).toBe('build-error');
  });

  it('fails closed when git diff cannot determine changed files', async () => {
    const result = await computeBundleFreshness({
      repoRoot: '/repo',
      shell: shellWithDiff('', 128, 'bad revision'),
      headSha: 'abcdef1',
      bundleSha: '1234567',
    });

    expect(result.bundleStale).toBe(true);
    expect(result.staleReason).toBe('diff-failed');
  });
});
