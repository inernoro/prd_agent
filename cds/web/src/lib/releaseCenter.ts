export const DEFAULT_RELEASE_CENTER_PROJECT_ID = 'prd-agent';

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
