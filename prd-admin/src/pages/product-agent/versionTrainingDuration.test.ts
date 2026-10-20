import { describe, expect, it } from 'vitest';
import type { ProductRelease } from './types';
import { formatVersionTrainingMinutes } from './versionBasicInfoCatalog';
import { releaseExportConfig } from './versionWorkflowExport';
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
  it('表单发送数值，方案资料不会再次被原文覆盖，识别后可继续手动加人', () => {
    expect(workflow).toContain('plannedTrainingMinutes: Number(trainingMinutes)');
    expect(workflow).toContain('预计培训时长（分钟）*');
    expect(workflow).not.toContain('plannedTrainingAt');
    expect(workflow).toContain('parsed.initiationCandidates ?? []');
    expect(workflow).toContain('chooseInitiation(source.id, source)');
    expect(workflow).toContain('if (!source) {');
    expect(workflow).toContain('匹配到 ${candidates.length} 个相近方案');
    expect(workflow).toContain('查看全部方案');
    expect(workflow).toContain('<UserSearchSelect value=""');
    expect(workflow).toContain('if (id && !selected.includes(id))');
    expect(paste).toContain('latestOnParsed.current(result)');
  });
  it('手填和企微 T 名称都消费后端清洗，过期响应不覆盖正在编辑的标题', () => {
    expect(initiation).toContain("parseProductVersionMessage('internal', `产品立项方案名称：${entered}`)");
    expect(initiation).toContain('planNameRef.current !== entered');
    expect(initiation).toContain('parsed.matchedApplicationId');
  });
});
