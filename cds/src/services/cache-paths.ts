import path from 'node:path';

const LEGACY_CACHE_BASE_RE = /\/data\/cds\/[^/]+\/cache/;

function sanitizeProjectSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'default';
}

/**
 * Resolve the host-side cache root for build profile mounts.
 *
 * Linux/server deployments keep the historical `/data/cds/<slug>/cache`
 * default. Local desktop environments cannot reliably create `/data`, so
 * they fall back to a writable directory inside the repo unless explicitly
 * overridden with CDS_CACHE_BASE.
 */
export function resolveCacheBase(projectSlug: string, repoRoot?: string): string {
  const slug = sanitizeProjectSlug(projectSlug);
  const configured = (process.env.CDS_CACHE_BASE || process.env.CACHE_BASE || '').trim();
  if (configured) {
    const templated = configured.replace(/\$\{projectSlug\}|\{projectSlug\}/g, slug);
    return path.isAbsolute(templated) ? templated : path.resolve(repoRoot || process.cwd(), templated);
  }
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return path.resolve(repoRoot || process.cwd(), '.cds-cache', slug);
  }
  return `/data/cds/${slug}/cache`;
}

export function normalizeCacheHostPath(hostPath: string, cacheBase: string): string {
  const absoluteHostPath = path.isAbsolute(hostPath)
    ? hostPath
    : path.join(cacheBase, hostPath);
  return absoluteHostPath.replace(LEGACY_CACHE_BASE_RE, cacheBase);
}
