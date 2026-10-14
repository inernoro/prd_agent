/** 建项目审批绑定仓库身份：保留主机，GitHub HTTPS/SSH 为同一仓库。 */
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
      if (url.port && !(url.protocol === 'ssh:' && url.port === '22')) return null;
      host = url.hostname.toLowerCase();
      pathname = url.pathname;
    } catch { return null; }
  }
  pathname = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host.includes('.') || !pathname || /[%\\\s]/.test(pathname)
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
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100) return null;
  const repository = bootstrapRepository(input.repository);
  return repository ? { name: input.name.trim(), repository } : null;
}
