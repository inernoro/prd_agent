import { describe, expect, it } from 'vitest';
import { mapDefectRtfItem } from './defectRtfImport';
import type { RtfImportRequirement } from './requirementRtfImport';

describe('mapDefectRtfItem', () => {
  it('maps TAPD 优先级 to severity and handler fields', () => {
    const item: RtfImportRequirement = {
      externalId: '1023030',
      title: '示例缺陷',
      description: '<p>正文</p>',
      grade: 'p2',
      sourceStatus: '已解决',
      sourcePriority: '高',
      fields: { 优先级: '高', 处理人: '测试处理人;', 创建人: '测试创建人' },
      handlerNames: ['测试处理人'],
      developerNames: [],
      creatorNames: ['测试创建人'],
      ccNames: [],
      comments: [],
      images: [],
    };
    const row = mapDefectRtfItem(item);
    expect(row.handlerNames).toEqual(['测试处理人']);
    expect(row.reporterNames).toEqual(['测试创建人']);
    expect(row.externalId).toBe('1023030');
    expect(row.tapdSeverityRaw).toBe('高');
    expect(row.severity).toBe('严重');
    expect(row.grade).toBeUndefined();
  });
});
