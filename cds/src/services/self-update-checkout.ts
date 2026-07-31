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
      // 文案要说清「去哪儿声明」。只写「必须显式声明」的话，从 UI 点「强制更新」
      // 过来的人会觉得自己刚刚已经声明过了——2026-07-30 用户原话「我都这么明显了好吧」。
      // 前端漏传字段是根因（已修），这句话是第二道保险：万一还有别的调用方漏传，
      // 至少告诉他缺哪三个字段。
      message: '目标版本不包含当前 CDS 提交（非快进切换）。'
        + '请在「CDS 系统设置 → 更新与重启 → 强制更新」里选择「发布新版本」或「回滚旧版本」并填写原因；'
        + 'API 调用需同时提供 transitionIntent、expectedFromSha、transitionReason。',
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

/**
 * 「强制更新」的版本切换解析 —— **永不拒绝**。
 *
 * 为什么和 evaluateSelfUpdateTransition 分开（2026-07-30 用户定的原则）：
 * 强制更新是用户控制 CDS 的**最后手段**。CDS 卡在一个坏分支上、门禁判据本身出问题、
 * 或者运维侧临时关了普通更新时，用户必须还有一条一定能走通的路。一个能被策略拒绝的
 * 「强制」根本不叫强制 —— 用户原话：「强制更新一定是忽略所有条件，不然用户没有任何
 * 手段控制 CDS」。
 *
 * 旧实现让 /api/self-force-sync 也走严格闸门，还在 hint 里写「强制同步不能绕过版本
 * 继承门禁」，等于给逃生门上了锁。
 *
 * 门禁的原意是拦「**隐式**的跨分支覆盖」（多个 Agent 各自 push 自己的分支，谁最后
 * 调一次自更新谁赢）。而强制更新是人点了一个写着「强制更新」的按钮、过了二次确认、
 * 还自己选了目标分支——这已经是最强的显式意图，再要求一次声明是同义反复。
 *
 * 所以这里只做两件事：判出**这次是什么性质的切换**（供审计与日志），
 * 以及把调用方给的原因原样带上（没给就写清「未声明」，不编一个假的）。
 */
export function resolveForceSyncTransition(input: {
  currentSha: string;
  targetSha: string;
  targetContainsCurrent: boolean;
  intent?: string;
  reason?: string;
}): { mode: 'same-sha' | 'fast-forward' | SelfUpdateTransitionIntent; reason: string } {
  const rawReason = input.reason?.trim() || '';
  // 控制字符会让审计记录里出现不可见内容；这里**不拒绝**，只是不采用。
  const auditReason = rawReason && !/[\u0000-\u001f\u007f]/.test(rawReason)
    ? rawReason.slice(0, 300)
    : '强制更新（调用方未声明原因）';

  if (shaMatches(input.currentSha, input.targetSha)) {
    return { mode: 'same-sha', reason: auditReason };
  }
  if (input.targetContainsCurrent) {
    return { mode: 'fast-forward', reason: auditReason };
  }

  // 非快进。调用方声明了就照它记；没声明也照样放行，性质记为 release
  // （「切到一条不包含当前提交的线上去」这个描述对 release / rollback 都成立，
  // 而把它记成 rollback 会在审计里造成「回滚到一个更新版本」这种自相矛盾的记录）。
  const rawIntent = input.intent?.trim();
  const mode: SelfUpdateTransitionIntent = rawIntent === 'rollback' ? 'rollback' : 'release';
  return { mode, reason: auditReason };
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
