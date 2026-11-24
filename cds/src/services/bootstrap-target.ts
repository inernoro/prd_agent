/** 建项目审批绑定仓库身份：保留主机，GitHub HTTPS/SSH 为同一仓库。 */
export const MAX_PROJECT_NAME_LENGTH = 60;

export function bootstrapRepository(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const scp = /^git@([a-zA-Z0-9.-]+):([^\s?#]+)$/.exec(raw);
  let host: string;
  let pathname: string;
  if (scp) {
    host = scp[1].toLowerCase();
    pathname = scp[2];
  } else {
    try {
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) return null;
      host = url.hostname.toLowerCase();
      // 自建 Git 服务可使用内网主机和非默认端口；不同端口不能共用授权。
      const storedPort = !raw.includes('://') ? /^[^/?#]+:(\d+)(?:\/|$)/.exec(raw)?.[1] : undefined;
      const port = storedPort ? String(Number(storedPort)) : url.protocol === 'ssh:' && url.port === '22' ? '' : url.port;
      if (port) host += `:${port}`;
      pathname = url.pathname;
    } catch { return null; }
  }
  pathname = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host || !pathname || /[%\\\s]/.test(pathname)
    || pathname.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return null;
  if (host === 'github.com') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(pathname)) return null;
    pathname = pathname.toLowerCase();
  }
  return `${host}/${pathname}`;
}

export function bootstrapTarget(value: unknown): { name: string; repository: string } | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as { name?: unknown; repository?: unknown };
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > MAX_PROJECT_NAME_LENGTH) return null;
  const repository = bootstrapRepository(input.repository);
  // 保持原审批盒的500字符界线；授权目标须完整，不能截断后批准另一个仓库。
  return repository && repository.length <= 500 ? { name: input.name.trim(), repository } : null;
}
