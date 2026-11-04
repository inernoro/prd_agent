export const PRODUCT_MENU_PREFIX = 'product-agent.menu.';
export const PRODUCT_MENU_SCOPED = 'product-agent.menu-scoped';
export const PRODUCT_MAP_ADMIN = 'product-agent.map-admin';
export const PRODUCT_MENU_KEYS = ['dashboard', 'products', 'requirements', 'review', 'features', 'defects', 'versions', 'customers', 'knowledge', 'graph', 'settings'] as const;
export type ProductMenuKey = typeof PRODUCT_MENU_KEYS[number];

export function hasProductMenu(permissions: string[], menu: string, isRoot = false): boolean {
  if (isRoot || permissions.includes(PRODUCT_MAP_ADMIN)) return true;
  if (permissions.includes(PRODUCT_MENU_SCOPED)) return permissions.includes(PRODUCT_MENU_PREFIX + menu);
  if (menu === 'review' && !permissions.includes('review-agent.use') && !permissions.includes('super')) return false;
  return permissions.includes('super') || permissions.includes('product-agent.use') || (menu === 'versions' && permissions.includes('product-agent.version-apply'));
}

const REVIEW_PERMISSION_MAP: Record<string, string> = {
  'review-agent.view-all': 'product-agent.review-view-all',
  'review-agent.manage': 'product-agent.review-manage',
  'review-agent.appeal-review': 'product-agent.review-appeal-review',
};
export function hasProductReviewPermission(permissions: string[], permission: string): boolean {
  if (permissions.includes(PRODUCT_MAP_ADMIN)) return true;
  if (!permissions.includes(PRODUCT_MENU_SCOPED)) return permissions.includes('super') || permissions.includes(permission);
  if (permission === 'review-agent.use') return hasProductMenu(permissions, 'review') || hasProductMenu(permissions, 'requirements');
  return permissions.includes(REVIEW_PERMISSION_MAP[permission] ?? '');
}

const RESOURCE_MENU: Record<string, ProductMenuKey> = {
  requirement: 'requirements', requirements: 'requirements', initiation: 'versions', initiations: 'versions', release: 'versions', releases: 'versions',
  version: 'versions', versions: 'versions', feature: 'features', features: 'features', defect: 'defects', defects: 'defects',
  customer: 'customers', customers: 'customers', knowledge: 'knowledge', graph: 'graph', product: 'products', products: 'products',
  overview: 'products', blueprint: 'products', reports: 'dashboard', board: 'features', rtm: 'features', team: 'products',
};
export function productRouteMenu(pathname: string, search: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  const query = new URLSearchParams(search);
  if (parts.length === 1) return query.get('section');
  if (parts[1] === 'review') return 'review';
  if (parts[1] === 'requirements') return 'requirements';
  if (parts[1] === 'p') return RESOURCE_MENU[parts[3] ?? query.get('tab') ?? 'product'] ?? 'unknown';
  if (parts[1] === 'objects') return RESOURCE_MENU[parts[2]] ?? 'unknown';
  return 'unknown';
}
