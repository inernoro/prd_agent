import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { parseProductImportCsv, parseProductImportXlsxBuffer } from './productImportParse';

describe('parseProductImportCsv', () => {
  it('maps product name and grade columns', () => {
    const csv = '产品名称,产品类型,产品描述,产品标识\n互动营销,应用,说明,A1\n';
    expect(parseProductImportCsv(csv)).toEqual([
      { name: '互动营销', grade: '应用', description: '说明', code: 'A1' },
    ]);
  });

  it('skips empty name rows', () => {
    const csv = '产品名称,产品类型\n,应用\n智能营销,应用\n';
    expect(parseProductImportCsv(csv)).toEqual([{ name: '智能营销', grade: '应用' }]);
  });
});

describe('parseProductImportXlsxBuffer', () => {
  it('parses xlsx workbook buffer', () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['产品名称', '产品类型', '产品描述', '产品标识'],
      ['互动营销', '应用', '', ''],
      ['智能营销', '应用', '', ''],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, '产品导入');
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const rows = parseProductImportXlsxBuffer(buffer);
    expect(rows).toEqual([
      { name: '互动营销', grade: '应用', description: '', code: '' },
      { name: '智能营销', grade: '应用', description: '', code: '' },
    ]);
  });
});
