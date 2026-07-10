import { describe, expect, it } from 'vitest';
import { getNextWorkspaceSkip, isVisibleWorkspace } from './workspaceListPaging';
import type { VisualAgentWorkspace } from '@/services/contracts/visualAgent';

describe('workspaceListPaging', () => {
  it('advances pagination by raw server items instead of filtered visible items', () => {
    const rawItems: Array<Pick<VisualAgentWorkspace, 'id' | 'scenarioType'>> = Array.from({ length: 30 }, (_, index) => ({
      id: String(index),
      scenarioType: index < 26 ? 'article-illustration' : 'image-gen',
    }));
    const visibleItems = rawItems.filter(isVisibleWorkspace);

    expect(visibleItems).toHaveLength(4);
    expect(getNextWorkspaceSkip(0, rawItems)).toBe(30);
    expect(getNextWorkspaceSkip(30, rawItems)).toBe(60);
  });
});
