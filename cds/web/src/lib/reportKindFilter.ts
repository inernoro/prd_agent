/**
 * 台账「报告类型」页签的可选性判据。
 *
 * 页签只渲染当前作用域里有报告的类型（count > 0），而过滤仍按 kindFilter 走。
 * 切项目、切文件夹、改搜索之后，选中的那个类型可能一份都不剩：页签被摘掉，
 * 台账却还在按它过滤，于是空台账 + 没有任何选中的控件能解释或清掉它。
 *
 * 判据挂在「选中项还在不在可选集合里」，不挂在「项目变了没有」——后者只盖住
 * 三条触发路径里的一条（predicate-and-wiring-discipline 形状 1：判据太窄）。
 */
export const ALL_KINDS = 'all';

/** 选中的类型已经不在可选集合里就退回全部；其余情况原样返回。 */
export function resolveKindFilter(current: string, available: readonly { kind: string }[]): string {
  if (current === ALL_KINDS) return ALL_KINDS;
  return available.some((t) => t.kind === current) ? current : ALL_KINDS;
}
