/** Only event identity belongs in links; readings are resolved from the scoped incident API. */
export function monitorIncidentPath(targetId?: string, incidentId?: string, detectedAt?: string): string {
  if (!targetId) return '/status';
  if (!incidentId) return `/status?target=${encodeURIComponent(targetId)}`;
  const params = new URLSearchParams({ view: 'home', target: targetId, incident: incidentId });
  if (detectedAt && Number.isFinite(Date.parse(detectedAt))) params.set('detectedAt', new Date(detectedAt).toISOString());
  return `/status?${params}`;
}

/** Resolve a report beside the monitor board, preserving any configured base prefix. */
export function monitorReportUrl(boardUrl: string, reportId: string): string {
  const url = new URL('reports', boardUrl);
  url.search = new URLSearchParams({ report: reportId }).toString();
  url.hash = '';
  return url.toString();
}
