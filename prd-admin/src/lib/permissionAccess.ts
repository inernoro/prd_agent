export function hasEffectivePermission(
  permissions: string[],
  required: string | string[],
  isRoot = false,
): boolean {
  if (isRoot || permissions.includes('super')) return true;
  const requiredPermissions = Array.isArray(required) ? required : [required];
  return requiredPermissions.some((permission) => permissions.includes(permission));
}
