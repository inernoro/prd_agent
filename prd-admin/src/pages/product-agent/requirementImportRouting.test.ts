import { describe, expect, it } from 'vitest';
import {
  applyFallbackProductToRows,
  promoteRequirementCategoryToProductField,
  rowHasExplicitProductRouteField,
  rowHasProductRouteHint,
} from './requirementImportRouting';

describe('requirementImportRouting', () => {
  it('detects 应用 column and title bracket', () => {
    expect(rowHasExplicitProductRouteField({ sourceFields: { 应用: '产品管理系统' } })).toBe(true);
    expect(rowHasExplicitProductRouteField({ sourceFields: undefined })).toBe(false);
    expect(rowHasProductRouteHint({ title: '普通标题', sourceFields: { 应用: '产品管理系统' } })).toBe(true);
    expect(rowHasProductRouteHint({ title: '【CRM】需求甲', sourceFields: undefined })).toBe(true);
    expect(rowHasProductRouteHint({ title: '无路由信息', sourceFields: undefined })).toBe(false);
  });

  it('injects fallback product name when row lacks route hint', () => {
    const rows = applyFallbackProductToRows([
      { title: '需求甲', grade: 'p1' },
      { title: '【客户名】需求乙', grade: 'p2' },
      { title: '已有产品列需求', grade: 'p2', sourceFields: { 应用: 'CRM' } },
    ], '产品管理系统');
    expect(rows[0].sourceFields?.['应用']).toBe('产品管理系统');
    expect(rows[1].sourceFields?.['应用']).toBe('产品管理系统');
    expect(rows[2].sourceFields?.['应用']).toBe('CRM');
  });

  it('promotes requirement 分类 to product route field', () => {
    const fields = promoteRequirementCategoryToProductField({
      ID: '1007159',
      分类: '防窜物流',
      状态: '待评审',
    });
    expect(fields?.应用).toBe('防窜物流');
    expect(fields?.分类).toBe('防窜物流');
    expect(rowHasExplicitProductRouteField({ sourceFields: fields })).toBe(true);
  });

  it('keeps explicit product route ahead of 分类', () => {
    const fields = promoteRequirementCategoryToProductField({
      应用: '智能营销',
      分类: '防窜物流',
    });
    expect(fields?.应用).toBe('智能营销');
  });
});
