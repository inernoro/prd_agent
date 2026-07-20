import type { IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';

export const SELF_UPDATE_RUNTIME_BRANCH_PREFIX = 'cds-self-update-runtime/';

export interface SelfUpdateCheckoutResult {
  ok: boolean;
  actualBranch: string;
  usedRuntimeBranch: boolean;
  error?: string;
}

export type SelfUpdateTransitionIntent = 'release' | 'rollback';

export interface SelfUpdateTransitionInput {
  currentSha: string;
  targetSha: string;
  targetContainsCurrent: boolean;
  intent?: string;
  expectedFromSha?: string;
  reason?: string;
}

export type SelfUpdateTransitionDecision =
  | {
      allowed: true;
      mode: 'same-sha' | 'fast-forward' | SelfUpdateTransitionIntent;
      reason: string;
    }
  | {
      allowed: false;
      code:
        | 'non_fast_forward_update_requires_intent'
        | 'invalid_transition_intent'
        | 'expected_from_sha_required'
        | 'expected_from_sha_mismatch'
        | 'transition_reason_required';
      message: string;
    };

function shaMatches(expected: string, actual: string): boolean {
  const left = expected.trim().toLowerCase();
  const right = actual.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(left) || !/^[0-9a-f]{7,40}$/.test(right)) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

/**
 * 共享 CDS 控制面的版本切换门禁。
 *
 * 旧客户端无需新增字段即可继续执行同 SHA 重启和快进更新。只有会丢掉当前
 * 已部署提交的非快进切换，才要求调用方显式声明 release/rollback、当前 SHA
 * 和原因。这样既阻断多 Agent 分支互相覆盖，也不会一次升级就让旧技能失效。
 */
export function evaluateSelfUpdateTransition(
  input: SelfUpdateTransitionInput,
): SelfUpdateTransitionDecision {
  if (shaMatches(input.currentSha, input.targetSha)) {
    return { allowed: true, mode: 'same-sha', reason: 'target equals current revision' };
  }
  if (input.targetContainsCurrent) {
    return { allowed: true, mode: 'fast-forward', reason: 'target contains current revision' };
  }

  const rawIntent = input.intent?.trim() || '';
  if (!rawIntent) {
    return {
      allowed: false,
      code: 'non_fast_forward_update_requires_intent',
      message: '目标版本不包含当前 CDS 提交；必须显式声明 release 或 rollback。',
    };
  }
  if (rawIntent !== 'release' && rawIntent !== 'rollback') {
    return {
      allowed: false,
      code: 'invalid_transition_intent',
      message: 'transitionIntent 只允许 release 或 rollback。',
    };
  }
  if (!input.expectedFromSha?.trim()) {
    return {
      allowed: false,
      code: 'expected_from_sha_required',
      message: '非快进切换必须提供 expectedFromSha，避免基于过期状态覆盖生产。',
    };
  }
  if (!shaMatches(input.expectedFromSha, input.currentSha)) {
    return {
      allowed: false,
      code: 'expected_from_sha_mismatch',
      message: 'expectedFromSha 与当前 CDS 提交不一致，请重新读取 self-status。',
    };
  }
  const reason = input.reason?.trim() || '';
  if (reason.length < 8 || reason.length > 300 || /[\u0000-\u001f\u007f]/.test(reason)) {
    return {
      allowed: false,
      code: 'transition_reason_required',
      message: '非快进切换必须提供 8-300 字符且不含控制字符的原因。',
    };
  }
  return {
    allowed: true,
    mode: rawIntent,
    reason,
  };
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
