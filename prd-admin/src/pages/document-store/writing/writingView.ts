import type { WritingRole, WritingSection, WritingState, WritingSource } from '@/services/contracts/writing';
import { withDocumentStoreEntry } from '../documentStoreDeepLink';

export const writingKnowledgeHref = (storeId: string, entryId?: string) => `/document-store${withDocumentStoreEntry('', storeId, entryId)}`;

export function roleReadingSections(sections: WritingSection[], role?: WritingRole) {
  const ids = role?.orderedSectionIds?.length ? role.orderedSectionIds : role?.sectionId ? [role.sectionId] : sections.slice(0, 3).map(s => s.id);
  return [...new Set(ids)].map(id => sections.find(s => s.id === id)).filter((s): s is WritingSection => !!s);
}

export const PARAGRAPH_REGISTRY = {
  src: { label: '来源已支持', className: 'mark-src' },
  auth: { label: '作者补充', className: 'mark-auth' },
  ask: { label: '待确认', className: 'mark-ask' },
  conf: { label: '资料冲突', className: 'mark-conf' },
};
export const WRITING_STAGE_REGISTRY: Record<string, { label: string; step: number }> = {
  select: { label: '草稿', step: 0 }, generating: { label: '生成中', step: 1 }, failed: { label: '生成失败', step: 1 },
  confirm: { label: '补充确认', step: 2 }, review: { label: '审核发布', step: 3 },
  'pending-review': { label: '待审核', step: 3 }, publishing: { label: '发布中', step: 3 }, published: { label: '已发布', step: 3 }, recheck: { label: '版本待复核', step: 3 },
};
export function remainingQuestions(state: WritingState) { return state.questions.filter(q => q.status === 'pending').length; }
export function writingSaveInput(state: WritingState) {
  return { revision: state.revision, templateId: state.templateId, title: state.title, summary: state.summary,
    manualInput: state.manualInput, sourceEntryIds: state.sources.map(s => s.entryId), sections: state.sections,
    intentPoints: state.intentPoints, conclusions: state.conclusions, scopeIn: state.scopeIn, scopeOut: state.scopeOut,
    chapters: state.chapters, captions: state.captions, roles: state.roles, videoEntryId: state.videoEntryId ?? '' };
}

// Locations come from the stored source text; no generated location is invented.
export function writingSourceBlocks(source: WritingSource) {
  let location = '';
  return source.content.split(/\n\s*\n/).flatMap((block, index) => {
    const heading = block.match(/^#{1,6}\s+(.+)$/);
    if (heading) { location = heading[1]; return []; }
    return block.trim() ? [{ id: `${source.id}-${index}`, location, text: block.trim() }] : [];
  });
}
export function writingCitationLocation(source: WritingSource | undefined, quote: string) {
  if (!source || !quote) return '';
  return writingSourceBlocks(source).find(block => block.text.includes(quote))?.location ?? '';
}
