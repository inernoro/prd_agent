export const PRODUCT_MAP_ADMIN = 'product-agent.map-admin';
export const PRODUCT_MENU_KEYS = ['dashboard', 'products', 'requirements', 'review', 'features', 'defects', 'versions', 'customers', 'knowledge', 'graph', 'settings'] as const;

export function hasProductReviewPermission(permissions: string[], permission: string): boolean {
  return permissions.includes(PRODUCT_MAP_ADMIN) || permissions.includes('super') || permissions.includes(permission);
}
