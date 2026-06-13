import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { mapDefectImportRows, parseDefectImportXlsxBuffer } from './defectImportParse';
import { ITEM_GRADE_LABEL } from './types';

describe('mapDefectImportRows', () => {
  const tapdHeaders = ['ID', '标题', '详细描述', '状态', '优先级', '严重程度'];

  it('maps 严重程度 and 优先级 independently', () => {
    const rows = mapDefectImportRows(tapdHeaders, [
      ['1023034', '登录失败', '偶发', 'new', '高', '紧急'],
      ['1023035', '文案错误', '说明', 'closed', '低', '无关紧要'],
    ]);
    expect(rows[0]).toMatchObject({
      externalId: '1023034',
      title: '登录失败',
      tapdSeverityRaw: '紧急',
      tapdPriorityRaw: '高',
      severity: '致命',
      grade: 'p1',
    });
    expect(rows[1]).toMatchObject({
      tapdSeverityRaw: '无关紧要',
      tapdPriorityRaw: '低',
      severity: '轻微',
      grade: 'p3',
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
      tapdPriorityRaw: '高',
      severity: '致命',
      grade: 'p1',
      sourceSystem: 'tapd',
    });
  });

  it('maps 优先级 only when 严重程度 is blank', () => {
    const rows = mapDefectImportRows(tapdHeaders, [
      ['1', '仅优先级高', 'desc', 'new', '高', ''],
      ['2', '仅优先级中', 'desc', 'new', '中', ''],
    ]);
    expect(rows[0]).toMatchObject({ tapdPriorityRaw: '高', grade: 'p1', severity: undefined, tapdSeverityRaw: undefined });
    expect(rows[1]).toMatchObject({ tapdPriorityRaw: '中', grade: 'p2', severity: undefined });
  });

  it('does not map 优先级 into severity when 严重程度 is blank', () => {
    const rows = mapDefectImportRows(tapdHeaders, [['1', 't', 'desc', 'new', '高', '']]);
    expect(rows[0].severity).toBeUndefined();
    expect(rows[0].grade).toBe('p1');
  });

  it('leaves both empty when columns are blank', () => {
    const rows = mapDefectImportRows(tapdHeaders, [['1', '无等级', 'desc', 'new', '', '']]);
    expect(rows[0].tapdSeverityRaw).toBeUndefined();
    expect(rows[0].tapdPriorityRaw).toBeUndefined();
    expect(rows[0].severity).toBeUndefined();
    expect(rows[0].grade).toBeUndefined();
  });

  it('maps all five TAPD severity options from 严重程度 only', () => {
    const opts = ['紧急', '高', '中', '低', '无关紧要'] as const;
    const expected = ['致命', '严重', '一般', '轻微', '轻微'] as const;
    opts.forEach((opt, i) => {
      const [row] = mapDefectImportRows(tapdHeaders, [['1', 't', '', 'new', '', opt]]);
      expect(row.severity).toBe(expected[i]);
      expect(row.grade).toBeUndefined();
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

describe('defect import preview labels', () => {
  it('exposes grade label for priority column', () => {
    expect(ITEM_GRADE_LABEL.p1).toBeTruthy();
  });
});
