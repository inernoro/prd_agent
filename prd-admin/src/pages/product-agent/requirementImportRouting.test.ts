import { describe, expect, it } from 'vitest';
import { applyFallbackProductToRows, rowHasProductRouteHint } from './requirementImportRouting';

describe('requirementImportRouting', () => {
  it('detects 应用 column and title bracket', () => {
    expect(rowHasProductRouteHint({ title: '普通标题', sourceFields: { 应用: '产品管理系统' } })).toBe(true);
    expect(rowHasProductRouteHint({ title: '【CRM】需求甲', sourceFields: undefined })).toBe(true);
    expect(rowHasProductRouteHint({ title: '无路由信息', sourceFields: undefined })).toBe(false);
  });

  it('detects TAPD 分类 column as product route hint', () => {
    expect(rowHasProductRouteHint({ title: '【石漫】筹货分析', sourceFields: { 分类: '防窜物流' } })).toBe(true);
    expect(rowHasProductRouteHint({ title: '普通标题', sourceFields: { 类别: '智能营销' } })).toBe(true);
  });

  it('injects fallback product name when row lacks route hint', () => {
    const rows = applyFallbackProductToRows([
      { title: '需求甲', grade: 'p1' },
      { title: '【已有】需求乙', grade: 'p2', sourceFields: { 应用: 'CRM' } },
    ], '产品管理系统');
    expect(rows[0].sourceFields?.['应用']).toBe('产品管理系统');
    expect(rows[1].sourceFields?.['应用']).toBe('CRM');
  });
});
