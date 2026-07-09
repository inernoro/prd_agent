import type { VisualAgentWorkspace } from '@/services/contracts/visualAgent';

export function isVisibleWorkspace(item: Pick<VisualAgentWorkspace, 'scenarioType'>) {
  return item.scenarioType !== 'article-illustration';
}

export function getNextWorkspaceSkip(currentSkip: number, rawItems: readonly unknown[]) {
  return currentSkip + rawItems.length;
}
