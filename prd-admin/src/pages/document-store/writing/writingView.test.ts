import { describe, it, expect } from 'vitest';
import { writingSaveInput, remainingQuestions, roleReadingSections, writingKnowledgeHref } from './writingView';
import { parseDocumentStoreDeepLink } from '../documentStoreDeepLink';
import type { WritingState } from '@/services/contracts/writing';

describe('写作工作区命令契约', () => {
  const state = { revision: 12, title: '方案', templateId: 'prd', manualInput: '作者原始输入', sources: [{ entryId: 'real-entry' }],
    sections: [], questions: [{ status: 'pending' }, { status: 'open' }], intentPoints: ['范围不能丢'], conclusions: [], chapters: [] } as unknown as WritingState;
  it('保存携带服务器版本与原始输入，不把发布快照回写为草稿', () => {
    const input = writingSaveInput(state);
    expect(input.revision).toBe(12);
    expect(input.sourceEntryIds).toEqual(['real-entry']);
    expect(input.manualInput).toBe('作者原始输入');
    expect(input).not.toHaveProperty('published');
    expect(input).not.toHaveProperty('stage');
  });
  it('开放问题已处理，不计为未处理确认项', () => expect(remainingQuestions(state)).toBe(1));
  it('返回和原文链接落在现有知识库路由，并保留知识库与条目选择', () => {
    const href = new URL(writingKnowledgeHref('real-store', 'real-entry'), 'http://localhost');
    expect(href.pathname).toBe('/document-store');
    expect(parseDocumentStoreDeepLink(href.search)).toEqual({ storeId: 'real-store', entryId: 'real-entry' });
  });
  it('切换读者角色使用作者保存的阅读顺序，排除不存在的小节', () => {
    const sections = ['背景', '功能', '验收'].map((title, i) => ({ id: `s${i}`, title, paragraphs: [] }));
    expect(roleReadingSections(sections, { label: '交接人', action: '', condition: '', sectionId: 's1', orderedSectionIds: ['s1', 's2', 'missing'] }).map(s => s.title)).toEqual(['功能', '验收']);
    expect(roleReadingSections(sections, { label: '学员', action: '', condition: '', sectionId: 's0' }).map(s => s.title)).toEqual(['背景']);
  });
});
