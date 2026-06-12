import { describe, expect, it } from 'vitest';
import { parseProductHistoryCsv } from './ProductHistoryImportDialog';

describe('parseProductHistoryCsv', () => {
  it('maps standard history columns and preserves quoted commas', () => {
    const rows = parseProductHistoryCsv([
      '外部 ID,标题,描述,等级,状态,计划发布时间,实际发布时间',
      'TAPD-1,"红包文案,显示优化",避免截断,p1,developing,2026-06-20,2026-06-25',
    ].join('\n'));

    expect(rows).toEqual([{
      title: '红包文案,显示优化',
      description: '避免截断',
      grade: 'p1',
      status: 'developing',
      sourceSystem: 'csv',
      externalId: 'TAPD-1',
      plannedAt: '2026-06-20',
      completedAt: '2026-06-25',
    }]);
  });

  it('falls back to the first column as title', () => {
    expect(parseProductHistoryCsv('未知列,内容\n需求甲,说明')).toEqual([{
      title: '需求甲',
      description: '说明',
      grade: undefined,
      status: undefined,
      sourceSystem: 'csv',
      externalId: undefined,
      plannedAt: undefined,
      completedAt: undefined,
    }]);
  });
});
