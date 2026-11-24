/**
 * 对照表表头那两个合计数。
 *
 * 行里用 -1 当「数量未知」的哨兵：源站没报这个集合时 sourceTotal 是 -1，
 * 本站白名单不认识它时 localTotal 是 -1。逐行渲染时它们被正确显示成「未知」，
 * 但表头直接把整列加起来，哨兵就被当成 -1 条真实数据参与求和——合计要么少算，
 * 要么在集合少、未知多的时候直接变成负数。
 *
 * 对照表是操作者按下「开始」之前唯一一次看清「要写什么」的机会，所以这一行数字
 * 宁可说「其中 N 个未知」，也不能给一个算错的确定值。
 */
export interface PlanTotalsRow {
  sourceTotal: number;
  localTotal: number;
}

export interface PlanTotals {
  /** 已知部分的合计。 */
  sourceTotal: number;
  localTotal: number;
  /** 数量未知的集合数；大于 0 时合计只是下限。 */
  sourceUnknown: number;
  localUnknown: number;
}

export function computePlanTotals(rows: readonly PlanTotalsRow[]): PlanTotals {
  let sourceTotal = 0;
  let localTotal = 0;
  let sourceUnknown = 0;
  let localUnknown = 0;
  for (const row of rows) {
    // 只认非负数。负数一律当未知，不只挡 -1——将来换个哨兵值也不会悄悄把合计算歪。
    if (row.sourceTotal >= 0) sourceTotal += row.sourceTotal;
    else sourceUnknown += 1;
    if (row.localTotal >= 0) localTotal += row.localTotal;
    else localUnknown += 1;
  }
  return { sourceTotal, localTotal, sourceUnknown, localUnknown };
}

/** 「1234 条」或「1234 条（另有 2 个集合数量未知）」。 */
export function describeTotal(total: number, unknown: number): string {
  return unknown > 0 ? `${total} 条（另有 ${unknown} 个集合数量未知）` : `${total} 条`;
}
