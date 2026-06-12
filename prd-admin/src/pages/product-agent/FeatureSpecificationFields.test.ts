import { describe, expect, it } from 'vitest';
import source from './ProductObjectDetailPage.tsx?raw';

describe('功能规范字段', () => {
  it('keeps the V2.6 required fields in both create and detail forms', () => {
    const requiredLabels = [
      '所属功能模块',
      '功能类型',
      '主需求',
      '计划版本',
      '负责人',
      '功能说明',
      '关键规则',
      '验收标准',
    ];

    requiredLabels.forEach((label) => {
      expect(source.split(label).length - 1).toBeGreaterThanOrEqual(2);
    });
    expect(source).toContain('正式上线版本号');
    expect(source).toContain('关联需求');
    expect(source).toContain('remark');
  });
});
