import type { AdminUserAuthzSnapshot, UpdateUserAuthzRequest } from '@/services/contracts/authz';

export type PermissionOverride = 'inherit' | 'allow' | 'deny';

export function permissionOverride(snapshot: AdminUserAuthzSnapshot, key: string): PermissionOverride {
  if (snapshot.permDeny.includes(key)) return 'deny';
  return snapshot.permAllow.includes(key) ? 'allow' : 'inherit';
}

/** 只替换用户明确编辑的权限；角色和其他应用的例外按最新快照保留。 */
export function mergePermissionOverrides(
  latest: AdminUserAuthzSnapshot,
  changes: Record<string, PermissionOverride>,
): UpdateUserAuthzRequest {
  const allow = new Set(latest.permAllow);
  const deny = new Set(latest.permDeny);
  for (const [key, mode] of Object.entries(changes)) {
    allow.delete(key);
    deny.delete(key);
    if (mode === 'allow') allow.add(key);
    if (mode === 'deny') deny.add(key);
  }
  return { systemRoleKey: latest.systemRoleKey, permAllow: [...allow].sort(), permDeny: [...deny].sort() };
}

export function mergeScopedRolePermissions(current: string[], scope: string[], selected: string[]): string[] {
  const scoped = new Set(scope);
  return [...new Set([...current.filter((key) => !scoped.has(key)), ...selected.filter((key) => scoped.has(key))])].sort();
}
