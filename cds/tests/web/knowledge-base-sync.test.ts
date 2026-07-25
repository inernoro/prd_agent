import { describe, expect, it } from 'vitest';
import { buildMapReportImportUrl } from '../../web/src/lib/knowledge-base-sync.js';

describe('buildMapReportImportUrl', () => {
  it('builds an exact report import deep link for MAP', () => {
    const url = new URL(buildMapReportImportUrl({
      mapBaseUrl: 'https://map.example.com/base',
      reportId: 'report-1',
      projectId: 'project-1',
      cdsSourceBaseUrl: 'https://cds.example.com',
    }));
    expect(url.pathname).toBe('/document-store');
    expect(url.searchParams.get('cdsReport')).toBe('report-1');
    expect(url.searchParams.get('cdsProject')).toBe('project-1');
    expect(url.searchParams.get('cdsSource')).toBe('https://cds.example.com');
  });

  it('rejects non-http knowledge base connections', () => {
    expect(() => buildMapReportImportUrl({
      mapBaseUrl: 'file:///tmp/map',
      reportId: 'report-1',
      cdsSourceBaseUrl: 'https://cds.example.com',
    })).toThrow('不支持');
  });
});
