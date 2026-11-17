/** Public discovery only; trust is established by the authenticated authority. */
export interface CdsInstance {
  id: string;
  name: string;
  role: 'primary' | 'standby';
  url: string;
}

export interface InstanceCatalog {
  version: 1;
  instances: CdsInstance[];
  cluster?: { id: string; authorityId: string };
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
  const cluster = catalog.cluster;
  if (cluster && (!/^[a-zA-Z0-9_.-]{1,80}$/.test(cluster.id)
    || !instances.some(instance => instance.id === cluster.authorityId && instance.role === 'primary'))) {
    throw new Error('集群目录无效，请核对主节点登记');
  }
  return { version: 1, instances, ...(cluster ? { cluster: { id: cluster.id, authorityId: cluster.authorityId } } : {}) };
}

/** Always start at the target's project list; project and branch IDs are host-local. */
export function instanceConsoleUrl(instance: CdsInstance): string {
  return new URL('/project-list', instance.url).href;
}
