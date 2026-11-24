export const DEFAULT_RELEASE_CENTER_PROJECT_ID = 'prd-agent';

export function releaseCenterHref(projectId?: string | null): string {
  const normalized = (projectId || '').trim();
  if (!normalized || normalized === DEFAULT_RELEASE_CENTER_PROJECT_ID) return '/release-center';
  return `/release-center?project=${encodeURIComponent(normalized)}`;
}
