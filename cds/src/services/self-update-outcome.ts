/**
 * 自更新结果对账：**更新到底成没成，以重启之后的事实为准**。
 *
 * ## 为什么要有
 *
 * 2026-08-18：一次自更新把构建、tsc、web bundle 全跑完，历史里记下
 * `status: success`、`toSha: 6d2da7de`、`error: null`。而机器上真实的 HEAD 是
 * 上一个版本，处于 detached 状态——新版本启动即崩溃，systemd 重试超限后退回旧版。
 *
 * 也就是说：**「构建成功」被当成了「更新成功」**。我据此以为改动已经上线，
 * 实际没有，白白多花了很久才发现。回滚这件事在任何地方都查不到，连一条 error
 * 都没有。这不是记录不全，是记录**说了假话**。
 *
 * ## 判据
 *
 * 更新记录声称自己更到了某个 sha；进程重启之后再看一眼 HEAD：
 *
 * - 对得上 → 这次更新真的落地了
 * - 对不上 → 中途被退回了。不管过程多顺利，结论都是**没更新成功**
 *
 * 只在「记录说自己成功了」时才对账：失败记录本来就没声称落地，不需要翻案。
 */
export interface SelfUpdateClaim {
  /** 记录写的目标 sha。 */
  toSha?: string | null;
  /** 记录自己写的结论。 */
  status?: string | null;
  ts?: string | null;
}

export interface SelfUpdateReconcileResult {
  /** 需要翻案：记录说成功，实际没落地。 */
  rolledBack: boolean;
  /** 给人看的一句话。 */
  message: string;
  claimedSha?: string;
  actualSha?: string;
}

/** sha 有长短两种写法，取共同前缀比。长度不足的按无效处理。 */
function shaMatches(claimed: string, actual: string): boolean {
  const a = claimed.trim().toLowerCase();
  const b = actual.trim().toLowerCase();
  if (a.length < 7 || b.length < 7) return false;
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

export function reconcileSelfUpdateOutcome(
  claim: SelfUpdateClaim | null | undefined,
  actualHeadSha: string | null | undefined,
): SelfUpdateReconcileResult {
  const claimed = String(claim?.toSha || '').trim();
  const actual = String(actualHeadSha || '').trim();

  if (!claim || String(claim.status || '') !== 'success') {
    return { rolledBack: false, message: '最近一次自更新没有声称成功，无需对账' };
  }
  if (!claimed || !actual) {
    // 读不出来就不下结论——不确定不等于失败，编一个「已回滚」同样是假话。
    return {
      rolledBack: false,
      message: `无法对账：${!claimed ? '记录里没有目标 sha' : '读不到当前 HEAD'}`,
      claimedSha: claimed || undefined,
      actualSha: actual || undefined,
    };
  }
  if (shaMatches(claimed, actual)) {
    return { rolledBack: false, message: `自更新已落地（${actual}）`, claimedSha: claimed, actualSha: actual };
  }
  return {
    rolledBack: true,
    claimedSha: claimed,
    actualSha: actual,
    message: `自更新记录声称已更到 ${claimed} 且状态为成功，但重启后 HEAD 实际是 ${actual}`
      + `——中途被退回了。构建成功不等于更新成功，请按 HEAD 为准。`,
  };
}
