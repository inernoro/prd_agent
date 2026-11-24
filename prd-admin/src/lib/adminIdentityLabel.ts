type AdminIdentity = {
  role?: string | null;
  systemRoleKey?: string | null;
};

/** 同时表达系统管理身份和业务角色，避免把两套角色再次混为一谈。 */
export function resolveAdminIdentityLabel(user?: AdminIdentity | null, isRoot = false): string {
  const businessRole = String(user?.role || '').trim();
  const isSystemAdmin = isRoot || String(user?.systemRoleKey || '').trim().toLowerCase() === 'admin';

  if (!isSystemAdmin) return businessRole;
  if (!businessRole || businessRole === 'ADMIN') return '系统管理员';
  return `系统管理员 · ${businessRole}`;
}
