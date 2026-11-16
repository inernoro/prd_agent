import { describe, expect, it } from 'vitest';
import type { ProductInitiation, ProductRelease } from './types';
import type { WorkflowVersionRecord } from '@/services/real/productAgent';
import { toCSV } from '@/lib/csv';
import { formatVersionTrainingMinutes } from './versionBasicInfoCatalog';
import { initiationExportConfig, releaseExportConfig } from './versionWorkflowExport';
import { parseVersionWorkflowImportCsv } from './versionWorkflowImportParse';
import workflow from './ReleaseWorkflowDetail.tsx?raw';
import initiation from './VersionWorkflowTab.tsx?raw';
import paste from './ProductVersionMessagePaste.tsx?raw';

describe('培训分钟与方案回填契约', () => {
  it('培训只显示分钟，零分钟有效，空值不补日期', () => {
    expect(formatVersionTrainingMinutes(30)).toBe('30 分钟');
    expect(formatVersionTrainingMinutes(0)).toBe('0 分钟');
    expect(formatVersionTrainingMinutes(null)).toBe('—');
  });
  it('分钟经过导出和再导入不转成日期', () => {
    const item = { productId: 'app', vCode: 'V1.2.3', planName: '方案', projectType: 'standard', versionType: 'minor', plannedTrainingMinutes: 30,
      teamMemberIds: [], requirementIds: [], status: 'announcement_pending' } as unknown as ProductRelease;
    const config = releaseExportConfig('app', '互动营销', new Map(), []);
    const csv = [config.headers.join(','), config.mapRow(item).join(',')].join('\n');
    expect(parseVersionWorkflowImportCsv(csv, 'release')[0].plannedTrainingMinutes).toBe(30);
  });
  it('正式版本导出后可重新读取线上 TAPD、人员、关联需求和实际上线时间字段', () => {
    const tapdLinks = [
      { title: '含逗号, 和引号"的需求', url: 'https://www.tapd.cn/1?x=1&y=2' },
      { title: '', url: 'https://www.tapd.cn/2' },
    ];
    const item = {
      productId: 'app', systemName: '测试系统', vCode: 'V1.2.3', tCode: 'T1.2.4', planName: '方案',
      projectType: 'standard', versionType: 'minor', plannedTrainingMinutes: 30,
      teamMemberIds: ['person-2'], projectMemberNames: ['测试成员'], requirementIds: ['req-1', 'req-2'],
      ownerId: 'person-1', ownerName: '测试负责人', status: 'voided', voidReason: '历史作废原因',
      voidedAt: '2026-11-05T04:01:02.555Z', plannedReleaseAt: '2026-11-03T00:00:00.000Z',
      releasedAt: '2026-11-04T03:22:15.123Z', tapdLinks, noTapdLinks: false,
    } as ProductRelease;
    const config = releaseExportConfig('app', '互动营销', new Map([['person-1', '测试负责人'], ['person-2', '测试成员']]), []);
    const second = { ...item, vCode: 'V1.2.4', tapdLinks: [], noTapdLinks: true, releasedAt: null };
    const [row, absent] = parseVersionWorkflowImportCsv(toCSV(config.headers, [config.mapRow(item), config.mapRow(second)]), 'release');
    expect(row).toMatchObject({
      appName: '互动营销', systemName: '测试系统', ownerId: 'person-1', ownerName: '测试负责人',
      teamMemberIds: ['person-2'], projectMemberNames: ['测试成员'], requirementIds: ['req-1', 'req-2'],
      status: '已作废', voidReason: item.voidReason, voidedAt: item.voidedAt, tapdLinks, noTapdLinks: false,
      plannedReleaseAt: item.plannedReleaseAt, releasedAt: item.releasedAt,
    });
    expect(absent.noTapdLinks).toBe(true);
    expect(absent.tapdLinks).toBeUndefined();
    expect(absent.releasedAt).toBeUndefined();
    expect(absent.date).toBeUndefined();
  });
  it('内部版本导出后可重新读取系统、人员、需求及作废字段', () => {
    const item = {
      productId: 'app', systemName: '测试系统', tCode: 'T1.2.3', planName: '立项方案',
      projectType: 'standard', versionType: 'minor', requirementIds: ['req-1'],
      ownerId: 'person-1', ownerName: '负责人', status: 'voided', voidReason: '作废理由',
      voidedAt: '2026-11-05T04:01:02.555Z',
    } as ProductInitiation;
    const config = initiationExportConfig('app', '互动营销', new Map([['person-1', '负责人']]));
    const [row] = parseVersionWorkflowImportCsv(toCSV(config.headers, [config.mapRow(item)]), 'initiation');
    expect(row).toMatchObject({ code: 'T1.2.3', systemName: '测试系统', ownerId: 'person-1',
      requirementIds: ['req-1'], status: '已作废', voidReason: item.voidReason, voidedAt: item.voidedAt });
  });
  it('导出人员 ID 只使用核验账号，历史名称仍留在姓名列', () => {
    const item: WorkflowVersionRecord<ProductRelease> = {
      id: 'release', productId: 'app', vCode: 'V1.2.3', planName: '旧表导入方案', projectType: 'standard', versionType: 'minor',
      ownerName: '重名负责人', ownerId: '重名负责人', teamMemberIds: ['简称成员', 'verified'],
      projectMemberNames: ['简称成员', '已核验成员'], requirementIds: [], status: 'released',
      isTemporaryOptimization: false, openBrandScope: '', sourceType: 'import', createdBy: 'recorder',
      createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z',
      exportFields: { systemName: '目录系统', ownerId: null, teamMemberIds: ['verified', 'matched'] },
    };
    const config = releaseExportConfig('app', '互动营销', new Map(), []);
    const [row] = parseVersionWorkflowImportCsv(toCSV(config.headers, [config.mapRow(item)]), 'release');
    expect(row.ownerName).toBe('重名负责人');
    expect(row.ownerId).toBeUndefined();
    expect(row.projectMemberNames).toEqual(['简称成员', '已核验成员']);
    expect(row.teamMemberIds).toEqual(['verified', 'matched']);
    expect(row.systemName).toBe('目录系统');
  });
  it('表单发送数值，方案资料不会再次被原文覆盖，识别后可继续手动加人', () => {
    expect(workflow).toContain('plannedTrainingMinutes: trainingRequired ? Number(trainingMinutes) : undefined');
    expect(workflow).toContain('预计培训时长（分钟）*');
    expect(workflow).not.toContain('plannedTrainingAt');
    expect(workflow).toContain('parsed.initiationCandidates ?? []');
    expect(workflow).toContain('chooseInitiation(source.id, source)');
    expect(workflow).toContain('if (!source) {');
    expect(workflow).toContain('匹配到 ${candidates.length} 个相近方案');
    expect(workflow).toContain('查看全部方案');
    expect(workflow).toContain('<UserSearchSelect value=""');
    expect(workflow).toContain('if (id && !selected.includes(id))');
    expect(paste).toContain('latestOnParsed.current(result, editVersion)');
  });
  it('手填名称不再失焦重写，企微回填受编辑版本保护', () => {
    expect(initiation).not.toContain('planNameRef.current !== entered');
    expect(initiation).toContain('planNameDraft.setManual(e.target.value)');
    expect(initiation).toContain('planNameDraft.isCurrentEdit(editVersion)');
    expect(initiation).toContain('parsed.matchedApplicationId');
  });
});
