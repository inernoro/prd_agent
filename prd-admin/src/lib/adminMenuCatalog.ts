import type { AdminMenuItem } from '@/services/contracts/authz';

const WEEKLY_POSTER_MENU_ITEM: AdminMenuItem = {
  appKey: 'weekly-poster',
  path: '/weekly-poster',
  label: '海报设计',
  description: '独立海报设计工作台',
  icon: 'Sparkles',
  sortOrder: 15,
  group: 'tools',
};

function canUseWeeklyPoster(args: { permissions?: string[] | null; isRoot?: boolean }) {
  if (args.isRoot) return true;
  return (args.permissions ?? []).includes('report-agent.template.manage');
}

export function getAugmentedAdminMenuCatalog(args: {
  items?: AdminMenuItem[] | null;
  permissions?: string[] | null;
  isRoot?: boolean;
}): AdminMenuItem[] {
  const base = Array.isArray(args.items) ? [...args.items] : [];
  const merged = [...base];

  if (canUseWeeklyPoster(args) && !merged.some((item) => item.appKey === WEEKLY_POSTER_MENU_ITEM.appKey)) {
    merged.push(WEEKLY_POSTER_MENU_ITEM);
  }

  return merged.sort((a, b) => {
    const byOrder = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    if (byOrder !== 0) return byOrder;
    return a.label.localeCompare(b.label, 'zh-CN');
  });
}

/**
 * sidebar 不显示的 appKey 集合（唯一来源）。
 * AppShell 和 NavLayoutEditor 统一引用此常量，避免两份独立定义漂移。
 */
export const SIDEBAR_HIDDEN_APPKEYS = new Set<string>();

/**
 * 返回 sidebar 实际可见的 menuCatalog 条目（单一数据源），含 home 分组。
 * AppShell 的 allCatalogItems 使用此函数。
 */
export function getSidebarMenuItems(args: {
  items?: AdminMenuItem[] | null;
  permissions?: string[] | null;
  isRoot?: boolean;
}): AdminMenuItem[] {
  return getAugmentedAdminMenuCatalog(args).filter(
    (m) => !!m.group && !SIDEBAR_HIDDEN_APPKEYS.has(m.appKey),
  );
}

/**
 * 返回 sidebar 中「可自动追加」的候选条目（排除 home 分组）。
 * 镜像 AppShell 的 NON_HOME 过滤逻辑：home 条目由 AppShell 单独处理，
 * 不参与 navOrder 的 auto-append，NavLayoutEditor 孤立条目检测使用此函数。
 */
export function getSidebarAutoAppendItems(args: {
  items?: AdminMenuItem[] | null;
  permissions?: string[] | null;
  isRoot?: boolean;
}): AdminMenuItem[] {
  return getSidebarMenuItems(args).filter((m) => m.group !== 'home');
}
