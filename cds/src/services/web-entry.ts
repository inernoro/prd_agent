import type { BuildProfile, WebEntryConfig } from '../types.js';

const OPERATIONAL_PROBE_SEGMENT_RE = /(?:^|\/)(?:health|healthz|health-check|ready|readyz|readiness|live|livez|liveness)(?:\/|$)/i;

/**
 * Normalize a same-origin browser path. Absolute URLs and operational probe
 * endpoints are rejected so readiness metadata cannot leak into the user-facing
 * entry list again.
 */
export function normalizeWebEntryPath(raw: string | undefined): string | null {
  const value = (raw || '/').trim();
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  let pathname = value;
  try {
    pathname = new URL(value, 'https://cds.invalid').pathname;
  } catch {
    return null;
  }
  if (OPERATIONAL_PROBE_SEGMENT_RE.test(pathname)) return null;
  return value;
}

/**
 * 该 profile 到底有没有一个「给人看的入口」，以及规范化后的名称/路径。
 *
 * 判据与 `parseWebEntryLabels` 同源：**名称是入口存在的唯一凭据**，路径必须是
 * 合法的同源浏览器路径（探针路径不算）。分支手动配置要能「本分支取消这个入口」，
 * 写入的就是空名——所以这条判据必须由入口表和发布侧共用一份，不能各写各的
 * （predicate-and-wiring-discipline 形状 3）。
 */
export function resolveWebEntry(
  profile: Pick<BuildProfile, 'webEntry'>,
): WebEntryConfig | null {
  const config = profile.webEntry;
  if (!config) return null;
  const name = (config.name || '').trim();
  if (!name) return null;
  const path = normalizeWebEntryPath(config.path);
  if (!path) return null;
  return { ...config, name, path };
}

/** A profile routed at `/` is the natural main Web application. */
export function handlesRootPath(profile: Pick<BuildProfile, 'pathPrefixes'>): boolean {
  return profile.pathPrefixes?.some((path) => path.trim() === '/') === true;
}

/**
 * 主域名下该 profile 的落地路径。
 *
 * 入口路径（`cds.web-entry-path`）是**该服务自己的**页面路径；服务挂在主域名的
 * 哪个前缀下（`cds.path-prefix`）是路由拓扑。挂在 `/open/` 的服务写 `path: "/"`，
 * 指的是它自己的首页，落到主域名上必须是 `/open/`——直接用 `/` 会落到承载根路径
 * 的另一个应用上（2026-08-06 review P2-1：显式 primary 反而给出错误 URL）。
 *
 * 已经带上自己前缀的路径（`/open/settings`）原样返回，不重复拼。
 */
export function mainDomainEntryPath(
  profile: Pick<BuildProfile, 'pathPrefixes'>,
  entryPath: string,
): string {
  if (handlesRootPath(profile)) return entryPath;
  const prefix = (profile.pathPrefixes || [])
    .map((value) => value.trim())
    .find((value) => value !== '' && value !== '/');
  if (!prefix) return entryPath;
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (base === '') return entryPath;
  if (entryPath === '/') return `${base}/`;
  if (entryPath === base || entryPath.startsWith(`${base}/`) || entryPath.startsWith(`${base}?`)) {
    return entryPath;
  }
  return `${base}${entryPath}`;
}

/**
 * Select one primary entry deterministically. An explicit declaration wins;
 * otherwise the root-routed Web profile is inferred. This is what prevents the
 * same service from appearing once as the main URL and again as a named URL.
 */
export function selectPrimaryWebEntry<T extends Pick<BuildProfile, 'id' | 'pathPrefixes' | 'webEntry'>>(
  profiles: readonly T[],
): T | undefined {
  const ordered = [...profiles]
    .filter((profile) => profile.webEntry)
    .sort((left, right) => left.id.localeCompare(right.id));
  return ordered.find((profile) => profile.webEntry?.primary)
    || ordered.find(handlesRootPath);
}

export function parseWebEntryLabels(
  labels: Readonly<Record<string, string>>,
): WebEntryConfig | undefined {
  const name = (labels['cds.web-entry-name'] || '').trim();
  const rawPath = labels['cds.web-entry-path'];
  const rawPrimary = (labels['cds.web-entry-primary'] || '').trim().toLowerCase();
  // 名称是入口存在的唯一凭据：没名字就不是给人看的入口，无论 path / primary 写没写。
  if (!name) return undefined;
  const path = normalizeWebEntryPath(rawPath);
  if (!path) return undefined;
  return {
    name,
    path,
    ...(rawPrimary === 'true' || rawPrimary === '1' ? { primary: true } : {}),
  };
}
