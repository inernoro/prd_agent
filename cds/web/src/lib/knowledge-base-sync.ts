export function buildMapReportImportUrl(input: {
  mapBaseUrl: string;
  reportId: string;
  projectId?: string | null;
  cdsSourceBaseUrl: string;
}): string {
  const target = new URL('/document-store', input.mapBaseUrl);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('不支持的 MAP 连接协议');
  target.searchParams.set('cdsReport', input.reportId);
  if (input.projectId) target.searchParams.set('cdsProject', input.projectId);
  target.searchParams.set('cdsSource', input.cdsSourceBaseUrl);
  return target.toString();
}
