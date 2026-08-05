/*
 * shouldDismissOnPointerDown — 「这次 pointerdown 该不该关掉这个浮层」的唯一判定。
 *
 * 抽成纯函数是为了可测：cds 的 vitest 没有 jsdom 环境（cds/vitest.config.ts），
 * 真实事件行为测不了；抽出来之后可以用 stub 节点直接断言各种输入，而不必退化成
 * 「源码里含某段字面量」这种反向锁死的断言。
 *
 * 判据要覆盖的三类「其实还在浮层里」的点击（漏一类就是 predicate-and-wiring-discipline
 * 形状 1「判据比它该管的范围窄」）：
 *   1. 点在浮层自己身上
 *   2. 点在触发按钮上——必须排除，否则 pointerdown 先关、紧接着 button 的 click 再开，
 *      浮层永远关不掉
 *   3. 点在浮层内部组件 portal 出去的弹层上（Radix Dialog 挂在 body，DOM 上不在浮层内）
 */

/**
 * 只要求「有个 contains 方法」，参数用 any 是刻意的：真实 DOM 节点的签名是
 * `(other: Node | null) => boolean`，用 unknown 会因逆变而不兼容，测试里的 stub
 * 节点又给不出真 Node。这里用鸭子类型收口，调用点自己保证传的是节点。
 */
export interface OutsideDismissTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contains?: (node: any) => boolean;
}

export interface OutsideDismissOptions {
  /** 事件目标 */
  target: unknown;
  /** 浮层自身与触发器；任一 contains 命中即视为「浮层内部」 */
  owned: Array<OutsideDismissTarget | null | undefined>;
  /**
   * 额外豁免的选择器（用 closest 匹配）。默认豁免 [role="dialog"]：
   * 浮层内部组件把 Dialog portal 到 body，不豁免的话在弹窗里一点就会把浮层
   * 连同弹窗一起卸载。
   */
  exemptSelectors?: string[];
}

const DEFAULT_EXEMPT = ['[role="dialog"]'];

export function shouldDismissOnPointerDown({
  target,
  owned,
  exemptSelectors = DEFAULT_EXEMPT,
}: OutsideDismissOptions): boolean {
  if (!target) return true;

  for (const node of owned) {
    if (node && typeof node.contains === 'function' && node.contains(target)) return false;
  }

  const closest = (target as { closest?: (selector: string) => unknown }).closest;
  if (typeof closest === 'function') {
    for (const selector of exemptSelectors) {
      if (closest.call(target, selector)) return false;
    }
  }

  return true;
}
