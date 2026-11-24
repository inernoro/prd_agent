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

/**
 * 生效结论：有阻断缺陷即 fail，否则按报告自己写的那个。
 *
 * 后端在 `toRef` 那个边界上换算过一次，聚合出来的一切都带生效结论；但台账那一列读的是
 * 报告列表接口的原始数据，不经过 refs。少了这一步，同一屏会一边说「有功能坏了」，
 * 一边把那份罪魁报告显示成「通过」。
 */
export function effectiveVerdict(
  r: { verdict?: 'pass' | 'conditional' | 'fail' | null; defectCounts?: Record<string, number> | null },
): 'pass' | 'conditional' | 'fail' | null {
  if (blockingDefects(r.defectCounts) > 0) return 'fail';
  return r.verdict ?? null;
}
