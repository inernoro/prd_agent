/**
 * 缺陷计数的唯一读法——前端这一侧。
 *
 * 写入侧不拦负数（`normDefectCounts` 收下 `{ p0: -1 }`），所以任何直接把这些数相加或
 * 直接渲染的地方都会出事：相加时负数会抵消掉真实的阻断数，渲染时屏幕上会出现「P1 -2」。
 * 后端 `blockingDefects` 已按同一口径夹过；这里是同一条判据在前端的那一份，
 * 两侧行为由 `cds/tests/web/codex-review-1532-r19-web.test.ts` 钉在一起。
 */

/** 单档计数：负数、NaN、Infinity 一律按零算。 */
export function severityCount(v: number | undefined | null): number {
  return Number.isFinite(v) && (v as number) > 0 ? (v as number) : 0;
}

/** 阻断缺陷数 = P0 + P1，逐档夹过之后再相加。 */
export function blockingDefects(counts: Record<string, number> | null | undefined): number {
  if (!counts) return 0;
  return severityCount(counts.p0 ?? counts.P0) + severityCount(counts.p1 ?? counts.P1);
}
