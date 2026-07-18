import type { IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';

export const SELF_UPDATE_RUNTIME_BRANCH_PREFIX = 'cds-self-update-runtime/';

export interface SelfUpdateCheckoutResult {
  ok: boolean;
  actualBranch: string;
  usedRuntimeBranch: boolean;
  error?: string;
}

export function resolveSelfUpdateTargetBranch(currentBranch: string): string {
  const normalized = currentBranch.trim();
  if (!normalized || normalized === 'HEAD') return '';
  if (!normalized.startsWith(SELF_UPDATE_RUNTIME_BRANCH_PREFIX)) return normalized;
  return normalized.slice(SELF_UPDATE_RUNTIME_BRANCH_PREFIX.length);
}

/** 将 origin/HEAD 的符号引用解析为可用于自更新的真实分支名。 */
export function resolveRemoteDefaultBranch(remoteRef: string): string {
  const normalized = remoteRef.trim()
    .replace(/^refs\/remotes\/origin\//, '')
    .replace(/^origin\//, '');
  if (!normalized || normalized === 'HEAD' || normalized === 'origin') return '';
  return resolveSelfUpdateTargetBranch(normalized);
}

/**
 * CDS 处于 detached HEAD 时，选择一个稳定且可解释的更新目标。
 * 优先级：当前逻辑分支 > origin/HEAD > main > master > 最近的远端分支。
 */
export function recommendSelfUpdateTargetBranch(
  currentBranch: string,
  remoteBranches: string[],
  remoteDefaultBranch = '',
): string {
  const current = resolveSelfUpdateTargetBranch(currentBranch);
  if (current) return current;

  const available = remoteBranches
    .map(resolveSelfUpdateTargetBranch)
    .filter((branch): branch is string => Boolean(branch));
  const remoteDefault = resolveRemoteDefaultBranch(remoteDefaultBranch);
  if (remoteDefault && (available.length === 0 || available.includes(remoteDefault))) return remoteDefault;
  if (available.includes('main')) return 'main';
  if (available.includes('master')) return 'master';
  return available[0] || 'main';
}

/**
 * 将 CDS 自身工作树切到指定远端分支。
 *
 * CDS 会在同一仓库下为应用分支创建 git worktree，因此 main 等目标分支
 * 可能已经被应用工作树占用。直接 checkout 会失败，继续 checkout -b 又会
 * 因本地分支已存在失败。此时使用只属于控制面的本地 runtime 分支跟踪
 * origin/<target>，避免移动应用工作树共享的本地分支引用。
 */
export async function checkoutSelfUpdateTarget(
  shell: IShellExecutor,
  repoRoot: string,
  targetBranch: string,
): Promise<SelfUpdateCheckoutResult> {
  const direct = await shell.exec(`git checkout -f ${targetBranch}`, { cwd: repoRoot, timeout: 30_000 });
  if (direct.exitCode === 0) {
    return { ok: true, actualBranch: targetBranch, usedRuntimeBranch: false };
  }

  const create = await shell.exec(
    `git checkout -f -b ${targetBranch} origin/${targetBranch}`,
    { cwd: repoRoot, timeout: 30_000 },
  );
  if (create.exitCode === 0) {
    return { ok: true, actualBranch: targetBranch, usedRuntimeBranch: false };
  }

  const runtimeBranch = `${SELF_UPDATE_RUNTIME_BRANCH_PREFIX}${targetBranch}`;
  const isolated = await shell.exec(
    `git checkout -f -B ${runtimeBranch} origin/${targetBranch}`,
    { cwd: repoRoot, timeout: 30_000 },
  );
  if (isolated.exitCode === 0) {
    return { ok: true, actualBranch: runtimeBranch, usedRuntimeBranch: true };
  }

  const error = (
    combinedOutput(isolated)
    || combinedOutput(create)
    || combinedOutput(direct)
    || '未知错误'
  ).trim();
  return {
    ok: false,
    actualBranch: '',
    usedRuntimeBranch: false,
    error,
  };
}
