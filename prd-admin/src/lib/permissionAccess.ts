export function hasEffectivePermission(
  permissions: string[],
  required: string | string[],
  isRoot = false,
): boolean {
  const requiredPermissions = Array.isArray(required) ? required : [required];
  if (isRoot) return true;
  return requiredPermissions.some((permission) => {
    if (permission.startsWith('product-agent.') && permissions.includes('product-agent.menu-scoped') && !permissions.includes('product-agent.map-admin'))
      return permissions.includes(permission);
    return permissions.includes('super') || permissions.includes(permission);
  });
}
