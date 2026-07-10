import { describe, expect, it } from 'vitest';
import {
  filterAndSortLauncherItems,
  scoreLauncherSearchMatch,
} from '@/components/agent-switcher/AgentSwitcher';
import type { LauncherItem } from '@/lib/launcherCatalog';

function item(input: Partial<LauncherItem> & Pick<LauncherItem, 'id' | 'name' | 'route'>): LauncherItem {
  return {
    description: '',
    icon: 'Circle',
    group: 'toolbox',
    tags: [],
    ...input,
  };
}

const catalog: LauncherItem[] = [
  item({
    id: 'email-agent',
    name: '邮件模板智能体',
    route: '/email-agent',
    description: '常用流程邮件模板库',
    tags: ['邮件', '模板', '审批'],
  }),
  item({
    id: 'literary-agent',
    name: '文学创作智能体',
    route: '/literary-agent',
    description: '文学创作与配图',
    tags: ['文学', '写作'],
  }),
  item({
    id: 'channel-trace-agent',
    name: '商品溯源智能体',
    route: '/channel-trace-agent',
    description: '防窜物流业务知识问答',
    tags: ['商品', '溯源', '知识库'],
  }),
  item({
    id: 'changelog',
    name: '更新中心',
    route: '/changelog',
    group: 'infra',
    tags: ['更新', '周报', 'changelog', 'release'],
  }),
  item({
    id: 'defect-agent',
    name: '缺陷管理智能体',
    route: '/defect-agent',
    group: 'agent',
    tags: ['缺陷', '智能体', 'bug', '追踪'],
  }),
  item({
    id: 'document-store',
    name: '知识库',
    route: '/document-store',
    group: 'infra',
    tags: ['文档', '知识', '知识库', 'docs'],
  }),
  item({
    id: 'marketplace',
    name: '海鲜市场',
    route: '/marketplace',
    group: 'infra',
    tags: ['市场', 'marketplace', '分享', '社区'],
  }),
  item({
    id: 'ai-toolbox',
    name: 'AI 百宝箱',
    route: '/ai-toolbox',
    group: 'menu',
    tags: ['百宝箱', '工具'],
  }),
  item({
    id: 'library',
    name: '智识殿堂',
    route: '/library',
    group: 'infra',
    tags: ['智识', '殿堂', '知识', 'library', '社区'],
  }),
];

describe('AgentSwitcher search ranking', () => {
  it.each([
    ['更新中心', 'changelog', '/changelog'],
    ['缺陷管理', 'defect-agent', '/defect-agent'],
    ['知识库', 'document-store', '/document-store'],
    ['海鲜市场', 'marketplace', '/marketplace'],
    ['百宝箱', 'ai-toolbox', '/ai-toolbox'],
    ['智识殿堂', 'library', '/library'],
  ])('puts the intended navigation target first for %s', (query, expectedId, expectedRoute) => {
    const [first] = filterAndSortLauncherItems(catalog, query, {
      'email-agent': 999,
      'literary-agent': 999,
      'channel-trace-agent': 999,
    });

    expect(first?.id).toBe(expectedId);
    expect(first?.route).toBe(expectedRoute);
  });

  it('prioritizes exact label matches over high-usage fuzzy matches', () => {
    expect(scoreLauncherSearchMatch(catalog[5], '知识库')).toBeGreaterThan(
      scoreLauncherSearchMatch(catalog[2], '知识库'),
    );
  });
});
