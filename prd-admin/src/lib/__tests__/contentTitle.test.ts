import { describe, expect, it } from 'vitest';
import { deriveContentTitle, stripFilenamePrefix } from '../contentTitle';

// 行为快照:与原 DocumentGalaxyView 内嵌实现保持一致(提取共享后由本测试守卫)
describe('stripFilenamePrefix', () => {
  it('剥掉完整文件名前缀与其后分隔符', () => {
    expect(stripFilenamePrefix('design.cds.agent — 智能体运行时设计', 'design.cds.agent')).toBe('智能体运行时设计');
  });

  it('剥掉去 type 段后的文件名前缀', () => {
    expect(stripFilenamePrefix('cds.agent: 运行时', 'design.cds.agent')).toBe('运行时');
  });

  it('无前缀命中时原样返回(仅 trim)', () => {
    expect(stripFilenamePrefix('  纯正文标题  ', 'design.cds.agent')).toBe('纯正文标题');
  });
});

describe('deriveContentTitle', () => {
  it('从 frontmatter title 派生', () => {
    const summary = '---\ntitle: 双链账本设计\n---\n正文内容';
    expect(deriveContentTitle(summary, 'design.kb.mention')).toBe('双链账本设计');
  });

  it('frontmatter title 带文件名前缀时剥掉', () => {
    const summary = '---\ntitle: design.kb.mention — 双链账本设计\n---\n正文';
    expect(deriveContentTitle(summary, 'design.kb.mention')).toBe('双链账本设计');
  });

  it('无 frontmatter title 返回 null', () => {
    expect(deriveContentTitle('普通正文开头没有 frontmatter', 'a.md')).toBeNull();
  });

  it('HTML 片段返回 null', () => {
    expect(deriveContentTitle('<!DOCTYPE html><html>', 'a.html')).toBeNull();
  });

  it('空 summary 返回 null', () => {
    expect(deriveContentTitle(null, 'a.md')).toBeNull();
    expect(deriveContentTitle('', 'a.md')).toBeNull();
  });

  it('标题剥完前缀为空时返回 null', () => {
    const summary = '---\ntitle: design.kb.mention\n---\n正文';
    expect(deriveContentTitle(summary, 'design.kb.mention')).toBeNull();
  });
});
