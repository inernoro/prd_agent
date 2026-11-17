/** 仅用于当前主体的浏览器状态隔离，不参与权限判断；mode是站点模式，不能代表当前主体。 */
export function consoleAccountIdentity(status: {
  enabled?: boolean; activeProvider?: string | null;
  user?: { id?: string | null; authProvider?: string | null; githubLogin?: string | null; username?: string | null } | null;
} | null): string | null {
  if (!status) return null;
  if (status.enabled === false) return JSON.stringify(['disabled-local']);
  const provider = status.user?.authProvider?.trim() || status.activeProvider?.trim();
  const id = status.user?.id?.trim();
  if (id) return JSON.stringify(['user-id', id]);
  const username = status.user?.username?.trim() || status.user?.githubLogin?.trim();
  return provider && username ? JSON.stringify(['legacy-user', provider, username]) : null;
}
