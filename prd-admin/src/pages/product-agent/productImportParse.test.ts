import { describe, expect, it } from 'vitest';
import { parseProductImportCsv } from './productImportParse';

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
