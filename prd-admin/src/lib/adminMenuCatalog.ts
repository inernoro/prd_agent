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
