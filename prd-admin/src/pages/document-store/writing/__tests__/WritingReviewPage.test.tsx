// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WritingContext, WritingState, WritingTemplate } from '@/services/contracts/writing';
import { WritingReviewPage } from '../WritingReviewPage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const template: WritingTemplate = { id: 'prd', name: '需求说明', type: '需求说明', role: '', useWhen: '', version: '1.0', headings: [] };
const context: WritingContext = {
  store: { id: 'store', name: '交接知识库' } as WritingContext['store'],
  actorId: 'author', actorName: '作者', reviewerId: 'reviewer', reviewerName: '审核人', templates: [template], sources: [],
};
function publishedState(): WritingState {
  const sections: WritingState['sections'] = [{ id: 'handoff', title: '权限交接', condition: '仅限部门内部', metadataConfirmed: true, paragraphs: [
    { id: 'author-note', text: '离岗当天不得补办，异常须经主管确认。', status: 'auth', citations: [], confirmed: true },
    { id: 'source-note', text: '离岗前3个工作日完成权限移交。', status: 'src', citations: ['S1'], quotes: { S1: '离岗前3个工作日完成权限移交。' }, confirmed: true },
  ] }];
  return {
    revision: 9, stage: 'published', templateId: 'prd', templateVersion: '1.0', title: '交接说明', summary: '部门交接', manualInput: '',
    authorId: 'author', authorName: '作者', reviewerId: 'reviewer', reviewerName: '审核人', scopeIn: '部门内部', scopeOut: '外部人员',
    conclusions: [], intentPoints: [], roles: [], chapters: [], sections,
    sources: [{ id: 'S1', entryId: 'source-entry', title: '权限规定', content: '离岗前3个工作日完成权限移交。', hash: 'snapshot-hash', updatedAt: '2026-11-13T08:00:00Z', status: 'read' }],
    questions: [{ id: 'Q1', kind: 'ask', paragraphId: 'author-note', sectionTitle: '权限交接', title: '异常如何处理？', why: '', citations: [], options: [], status: 'answered', answer: '须经主管确认' }],
    updatedAt: '2026-11-13T09:00:00Z',
    published: { version: 1, title: '交接说明', summary: '部门交接', templateId: 'prd', templateVersion: '1.0', authorName: '作者', reviewerName: '审核人', publishedAt: '2026-11-13T09:00:00Z', conclusions: [], scopeIn: '部门内部', scopeOut: '外部人员', sections, sources: [], roles: [], openQuestions: [], chapters: [] },
  };
}
let root: Root | undefined, container: HTMLDivElement;
async function mount(state: WritingState, onCommand = vi.fn().mockResolvedValue(undefined)) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  const onPatch = vi.fn();
  await act(async () => root!.render(<MemoryRouter><WritingReviewPage state={state} context={context} template={template} locked busy={false} dirty={false} onPatch={onPatch} onCommand={onCommand} onBack={vi.fn()} /></MemoryRouter>));
  return { onCommand, onPatch };
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); });

describe('已发布作者审核页保留只读逐段核对记录', () => {
  it('保留来源计数、作者逐段确认及已处理问题，发布设置不替代清单', async () => {
    await mount(publishedState());
    expect(container.querySelector('.writing-review-origin')?.textContent).toContain('内容来源');
    expect(container.querySelector('.writing-review-authors')?.textContent).toContain('逐段过目 1 / 1');
    expect(container.querySelector('.writing-review-authors')?.textContent).toContain('离岗当天不得补办');
    expect(container.querySelector('.writing-review-answers')?.textContent).toContain('异常如何处理？');
    expect(container.querySelector('.writing-review-publish-settings')?.textContent).toContain('发布版本v1');
    expect(container.querySelector('.writing-review-edit')).toBeNull();
  });
  it('全部确认后来源段落仍可展开核对，发布锁定不允许改变已确认内容', async () => {
    const state = publishedState(), snapshot = JSON.stringify(state);
    const { onCommand, onPatch } = await mount(state);
    const sourceDetails = container.querySelector<HTMLDetailsElement>('.writing-review-supported');
    expect(sourceDetails).not.toBeNull();
    expect(sourceDetails?.open).toBe(false);
    expect(sourceDetails?.textContent).toContain('来源与条件核对 · 1 / 1');
    expect(sourceDetails?.textContent).toContain('离岗前3个工作日完成权限移交。');
    const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(inputs).toHaveLength(3);
    expect(inputs.every(input => input.checked && input.disabled)).toBe(true);
    await act(async () => inputs.forEach(input => input.click()));
    expect(onCommand).not.toHaveBeenCalled(); expect(onPatch).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});
