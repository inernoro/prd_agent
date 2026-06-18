import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseProductHistoryCsv, parseProductHistoryXlsxBuffer } from './ProductHistoryImportDialog';

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
      sourceFields: undefined,
    }]);
  });

  it('maps 产品 column to route label', () => {
    const rows = parseProductHistoryCsv([
      '外部 ID,标题,产品,等级',
      '1,需求甲,产品管理系统,p1',
    ].join('\n'));
    expect(rows[0].sourceFields).toEqual({ 应用: '产品管理系统' });
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
      sourceFields: undefined,
    }]);
  });

  it('treats blank requirement id as missing', () => {
    const rows = parseProductHistoryCsv([
      '需求ID,标题,描述,应用',
      ',无ID需求,说明文案,产品管理系统',
    ].join('\n'));
    expect(rows[0].externalId).toBeUndefined();
    expect(rows[0].title).toBe('无ID需求');
  });

  it('maps requirement export columns to backend import fields', () => {
    const rows = parseProductHistoryCsv([
      'ID,标题,状态,优先级,需求来源,需求类型,分类,详细描述,处理人',
      '1007159,【智能营销】领奖记录导出新增券码字段,待评审,High,客户反馈,功能优化,智能营销,补充券码字段,张三；李四',
    ].join('\n'), { entityType: 'requirement' });

    expect(rows[0]).toMatchObject({
      title: '【智能营销】领奖记录导出新增券码字段',
      description: '补充券码字段',
      externalId: '1007159',
      sourceStatus: '待评审',
      sourcePriority: 'High',
      handlerNames: ['张三', '李四'],
      sourceFields: {
        应用: '智能营销',
        需求来源: '客户反馈',
        需求类型: '功能优化',
        分类: '智能营销',
      },
    });
  });

  it('parses xlsx requirement exports', () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['ID', '标题', '状态', '详细描述'],
      ['1001', '需求甲', '待规划', '说明'],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, '需求');
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const rows = parseProductHistoryXlsxBuffer(buffer, { entityType: 'requirement' });
    expect(rows[0]).toMatchObject({
      title: '需求甲',
      description: '说明',
      externalId: '1001',
      sourceStatus: '待规划',
    });
  });
});
