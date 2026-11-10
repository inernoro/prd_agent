/** Public addresses only. Project authorizations are always local to each host. */
export interface CdsInstance {
  id: string;
  name: string;
  role: 'primary' | 'standby';
  url: string;
}

export interface InstanceCatalog {
  version: 1;
  instances: CdsInstance[];
}

export function parseInstanceCatalog(value: unknown): InstanceCatalog {
  const catalog = value as InstanceCatalog;
  if (!catalog || catalog.version !== 1 || !Array.isArray(catalog.instances) || catalog.instances.length > 20) {
    throw new Error('实例目录格式无效，请检查 cds-instances.json');
  }
  const ids = new Set<string>();
  const urls = new Set<string>();
  const instances = catalog.instances.map((entry): CdsInstance => {
    if (!entry || !/^[a-z][a-z0-9-]{0,39}$/.test(entry.id)
      || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 60
      || !['primary', 'standby'].includes(entry.role) || typeof entry.url !== 'string') {
      throw new Error('实例名称、标识或类型无效');
    }
    const url = new URL(entry.url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('实例地址必须为 HTTPS 站点根地址，不能包含凭据或页面路径');
    }
    if (ids.has(entry.id) || urls.has(url.origin)) throw new Error('实例标识或地址重复');
    ids.add(entry.id);
    urls.add(url.origin);
    // Explicit projection prevents credentials/unknown fields leaking to the browser.
    return { id: entry.id, name: entry.name.trim(), role: entry.role, url: url.origin };
  });
  return { version: 1, instances };
}

/** Always start at the target's project list; project and branch IDs are host-local. */
export function instanceConsoleUrl(instance: CdsInstance): string {
  return new URL('/project-list', instance.url).href;
}
