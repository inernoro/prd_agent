import { describe, expect, it } from 'vitest';
import { mapDefectImportRows } from './defectImportParse';
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
});