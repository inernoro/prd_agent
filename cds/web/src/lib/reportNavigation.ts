const MESSAGE_TYPE = 'cds:authenticated-report-navigation';
const REPORT_ID = /^[a-f0-9]{32}$/;

/** Only same-origin, same-project report links are candidates for parent navigation. */
export function linkedReportId(href: string, origin: string, projectId: string, projectSlug?: string | null): string | null {
  if (!projectId || href.startsWith('#')) return null;
  let url: URL;
  try { url = new URL(href, origin); } catch { return null; }
  if (url.origin !== origin || url.pathname !== '/reports' || url.username || url.password || url.hash) return null;
  if ([...url.searchParams.keys()].some((key) => !['project', 'folder', 'report'].includes(key))) return null;
  for (const key of ['project', 'folder', 'report']) if (url.searchParams.getAll(key).length > 1) return null;
  const linkedProject = url.searchParams.get('project');
  if (linkedProject !== projectId && (!projectSlug || linkedProject !== projectSlug)) return null;
  const id = url.searchParams.get('report') || '';
  return /^[a-f0-9]{32}$/.test(id) ? id : null;
}

/** An opaque srcDoc frame cannot impersonate a different report frame. */
export function reportNavigationMessage(
  event: { source: unknown; origin: string; data: unknown }, frameWindow: unknown,
): string | null {
  if (!frameWindow || event.source !== frameWindow || event.origin !== 'null') return null;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return null;
  const data = event.data as Record<string, unknown>;
  return data.type === MESSAGE_TYPE && typeof data.reportId === 'string' && REPORT_ID.test(data.reportId)
    ? data.reportId : null;
}

/** The authenticated list is the allowlist; navigation never fetches an arbitrary ID. */
export function listedReportTarget<T extends { id: string; projectId?: string | null }>(
  projectId: string | null | undefined, reportId: string, reports: T[],
): T | undefined {
  if (!projectId || !REPORT_ID.test(reportId)) return undefined;
  return reports.find((report) => report.id === reportId && report.projectId === projectId);
}

/** Generated from the same URL parser tested below; no credentials enter the frame. */
export function reportNavigationScript(origin: string, projectId: string, projectSlug?: string | null): string {
  const config = JSON.stringify({ origin, projectId, projectSlug, type: MESSAGE_TYPE }).replace(/</g, '\\u003c');
  return `(() => {
    const config = ${config};
    const parseLink = ${linkedReportId.toString()};
    document.addEventListener('click', (event) => {
      if (!event.isTrusted || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.target?.closest?.('a[href]');
      if (!link) return;
      const reportId = parseLink(link.getAttribute('href') || '', config.origin, config.projectId, config.projectSlug);
      if (!reportId) return;
      event.preventDefault();
      event.stopPropagation();
      window.parent.postMessage({ type: config.type, reportId }, config.origin);
    }, true);
  })();`;
}

/** Keep the opaque-origin sandbox and the stored immutable report body unchanged. */
export function withReportNavigation(raw: string, origin: string, projectId?: string | null, projectSlug?: string | null): string {
  if (!projectId) return raw;
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const script = doc.createElement('script');
  script.textContent = reportNavigationScript(origin, projectId, projectSlug);
  doc.head.prepend(script);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}
