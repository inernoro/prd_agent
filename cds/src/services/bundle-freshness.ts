import type { IShellExecutor } from '../types.js';
import { analyzeChangeImpact, type ChangeImpactResult } from './change-impact-analyzer.js';

export interface BundleFreshnessResult {
  bundleStale: boolean;
  headEqualsBundle: boolean;
  staleReason:
    | 'matched'
    | 'missing-sha'
    | 'build-error'
    | 'invalid-sha'
    | 'diff-failed'
    | 'no-file-diff'
    | 'irrelevant-only'
    | 'runtime-diff';
  changedPaths: string[];
  changeImpact: ChangeImpactResult | null;
  detail?: string;
}

function isSafeGitShaPrefix(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

function sameShaPrefix(a: string, b: string): boolean {
  return Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));
}

export async function computeBundleFreshness(
  ctx: {
    repoRoot: string;
    shell: IShellExecutor;
    headSha: string;
    bundleSha: string;
    buildError?: string;
  },
): Promise<BundleFreshnessResult> {
  const headSha = (ctx.headSha || '').trim();
  const bundleSha = (ctx.bundleSha || '').trim();
  const buildError = (ctx.buildError || '').trim();

  if (buildError) {
    return {
      bundleStale: true,
      headEqualsBundle: false,
      staleReason: 'build-error',
      changedPaths: [],
      changeImpact: null,
      detail: buildError.slice(0, 500),
    };
  }

  if (!headSha || !bundleSha) {
    return {
      bundleStale: false,
      headEqualsBundle: false,
      staleReason: 'missing-sha',
      changedPaths: [],
      changeImpact: null,
    };
  }

  if (sameShaPrefix(headSha, bundleSha)) {
    return {
      bundleStale: false,
      headEqualsBundle: true,
      staleReason: 'matched',
      changedPaths: [],
      changeImpact: null,
    };
  }

  if (!isSafeGitShaPrefix(headSha) || !isSafeGitShaPrefix(bundleSha)) {
    return {
      bundleStale: true,
      headEqualsBundle: false,
      staleReason: 'invalid-sha',
      changedPaths: [],
      changeImpact: null,
      detail: 'headSha 或 bundleSha 不是安全的 git SHA 前缀',
    };
  }

  const diff = await ctx.shell.exec(
    `git diff --name-only ${bundleSha}..${headSha}`,
    { cwd: ctx.repoRoot, timeout: 3_000 },
  );
  if (diff.exitCode !== 0) {
    return {
      bundleStale: true,
      headEqualsBundle: false,
      staleReason: 'diff-failed',
      changedPaths: [],
      changeImpact: null,
      detail: (diff.stderr || diff.stdout || '').trim().slice(0, 500),
    };
  }

  const changedPaths = diff.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 200);
  if (changedPaths.length === 0) {
    return {
      bundleStale: false,
      headEqualsBundle: false,
      staleReason: 'no-file-diff',
      changedPaths,
      changeImpact: analyzeChangeImpact(changedPaths),
    };
  }

  const changeImpact = analyzeChangeImpact(changedPaths);
  if (
    changeImpact.restartTriggers.length === 0
    && changeImpact.hotReloadablePaths.length === 0
    && changeImpact.irrelevantPaths.length === changedPaths.length
  ) {
    return {
      bundleStale: false,
      headEqualsBundle: false,
      staleReason: 'irrelevant-only',
      changedPaths,
      changeImpact,
    };
  }

  return {
    bundleStale: true,
    headEqualsBundle: false,
    staleReason: 'runtime-diff',
    changedPaths,
    changeImpact,
  };
}
