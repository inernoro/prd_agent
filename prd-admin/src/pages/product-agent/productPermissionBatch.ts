import type { AdminUser, PagedResult } from '@/types/admin';
import type { AdminUserAuthzSnapshot } from '@/services/contracts/authz';

/** 完整分页成功才返回；不能把首批或中途失败的目录叫作“所有人”。 */
export async function loadAllPermissionUsers(
  fetchPage: (page: number, pageSize: number) => Promise<PagedResult<AdminUser>>,
  isCurrent: () => boolean,
  onProgress: (loaded: number, total: number) => void,
): Promise<AdminUser[]> {
  const users = new Map<string, AdminUser>();
  let received = 0;
  for (let page = 1; isCurrent(); page += 1) {
    const result = await fetchPage(page, 100);
    if (!isCurrent()) return [];
    const previousSize = users.size;
    result.items.forEach((user) => users.set(user.userId, user));
    received += result.items.length;
    onProgress(users.size, result.total);
    if (received >= result.total) {
      if (users.size < result.total) throw new Error('人员目录在读取时发生变化，请重新加载后再全选。');
      return [...users.values()];
    }
    if (result.items.length === 0 || users.size === previousSize) throw new Error('人员目录在读取时发生变化，请重新加载后再全选。');
  }
  return [];
}

export function hasUnrestrictedPermissions(snapshot: AdminUserAuthzSnapshot, rolePermissions: string[]): boolean {
  return !snapshot.permDeny.includes('super') && (rolePermissions.includes('super') || snapshot.permAllow.includes('super'));
}

/** 显示现有授权结果；继承角色不要求用户再选择一种操作模式。 */
export function permissionCheckboxValue(snapshot: AdminUserAuthzSnapshot, rolePermissions: string[], key: string): boolean {
  return hasUnrestrictedPermissions(snapshot, rolePermissions) ||
    (!snapshot.permDeny.includes(key) && (rolePermissions.includes(key) || snapshot.permAllow.includes(key)));
}

/** 检查原始允许/禁止两侧，避免隐藏的双重例外变化被模式归一化掩盖。 */
export function hasPermissionEditConflict(
  baseline: AdminUserAuthzSnapshot,
  latest: AdminUserAuthzSnapshot,
  keys: string[],
): boolean {
  return baseline.effectiveSystemRoleKey !== latest.effectiveSystemRoleKey ||
    keys.some((key) => baseline.permAllow.includes(key) !== latest.permAllow.includes(key) ||
      baseline.permDeny.includes(key) !== latest.permDeny.includes(key));
}
