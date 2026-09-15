import type { LauncherItem } from '@/lib/launcherCatalog';

/**
 * 移动抽屉底部的实用工具直达入口。
 *
 * 手机端没有桌面侧栏的账号菜单，也没有首页搜索；默认导航又只画后端 menuCatalog
 * 里带 group 的项，于是 NAV_REGISTRY 登记的实用工具在手机上彻底找不到（#1479）。
 * 这里只列路由和一句提示，标签 / 图标 / 权限门一律取自 launcherCatalog（NAV_REGISTRY 派生），
 * 不再手写第二份；没有权限的条目会被目录过滤掉，抽屉里自然不出现。
 */
export const MOBILE_DRAWER_UTILITY_ROUTES: ReadonlyArray<{ route: string; hint: string }> = [
  { route: '/mcp-console', hint: '连接 / 记录' },
  { route: '/authorization-health', hint: '401 诊断' },
];

export interface MobileDrawerUtility {
  route: string;
  hint: string;
  item: LauncherItem;
}

export interface ResolveMobileDrawerUtilitiesOptions {
  /** 用户「我的导航」里隐藏的条目 id（launcher id，如 utility:authorization-health），隐藏即不再从抽屉底部露出 */
  hiddenIds?: Iterable<string>;
  /** 已经画在抽屉主导航里的项（用户显式加进 navOrder 的 launcher 条目），按 appKey 或路由去重，避免同一入口出现两次 */
  alreadyShown?: Iterable<{ appKey?: string; route?: string }>;
}

/**
 * 按 MOBILE_DRAWER_UTILITY_ROUTES 的顺序从（已按权限过滤的）目录里取条目。
 * 目录里查不到就是「该用户看不见」，直接丢掉。
 *
 * 同时遵守导航偏好契约（Codex review P2，#1479）：
 *   - 用户在「我的导航」隐藏了它 → 抽屉底部也不露；
 *   - 用户把它显式拖进了 navOrder → 主导航已画，这里不再画第二次。
 */
export function resolveMobileDrawerUtilities(
  catalog: LauncherItem[],
  opts: ResolveMobileDrawerUtilitiesOptions = {},
): MobileDrawerUtility[] {
  const hidden = new Set(opts.hiddenIds ?? []);
  const shownKeys = new Set<string>();
  for (const it of opts.alreadyShown ?? []) {
    if (it.appKey) shownKeys.add(it.appKey);
    if (it.route) shownKeys.add(it.route);
  }
  return MOBILE_DRAWER_UTILITY_ROUTES.flatMap(({ route, hint }) => {
    const item = catalog.find((it) => it.route === route);
    if (!item) return [];
    if (hidden.has(item.id)) return [];
    if (shownKeys.has(item.id) || shownKeys.has(route)) return [];
    return [{ route, hint, item }];
  });
}
