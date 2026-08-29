/**
 * 订阅一个 media query 的变化，带老旧 Safari 回退。
 *
 * 为什么需要它：Safari 14（2020-09）之前的 `MediaQueryList` **没有** `addEventListener`，
 * 只有 `addListener` / `removeListener`。直接 `mql.addEventListener('change', …)` 在那些浏览器上
 * 是 `undefined is not a function`，会当场抛在 effect 里 —— 不是降级，是整块功能炸掉。
 *
 * 本仓库此前已有三处各自写了这段回退（`lib/useReducedMotion.ts`、`stores/themeStore.ts`、
 * `hooks/usePrefersReducedMotion.ts`），第四处（外观「随系统」）漏写就直接踩中。
 * 新代码一律用这个函数，不要再抄第四份；守卫见 `lib/__tests__/mediaQuerySubscribe.test.ts`。
 *
 * 返回取消订阅函数；拿不到 matchMedia（SSR / 老环境）时返回空函数。
 */
type LegacyMediaQueryList = MediaQueryList & {
  addListener?: (callback: () => void) => void;
  removeListener?: (callback: () => void) => void;
};

export function subscribeMediaQuery(query: string, onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};

  const mql = window.matchMedia(query);
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }

  const legacy = mql as LegacyMediaQueryList;
  legacy.addListener?.(onChange);
  return () => legacy.removeListener?.(onChange);
}
