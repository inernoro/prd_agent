import { describe, expect, it } from 'vitest';
import { buildInitiationBasicInfoRows, buildReleaseBasicInfoRows, formatVersionBasicDate } from './versionBasicInfoCatalog';
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
  it('正式版本基础信息包含旧申领字段（系统/应用合并为产品）', () => {
    const rows = buildReleaseBasicInfoRows(releaseBase, () => '—');
    expect(rows).toHaveLength(18);
    expect(rows.map((r) => r.label)).toEqual([
      '产品', '正式版本号', '内部版本号', '项目类别', '版本类别', '产品立项方案名称',
      '需求来源', '项目需求描述', '所属部门', '产品负责人', '项目组成员', '方案地址',
      '上线时间', '预计培训时长', '是否全域开放', '合同签订方', '当前开放品牌', '备注',
    ]);
    expect(rows.find((r) => r.label === '产品')?.value).toBe('互动营销');
    expect(rows.find((r) => r.label === '产品负责人')?.value).toBe('何丹铃');
    expect(rows.some((r) => r.label === '备注')).toBe(true);
  });

  it('内部版本基础信息包含旧申领字段（系统/应用合并为产品）', () => {
    const rows = buildInitiationBasicInfoRows(initiationBase, () => '—');
    expect(rows).toHaveLength(20);
    expect(rows[0].label).toBe('产品');
    expect(rows[2].label).toBe('立项号');
    expect(rows[5].label).toBe('需求来源');
    expect(rows[7].label).toBe('项目需求描述');
  });

  it('缺省字段显示占位符', () => {
    const rows = buildReleaseBasicInfoRows({ ...releaseBase, systemName: null, appName: null, legacyData: {} }, () => '—', '产品管理系统');
    expect(rows.find((r) => r.label === '产品')?.value).toBe('产品管理系统');
    expect(rows.find((r) => r.label === '备注')?.value).toBe('—');
  });

  it('正式版本培训只按分钟展示，不格式化成日期', () => {
    const rows = buildReleaseBasicInfoRows({
      ...releaseBase,
      plannedTrainingMinutes: 30,
      isGlobalOpen: true,
      demandSource: '拜耳',
    }, () => '—');
    expect(rows.find((row) => row.label === '预计培训时长')?.value).toBe('30 分钟');
    expect(rows.find((row) => row.label === '是否全域开放')?.value).toBe('是');
    expect(rows.find((row) => row.label === '需求来源')?.value).toBe('拜耳');
  });

  it('日期按北京时间显示，不受浏览器所在时区影响', () => {
    expect(formatVersionBasicDate('2026-09-20T16:00:00.000Z')).toBe('2026-09-21');
  });
});
