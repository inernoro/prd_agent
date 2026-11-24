import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseProductImportCsv, parseProductImportXlsxBuffer } from './productImportParse';

describe('bundled product import templates', () => {
  it('offers the same 23 unique applications in CSV and Excel, including the latest additions', () => {
    const csvPath = fileURLToPath(new URL('../../../public/templates/product-import-initial-apps.csv', import.meta.url));
    const xlsxPath = fileURLToPath(new URL('../../../public/templates/product-import-initial-apps.xlsx', import.meta.url));
    const csvRows = parseProductImportCsv(readFileSync(csvPath, 'utf8'));
    const buffer = readFileSync(xlsxPath);
    const xlsxRows = parseProductImportXlsxBuffer(Uint8Array.from(buffer).buffer);

    expect(csvRows).toHaveLength(23);
    expect(xlsxRows).toEqual(csvRows);
    expect(new Set(csvRows.map((row) => row.name.toLowerCase())).size).toBe(23);
    expect(csvRows.every((row) => row.grade === '应用')).toBe(true);
    expect(csvRows.map((row) => row.name)).toEqual(expect.arrayContaining([
      '商户助手小程序', 'IMP助手', 'AI运营简报', 'BDE AI应用底座',
    ]));
    const dialog = readFileSync(fileURLToPath(new URL('./ProductImportDialog.tsx', import.meta.url)), 'utf8');
    expect(dialog).toContain(`一键加载初始模板（${csvRows.length} 个应用）`);
    expect(dialog).toContain("fetch(TEMPLATE_XLSX, { cache: 'no-store' })");
  });
});

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
