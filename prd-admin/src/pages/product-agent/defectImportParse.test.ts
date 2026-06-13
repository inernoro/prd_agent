import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { mapDefectImportRows, parseDefectImportXlsxBuffer } from './defectImportParse';
describe('mapDefectImportRows', () => {
  const tapdHeaders = ['ID', '标题', '详细描述', '状态', '优先级', '严重程度'];

  it('reads 严重程度 column only, not 优先级', () => {
    const rows = mapDefectImportRows(tapdHeaders, [
      ['1023034', '登录失败', '偶发', 'new', '高', '紧急'],
      ['1023035', '文案错误', '说明', 'closed', '低', '无关紧要'],
    ]);
    expect(rows[0]).toMatchObject({
      externalId: '1023034',
      title: '登录失败',
      tapdSeverityRaw: '紧急',
      severity: '致命',
    });
    expect(rows[1]).toMatchObject({
      tapdSeverityRaw: '无关紧要',
      severity: '轻微',
    });
  });

  it('preserves TAPD Chinese status labels', () => {
    const rows = mapDefectImportRows(tapdHeaders, [['1023034', '标题', 'desc', '已解决', '高', '紧急']]);
    expect(rows[0].status).toBe('已解决');
    expect(rows[0].externalId).toBe('1023034');
  });

  it('parses TAPD xlsx export buffer', () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      tapdHeaders,
      ['1023034', '3+2 门店问题', '详细描述', '已解决', '高', '紧急'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, '缺陷');
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const rows = parseDefectImportXlsxBuffer(buffer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: '1023034',
      title: '3+2 门店问题',
      status: '已解决',
      tapdSeverityRaw: '紧急',
      severity: '致命',
      sourceSystem: 'tapd',
    });
  });

  it('leaves severity empty when 严重程度 column is blank', () => {
    const rows = mapDefectImportRows(tapdHeaders, [['1', '无等级', 'desc', 'new', '高', '']]);
    expect(rows[0].tapdSeverityRaw).toBe('');
    expect(rows[0].severity).toBeUndefined();
  });

  it('maps all five TAPD severity options', () => {
    const opts = ['紧急', '高', '中', '低', '无关紧要'] as const;
    const expected = ['致命', '严重', '一般', '轻微', '轻微'] as const;
    opts.forEach((opt, i) => {
      const [row] = mapDefectImportRows(tapdHeaders, [['1', 't', '', 'new', '', opt]]);
      expect(row.severity).toBe(expected[i]);
    });
  });

  it('reads 处理人 and 创建人 columns', () => {
    const headers = [...tapdHeaders, '处理人', '创建人'];
    const rows = mapDefectImportRows(headers, [
      ['1023034', '登录失败', '偶发', 'new', '高', '紧急', '伍林波;', '陈嘉颖'],
    ]);
    expect(rows[0].handlerNames).toEqual(['伍林波']);
    expect(rows[0].reporterNames).toEqual(['陈嘉颖']);
  });
});