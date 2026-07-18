export const DEFAULT_RELEASE_CENTER_PROJECT_ID = 'prd-agent';
export const DEFAULT_RELEASE_HEALTH_PATH = '/api/health';

const LAST_RELEASE_CENTER_PROJECT_KEY = 'cds:lastReleaseCenterProjectId';

export function releaseCenterHref(projectId?: string | null): string {
  const normalized = (projectId || '').trim();
  if (!normalized || normalized === DEFAULT_RELEASE_CENTER_PROJECT_ID) return '/release-center';
  return `/release-center?project=${encodeURIComponent(normalized)}`;
}

export function initialReleaseCenterProject(searchParams: URLSearchParams, storage?: Storage): string {
  const queryProject = searchParams.get('project')?.trim();
  if (queryProject) return queryProject;

  try {
    const remembered = storage?.getItem(LAST_RELEASE_CENTER_PROJECT_KEY)?.trim();
    if (remembered) return remembered;
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }

  return DEFAULT_RELEASE_CENTER_PROJECT_ID;
}

export function rememberReleaseCenterProject(projectId: string, storage?: Storage): void {
  const normalized = projectId.trim();
  if (!normalized) return;
  try {
    storage?.setItem(LAST_RELEASE_CENTER_PROJECT_KEY, normalized);
  } catch {
    // Storage persistence is best-effort only.
  }
}

export function normalizeProductionOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return `${url.protocol}//${url.host}`;
  } catch {
    return candidate.replace(/\/+$/, '');
  }
}

export function buildReleaseHealthcheckUrl(
  publicUrl: string,
  healthPath: string,
  explicitHealthcheckUrl = '',
): string {
  if (explicitHealthcheckUrl.trim()) return explicitHealthcheckUrl.trim();
  const origin = normalizeProductionOrigin(publicUrl);
  if (!origin) return '';
  const path = healthPath.trim() || DEFAULT_RELEASE_HEALTH_PATH;
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}
