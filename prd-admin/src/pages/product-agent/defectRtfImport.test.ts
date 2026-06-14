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
      fields: { 优先级: '高', 处理人: '伍林波;', 创建人: '陈嘉颖' },
      handlerNames: ['伍林波'],
      developerNames: [],
      creatorNames: ['陈嘉颖'],
      ccNames: [],
      comments: [],
      images: [],
    };
    const row = mapDefectRtfItem(item);
    expect(row.handlerNames).toEqual(['伍林波']);
    expect(row.reporterNames).toEqual(['陈嘉颖']);
    expect(row.externalId).toBe('1023030');
    expect(row.tapdSeverityRaw).toBe('高');
    expect(row.severity).toBe('严重');
    expect(row.grade).toBeUndefined();
  });
});
