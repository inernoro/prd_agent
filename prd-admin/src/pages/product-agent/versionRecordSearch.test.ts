import { describe, expect, it } from 'vitest';
import { matchesVersionRecord } from './versionRecordSearch';
import type { ProductInitiation, ProductRelease } from './types';

const t = { appName: '米多总平台', tCode: 'T3.14.1', planName: '系统保存的另一份完整名称', status: 'approved' } as ProductInitiation;
const aliases = { 米多星球: '米多总平台' };
describe('版本搜索按应用和版本号定位', () => {
  it.each(['米多星球T3.14.1(IMP配套方案)AI文档1-3稿', '米多总平台 T3.14.1（不同方案名）', 'T3.14.1'])('完整名称差异不阻挡 %s', query => {
    expect(matchesVersionRecord(t, query, '', '', aliases)).toBe(true);
  });
  it('同号不同应用和不同编号不串，原状态筛选仍生效', () => {
    expect(matchesVersionRecord(t, '零售T3.14.1（IMP配套方案）', '', '', aliases)).toBe(false);
    expect(matchesVersionRecord(t, '米多星球T3.14.10（IMP配套方案）', '', '', aliases)).toBe(false);
    expect(matchesVersionRecord(t, 'T3.14.1', 'review_failed', '', aliases)).toBe(false);
  });
  it('无版本号保留名称子串搜索，括号和空格规范化', () => {
    expect(matchesVersionRecord(t, '系统 保存的', '')).toBe(true);
    expect(matchesVersionRecord({ ...t, planName: '应用（方案）' }, '应用(方案)', '')).toBe(true);
  });
  it('V也按自身V号而非关联T号匹配', () => {
    const v = { ...t, vCode: 'V1.2.3' } as unknown as ProductRelease;
    expect(matchesVersionRecord(v, '米多星球V1.2.3（任意标题）', '', '', aliases)).toBe(true);
    expect(matchesVersionRecord(v, '米多星球T3.14.1（任意标题）', '', '', aliases)).toBe(false);
  });
});
