/**
 * 额度条上那一段填充画多宽。
 *
 * 单独拿出来是因为它有一个不显然的取舍：**用过就必须看得见**。
 * 按真实比例画的话，1 / 200 是 0.5%，在一条几像素高的轨道上等于没画 ——
 * 「今天用了一点」和「今天一次没用」会长得一模一样，而这两件事对用户完全不同
 * （一个说明这台客户端真的在干活，一个说明它可能根本没接通）。
 *
 * 所以只要用过，就至少给一个看得见的最小宽度；一次没用才是真的空。
 * 代价是极小的用量会被画得比实际略宽 —— 旁边就写着确切数字，不靠这条估数。
 */
export const MIN_VISIBLE_PERCENT = 4;

export function quotaFillPercent(used: number, quota: number): number {
  if (!(used > 0)) return 0;
  if (!(quota > 0)) return 100; // 没有上限却用过：画满，别画成空的
  const pct = Math.min(100, Math.round((used / quota) * 100));
  return Math.max(pct, MIN_VISIBLE_PERCENT);
}
