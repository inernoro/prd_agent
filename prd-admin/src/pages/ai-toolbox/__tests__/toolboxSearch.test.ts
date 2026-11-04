import { describe, expect, it } from 'vitest';
import { searchToolboxItems } from '../toolboxSearch';

const tools = [
  { name: '演讲智能体', description: '组织表达，支持 PPT', tags: ['演讲', '导图'] },
  { name: 'MD 转网页 PPT', description: '把 Markdown 转换为网页演示', tags: ['PPT', 'Markdown'] },
  { name: '视频创作', description: '生成视频教程', tags: ['视频', '教程'] },
];

describe('toolbox search', () => {
  it('ranks a tool name match before a description match', () => {
    expect(searchToolboxItems(tools, 'PPT').map((item) => item.name)).toEqual(['MD 转网页 PPT', '演讲智能体']);
  });
  it('matches task keywords across fields without requiring an exact sentence', () => {
    expect(searchToolboxItems(tools, '把 Markdown 做成 PPT')).toEqual([tools[1]]);
  });
  it('normalizes full-width text, casing and surrounding whitespace', () => {
    expect(searchToolboxItems(tools, '  ＭＡＲＫＤＯＷＮ  ppt  ')).toEqual([tools[1]]);
  });
  it('requires all meaningful keywords instead of returning unrelated tools', () => {
    expect(searchToolboxItems(tools, 'Rust PPT')).toEqual([]);
  });
  it('keeps the original catalog order for an empty query', () => {
    expect(searchToolboxItems(tools, '   ')).toBe(tools);
  });
  it('does not treat a connector-only query as an empty search', () => {
    expect(searchToolboxItems(tools, '做成')).toEqual([]);
  });
});
