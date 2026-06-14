import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { parseFeatureTreeImportCsv, parseFeatureTreeImportXlsxBuffer } from './featureImportParse';

describe('parseFeatureTreeImportCsv', () => {
  it('maps path and optional columns', () => {
    const csv = '目录路径,功能名称,等级,功能类型,所属模块\n营销活动/优惠券,优惠券,p2,core,营销\n';
    expect(parseFeatureTreeImportCsv(csv)).toEqual([
      {
        path: '营销活动/优惠券',
        title: '优惠券',
        grade: 'p2',
        featureType: 'core',
        moduleName: '营销',
      },
    ]);
  });

  it('defaults title from last path segment', () => {
    const csv = '目录路径\n营销活动/满减\n';
    expect(parseFeatureTreeImportCsv(csv)[0].title).toBe('满减');
  });

  it('skips empty path rows', () => {
    const csv = '目录路径,功能名称\n,空行\n营销活动,营销\n';
    expect(parseFeatureTreeImportCsv(csv)).toHaveLength(1);
  });
});

describe('parseFeatureTreeImportXlsxBuffer', () => {
  it('parses xlsx workbook buffer', () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['目录路径', '功能名称', '等级'],
      ['根/子', '子节点', 'p1'],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, '功能目录');
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    expect(parseFeatureTreeImportXlsxBuffer(buffer)).toEqual([
      { path: '根/子', title: '子节点', grade: 'p1' },
    ]);
  });
});
