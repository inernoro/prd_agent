/**
 * 分支预览地址的**唯一推导源**。
 *
 * 为什么单独一个模块：发布必须带 previewUrl（ReleaseService 的预检把
 * 「可发布产物」判成 blocking fail 就是因为它缺席），而这套 host/slug/端口
 * 推导此前只写在 BranchListPage 里。发布中心要就地发布，照抄一份就等于
 * 判据分裂——两处一旦漂移，同一个分支在两个入口会算出两个不同的预览地址，
 * 而且编译和测试都不会红（predicate-and-wiring-discipline 形状 3）。
 *
 * 注意：这里只做**字符串推导**，不判断该地址是否真的可达；可达性由发布前检查负责。
 */

export interface PreviewUrlConfig {
  workerPort?: number;
  mainDomain?: string;
  previewDomain?: string;
  rootDomains?: string[];
}

/** 推导只需要分支的这两个字段，不把整个 BranchSummary 形状焊进来。 */
export interface PreviewUrlBranchLike {
  id: string;
  previewSlug?: string;
}

export type PreviewMode = 'simple' | 'port' | 'multi';

/** 协议来源。默认取浏览器；单测传死值，避免依赖 window。 */
export interface PreviewUrlOrigin {
  protocol: string;
  hostname: string;
}

function currentOrigin(): PreviewUrlOrigin {
  if (typeof window === 'undefined') return { protocol: 'https:', hostname: 'localhost' };
  return { protocol: window.location.protocol, hostname: window.location.hostname };
}

export function cleanHost(host?: string): string {
  if (!host) return '';
  return host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
}

export function isLocalHost(host: string): boolean {
  const clean = host.split(':')[0];
  return clean === 'localhost' || clean.endsWith('.localhost') || clean === '127.0.0.1' || clean === '::1';
}

/**
 * 只有本机域名才补端口：线上域名走 80/443 反代，补上端口反而是个打不开的地址。
 */
export function hostWithPort(host: string, port?: number): string {
  if (!port || host.includes(':')) return host;
  if (!isLocalHost(host)) return host;
  return `${host}:${port}`;
}

export function multiPreviewUrl(
  branch: PreviewUrlBranchLike,
  config: PreviewUrlConfig,
  origin: PreviewUrlOrigin = currentOrigin(),
): string {
  const host = cleanHost(config.previewDomain || config.rootDomains?.[0]);
  if (!host) return '';
  const slug = branch.previewSlug || branch.id;
  return `${origin.protocol}//${slug}.${hostWithPort(host, config.workerPort || 5500)}`;
}

export function simplePreviewUrl(
  config: PreviewUrlConfig,
  origin: PreviewUrlOrigin = currentOrigin(),
): string {
  const configured = cleanHost(config.mainDomain);
  if (configured) {
    return `${origin.protocol}//${hostWithPort(configured, config.workerPort || 5500)}`;
  }
  const port = config.workerPort || 5500;
  return `${origin.protocol}//${origin.hostname}:${port}`;
}

/**
 * 按预览模式挑一条。`port` 模式的地址由 `/api/branches/:id/preview-port` 现取，
 * 不在这里凭空算：那是运行期分配的端口，算出来的值可能压根没监听。
 * 推导不出来时返回空串——调用方应把空串原样交给发布前检查，
 * 由它给出「可发布产物：缺少预览地址」这个标准结论，而不是自己造一个错误。
 */
export function resolvePreviewUrl(
  mode: PreviewMode | undefined,
  branch: PreviewUrlBranchLike,
  config: PreviewUrlConfig,
  origin: PreviewUrlOrigin = currentOrigin(),
): string {
  if (mode === 'simple') return simplePreviewUrl(config, origin);
  return multiPreviewUrl(branch, config, origin);
}
