/**
 * 「强制更新」要带的版本切换声明（纯函数，可单测）。
 *
 * 背景（2026-07-30 用户实拍两张报错图）：后端 `evaluateSelfUpdateTransition` 对
 * **非快进**切换要求三件事——`transitionIntent`（release / rollback）、
 * `expectedFromSha`、`transitionReason`。但前端 `runSelfUpdate` 从来只发
 * `{ branch, force }`，于是点了那个写着「强制更新」的按钮，却被告知
 * 「必须显式声明 release 或 rollback」。用户原话：「我都这么明显了好吧」。
 *
 * 这是典型的「链路只建到一半」：闸门后加，UI 没跟上，而且失败信息还反过来
 * 要求用户做他刚刚做过的事。
 *
 * 为什么**不**在前端猜 intent：
 * self-status 的 `localAheadCount` / `remoteAheadCount` 是拿
 * `HEAD...origin/<comparisonBranch>` 算的，而 `comparisonBranch = currentBranch`
 * —— 是 CDS **当前**分支，不是用户选的目标分支。拿它推「这次是发布还是回滚」
 * 会在跨分支切换时给出一个自信的错误答案，而那正是这道闸要拦的事故
 * （多 Agent 分支互相覆盖）。所以 intent 必须由人在对话框里选。
 */

export type SelfUpdateIntent = 'release' | 'rollback';

/** 后端 `transitionReason` 的长度约束（self-update-checkout.ts）。 */
export const TRANSITION_REASON_MIN = 8;
export const TRANSITION_REASON_MAX = 300;

export interface ForceSyncTransitionInput {
  /** 当前 CDS 的 HEAD sha（self-status 的 headSha）。 */
  headSha: string;
  targetBranch: string;
  intent: SelfUpdateIntent;
  reason: string;
}

export interface ForceSyncTransitionBody {
  branch?: string;
  force: true;
  transitionIntent: SelfUpdateIntent;
  expectedFromSha: string;
  transitionReason: string;
}

/**
 * 默认原因。要同时满足「≥8 字符」和「说得出是谁在什么地方干的」——
 * 审计栏里看到「从 CDS 系统设置强制切到 xxx」比看到「force」有用得多。
 */
export function defaultTransitionReason(
  intent: SelfUpdateIntent,
  targetBranch: string,
): string {
  const action = intent === 'rollback' ? '回滚' : '发布';
  const branch = targetBranch.trim() || '当前分支';
  return `从 CDS 系统设置强制${action}到 ${branch}`;
}

/** 原因是否满足后端约束。返回不合法的理由，合法时返回 undefined。 */
export function validateTransitionReason(reason: string): string | undefined {
  const value = reason.trim();
  if (value.length < TRANSITION_REASON_MIN) {
    return `原因至少 ${TRANSITION_REASON_MIN} 个字符（当前 ${value.length}）`;
  }
  if (value.length > TRANSITION_REASON_MAX) {
    return `原因最多 ${TRANSITION_REASON_MAX} 个字符（当前 ${value.length}）`;
  }
  // 与后端同一条判据：控制字符会让审计记录里出现不可见内容。
  if (/[\u0000-\u001f\u007f]/.test(value)) return '原因不能包含控制字符';
  return undefined;
}

/**
 * 组装 `/api/self-force-sync` 的请求体。
 *
 * 三个字段**无条件**带上，不在前端判断「这次到底要不要声明」：
 * 后端的 same-sha / fast-forward 两条捷径都排在 intent 校验之前，快进时这些字段
 * 会被直接忽略。少一个客户端预测，就少一处会漂移的判据。
 */
export function buildForceSyncBody(input: ForceSyncTransitionInput): ForceSyncTransitionBody {
  const branch = input.targetBranch.trim();
  return {
    ...(branch ? { branch } : {}),
    force: true,
    transitionIntent: input.intent,
    expectedFromSha: input.headSha.trim(),
    transitionReason: input.reason.trim(),
  };
}

/**
 * 能不能发起强制更新。缺 headSha 时**不发**：`expectedFromSha` 是防「基于过期状态
 * 覆盖生产」的那道锁，拿不到当前 sha 就等于把锁交出去，应该让用户先刷新状态。
 */
export function forceSyncBlockedReason(
  headSha: string,
  reason: string,
): string | undefined {
  if (!headSha.trim()) return '读不到当前 CDS 版本，请先点「刷新分支」再试';
  return validateTransitionReason(reason);
}
