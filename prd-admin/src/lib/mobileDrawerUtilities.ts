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

/**
 * 按 MOBILE_DRAWER_UTILITY_ROUTES 的顺序从（已按权限过滤的）目录里取条目。
 * 目录里查不到就是「该用户看不见」，直接丢掉。
 */
export function resolveMobileDrawerUtilities(catalog: LauncherItem[]): MobileDrawerUtility[] {
  return MOBILE_DRAWER_UTILITY_ROUTES.flatMap(({ route, hint }) => {
    const item = catalog.find((it) => it.route === route);
    return item ? [{ route, hint, item }] : [];
  });
}
