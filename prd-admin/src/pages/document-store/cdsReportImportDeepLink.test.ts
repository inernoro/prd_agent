import { describe, expect, it } from 'vitest';
import { parseCdsReportImportDeepLink, withoutCdsReportImportDeepLink } from './cdsReportImportDeepLink';

describe('CDS report import deep link', () => {
  it('parses the selected report, project and trusted source hint', () => {
    expect(parseCdsReportImportDeepLink('?cdsReport=r-1&cdsProject=p-1&cdsSource=https%3A%2F%2Fcds.example.com')).toEqual({
      reportId: 'r-1',
      projectId: 'p-1',
      sourceBaseUrl: 'https://cds.example.com',
    });
  });

  it('removes one-time import parameters while preserving other page state', () => {
    expect(withoutCdsReportImportDeepLink('?tab=mine&cdsReport=r-1&cdsSource=x')).toBe('?tab=mine');
    expect(parseCdsReportImportDeepLink('?tab=mine')).toBeNull();
  });
});
