import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import KnowledgeEntryPicker, {
  createLatestRequestGate,
  knowledgeSelectionContextChanged,
  knowledgeEntrySelectionKey,
  MAX_KNOWLEDGE_ENTRY_SELECTIONS,
  resolveKnowledgeSearchAction,
  toggleKnowledgeEntrySelection,
  type KnowledgeEntrySelection,
} from './KnowledgeEntryPicker';

function entry(storeId: string, entryId: string, title = entryId): KnowledgeEntrySelection {
  return { storeId, entryId, title, storeName: `知识库 ${storeId}` };
}

describe('KnowledgeEntryPicker selection contract', () => {
  it('uses store and entry identity so same entry id in another store remains distinct', () => {
    expect(knowledgeEntrySelectionKey(entry('store-a', 'same'))).not.toBe(
      knowledgeEntrySelectionKey(entry('store-b', 'same')),
    );
  });

  it('keeps cross-page selections and enforces the three-entry model limit', () => {
    const firstPage = [entry('store-a', 'a'), entry('store-a', 'b')];
    const withThird = toggleKnowledgeEntrySelection(firstPage, entry('store-b', 'c'));
    expect(withThird.entries.map(knowledgeEntrySelectionKey)).toEqual([
      'store-a:a',
      'store-a:b',
      'store-b:c',
    ]);
    expect(withThird.limitReached).toBe(false);

    const overLimit = toggleKnowledgeEntrySelection(withThird.entries, entry('store-b', 'd'));
    expect(overLimit.entries).toEqual(withThird.entries);
    expect(overLimit.limitReached).toBe(true);
    expect(overLimit.entries).toHaveLength(MAX_KNOWLEDGE_ENTRY_SELECTIONS);
  });

  it('treats modal editing as a draft so cancelling does not mutate committed entries', () => {
    const committed = [entry('store-a', 'a')];
    const draft = [...committed];
    const changedDraft = toggleKnowledgeEntrySelection(draft, entry('store-b', 'b')).entries;
    expect(changedDraft).toHaveLength(2);
    expect(committed).toEqual([entry('store-a', 'a')]);
  });

  it('rejects stale store and entry responses after a newer request or close', () => {
    const gate = createLatestRequestGate();
    const oldRequest = gate.begin();
    const currentRequest = gate.begin();
    expect(gate.isCurrent(oldRequest)).toBe(false);
    expect(gate.isCurrent(currentRequest)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(currentRequest)).toBe(false);
  });

  it('does not invalidate in-flight work when the same scope, store, or search is chosen again', () => {
    expect(knowledgeSelectionContextChanged('mine', 'mine')).toBe(false);
    expect(knowledgeSelectionContextChanged('store-a', 'store-a')).toBe(false);
    expect(resolveKnowledgeSearchAction('活动', 1, '活动', true)).toBe('noop');
    expect(resolveKnowledgeSearchAction('活动', 1, '活动', false)).toBe('reload');
    expect(resolveKnowledgeSearchAction('活动', 2, '活动', false)).toBe('change');
    expect(resolveKnowledgeSearchAction('活动', 1, '规则', false)).toBe('change');
  });
});

describe('KnowledgeEntryPicker rendered contract', () => {
  it('shows unambiguous store and title identity plus full browsing entry point', () => {
    const html = renderToStaticMarkup(
      <KnowledgeEntryPicker
        recentEntries={[
          {
            id: 'recent-entry',
            storeId: 'recent-store',
            storeName: '社区资料库',
            title: '开放安排',
            contentType: 'text/markdown',
            tags: [],
            createdAt: '',
            updatedAt: '',
            isNew: false,
          },
        ]}
        selectedEntries={[entry('archive-store', 'outside-recent', '历史服务规则')]}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('知识库 archive-store');
    expect(html).toContain('历史服务规则');
    expect(html).toContain('社区资料库 / 开放安排');
    expect(html).toContain('浏览我的与团队知识');
    expect(html).toContain('1/3');
  });
});
