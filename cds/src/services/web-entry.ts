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

/** A profile routed at `/` is the natural main Web application. */
export function handlesRootPath(profile: Pick<BuildProfile, 'pathPrefixes'>): boolean {
  return profile.pathPrefixes?.some((path) => path.trim() === '/') === true;
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
  const hasDeclaration = name !== '' || rawPath !== undefined || rawPrimary !== '';
  if (!hasDeclaration || !name) return undefined;
  const path = normalizeWebEntryPath(rawPath);
  if (!path) return undefined;
  return {
    name,
    path,
    ...(rawPrimary === 'true' || rawPrimary === '1' ? { primary: true } : {}),
  };
}
