import { describe, expect, it } from 'vitest';
import { buildInitiationBasicInfoRows, buildReleaseBasicInfoRows } from './versionBasicInfoCatalog';
import type { ProductInitiation, ProductRelease } from './types';

const releaseBase: ProductRelease = {
  id: 'r1',
  productId: 'p1',
  vCode: 'V1.0.0',
  tCode: 'T1.0.0',
  isTemporaryOptimization: false,
  projectType: 'standard',
  planName: '方案 A',
  versionType: 'minor',
  openBrandScope: '全域',
  requirementIds: [],
  teamMemberIds: [],
  status: 'released',
  createdBy: 'u1',
  sourceType: 'import',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  systemName: '大数据引擎系统',
  appName: '互动营销',
  departmentName: '品牌域产品部',
  legacyData: { 产品负责人: '何丹铃', 合同签订方: '某客户', 备注: '测试备注' },
  plannedReleaseAt: '2021-09-16T00:00:00.000Z',
};

const initiationBase: ProductInitiation = {
  id: 'i1',
  productId: 'p1',
  tCode: 'T3.6.1',
  projectType: 'standard',
  planName: '互动营销 T3.6.1',
  versionType: 'minor',
  requirementIds: [],
  status: 'approved',
  developmentStatus: '已上线',
  createdBy: 'u1',
  sourceType: 'import',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  systemName: '大数据引擎系统',
  appName: '互动营销',
  requirementDescription: '需求描述正文',
  legacyData: { 产品负责人: '何丹铃' },
};

describe('versionBasicInfoCatalog', () => {
  it('正式版本基础信息固定 15 行（对齐上线语雀列）', () => {
    const rows = buildReleaseBasicInfoRows(releaseBase, () => '—');
    expect(rows).toHaveLength(15);
    expect(rows.map((r) => r.label)).toEqual([
      '系统', '应用', '正式版本号', '内部版本号', '项目类别', '版本类别', '产品立项方案名称',
      '所属部门', '产品负责人', '项目组成员', '方案地址', '上线时间', '合同签订方', '当前开放品牌', '备注',
    ]);
    expect(rows.find((r) => r.label === '产品负责人')?.value).toBe('何丹铃');
    expect(rows.some((r) => r.label === '备注')).toBe(true);
  });

  it('内部版本基础信息固定 17 行（对齐立项语雀列）', () => {
    const rows = buildInitiationBasicInfoRows(initiationBase, () => '—');
    expect(rows).toHaveLength(17);
    expect(rows[0].label).toBe('系统');
    expect(rows[3].label).toBe('立项号');
    expect(rows[6].label).toBe('项目需求描述');
  });

  it('缺省字段显示占位符', () => {
    const rows = buildReleaseBasicInfoRows({ ...releaseBase, systemName: null, legacyData: {} }, () => '—');
    expect(rows.find((r) => r.label === '系统')?.value).toBe('—');
    expect(rows.find((r) => r.label === '备注')?.value).toBe('—');
  });
});
