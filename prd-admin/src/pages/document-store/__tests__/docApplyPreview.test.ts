import { describe, it, expect } from 'vitest';
import { buildApplyPreview, buildOutputTitle, applyModeMeta } from '../docApplyPreview';

describe('buildApplyPreview', () => {
  it('replace：产出 diff，并统计增删', () => {
    const p = buildApplyPreview('replace', '第一行\n第二行', '第一行\n改后第二行', '文档.md');
    expect(p.kind).toBe('diff');
    expect(p.diff && p.diff.length).toBeGreaterThan(0);
    expect(p.stats).toEqual({ added: 1, removed: 1 });
  });

  it('replace：原文与 AI 输出完全一致时零增删（用户应被提示无变化）', () => {
    const p = buildApplyPreview('replace', '一样\n内容', '一样\n内容', 'x.md');
    expect(p.stats).toEqual({ added: 0, removed: 0 });
  });

  it('append：body 为去空白后的 AI 内容，不产 diff', () => {
    const p = buildApplyPreview('append', '原文', '  追加段\n第二段  ', 'x.md');
    expect(p.kind).toBe('append');
    expect(p.body).toBe('追加段\n第二段');
    expect(p.diff).toBeUndefined();
    expect(p.stats).toEqual({ added: 2, removed: 0 });
  });

  it('new：给默认标题 + 预览 body，不产 diff', () => {
    const p = buildApplyPreview('new', '原文', 'AI 生成内容', '设计稿.md');
    expect(p.kind).toBe('new');
    expect(p.defaultTitle).toBe('设计稿-AI 再加工.md');
    expect(p.body).toBe('AI 生成内容');
  });
});

describe('buildOutputTitle', () => {
  it('去扩展名后拼后缀', () => {
    expect(buildOutputTitle('需求.md')).toBe('需求-AI 再加工.md');
  });
  it('无扩展名时整名作为基底', () => {
    expect(buildOutputTitle('需求')).toBe('需求-AI 再加工.md');
  });
  it('空标题兜底为「新文档」', () => {
    expect(buildOutputTitle('   ')).toBe('新文档-AI 再加工.md');
  });
});

describe('applyModeMeta', () => {
  it('replace 标记为破坏性', () => {
    expect(applyModeMeta('replace').danger).toBe(true);
  });
  it('append / new 非破坏性', () => {
    expect(applyModeMeta('append').danger).toBe(false);
    expect(applyModeMeta('new').danger).toBe(false);
  });
});
