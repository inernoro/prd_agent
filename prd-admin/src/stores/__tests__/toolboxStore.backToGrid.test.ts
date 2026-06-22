import { beforeEach, describe, expect, it } from 'vitest';
import { useToolboxStore } from '../toolboxStore';
import type { ToolboxItem } from '@/services';

const sharedItem: ToolboxItem = {
  id: 'shared-agent',
  name: '我的分享',
  description: '跨网页托管 / 周报 / 知识库 / 工作流的所有分享统一管理',
  icon: 'Share2',
  category: 'custom',
  type: 'custom',
  kind: 'agent',
  agentKey: 'my-shares',
  tags: ['分享'],
  ownership: 'others',
  usageCount: 0,
  createdAt: '2026-06-09T00:00:00.000Z',
};

describe('toolbox backToGrid', () => {
  beforeEach(() => {
    useToolboxStore.setState({
      view: 'grid',
      pageTab: 'toolbox',
      category: 'all',
      searchQuery: '',
      selectedItem: null,
      editingItem: null,
      runStatus: 'idle',
      runOutput: '',
      runArtifacts: [],
      runError: null,
      funcKindFilter: 'all',
      activeTagFilter: null,
    });
  });

  it('returns from a shared agent detail to the first-level toolbox view', () => {
    const store = useToolboxStore.getState();

    store.setCategory('others');
    store.setFuncKindFilter('agent');
    store.setSearchQuery('分享');
    store.setActiveTagFilter('管理');
    store.selectItem(sharedItem);

    expect(useToolboxStore.getState().view).toBe('detail');

    useToolboxStore.getState().backToGrid();

    expect(useToolboxStore.getState()).toMatchObject({
      view: 'grid',
      pageTab: 'toolbox',
      category: 'all',
      searchQuery: '',
      selectedItem: null,
      funcKindFilter: 'all',
      activeTagFilter: null,
    });
  });
});
