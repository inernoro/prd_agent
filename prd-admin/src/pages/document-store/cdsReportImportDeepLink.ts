export interface CdsReportImportDeepLink {
  reportId: string;
  projectId?: string;
  sourceBaseUrl: string;
}

export function parseCdsReportImportDeepLink(search: string): CdsReportImportDeepLink | null {
  const params = new URLSearchParams(search);
  const reportId = params.get('cdsReport')?.trim() ?? '';
  if (!reportId) return null;
  return {
    reportId,
    projectId: params.get('cdsProject')?.trim() || undefined,
    sourceBaseUrl: params.get('cdsSource')?.trim() ?? '',
  };
}

export function withoutCdsReportImportDeepLink(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('cdsReport');
  params.delete('cdsProject');
  params.delete('cdsSource');
  return params.toString() ? `?${params.toString()}` : '';
}
