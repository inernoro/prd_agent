import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentDelegateBar } from '../ReprocessChatDrawer';
import type { GeneralAgentInfo } from '@/services/real/agentUniverse';
import type { ToolboxItem } from '@/services/real/aiToolbox';

/**
 * 专家条是用户第一眼看到的那排头像。
 * 少渲染一个、少一句悬浮说明都不会报错、不会红，只会安静地退回「看不出有哪些专家」——
 * 正是这次要杜绝的那类静默退化，所以逐条断言。
 */
describe('AgentDelegateBar', () => {
  const delegates: GeneralAgentInfo['delegates'] = [
    { agentKey: 'visual-agent', name: '视觉创作智能体', icon: 'Image', accent: '#A78BFA', description: '文字变图片', hint: '通用助手可以直接出图', autoRoutable: false },
    { agentKey: 'literary-agent', name: '文学创作智能体', icon: 'PenLine', accent: '#4ADE80', description: '改写成叙事', hint: '说「改写成故事」时会自己找它', autoRoutable: true },
    { agentKey: 'defect-agent', name: '缺陷管理智能体', icon: 'Bug', accent: '#FB923C', description: '提取结构化缺陷', hint: '说「帮我开个单」时会自己找它', autoRoutable: true },
  ];
  const items = [
    { id: '1', name: '视觉创作', agentKey: 'visual-agent', icon: 'Image' },
    { id: '2', name: '文学创作', agentKey: 'literary-agent', icon: 'PenLine' },
    { id: '3', name: '缺陷管理', agentKey: 'defect-agent', icon: 'Bug' },
  ] as ToolboxItem[];

  const general = (over: Partial<GeneralAgentInfo> = {}): GeneralAgentInfo => ({
    agentKey: 'chat-agent',
    name: '通用智能体',
    description: '直接说要做什么就行',
    icon: 'Sparkles',
    accent: '#D97757',
    available: true,
    unavailableReason: null,
    delegates,
    ...over,
  });

  it('每位专家都渲染出头像，且悬浮能看到「是干嘛的」和「什么时候会找它」', () => {
    const html = renderToStaticMarkup(
      <AgentDelegateBar general={general()} toolboxItems={items} onPick={() => {}} />,
    );
    for (const d of delegates) {
      expect(html).toContain(d.name);        // 悬浮 title 里有名字
      expect(html).toContain(d.description); // 有「是干嘛的」
      expect(html).toContain(d.hint);        // 有「什么时候会自己找它」
    }
    // 三个都是可点的按钮（点一下 = 强制指派）
    expect(html.match(/<button/g)?.length).toBe(3);
  });

  it('通用体可用时提示「可随时 @ 指定」——强调不必点', () => {
    const html = renderToStaticMarkup(
      <AgentDelegateBar general={general()} toolboxItems={items} onPick={() => {}} />,
    );
    expect(html).toContain('可随时 @ 指定');
    expect(html).not.toContain('请手动挑');
  });

  it('通用体不可用时如实说明原因，并改口要求手动挑', () => {
    const html = renderToStaticMarkup(
      <AgentDelegateBar
        general={general({ available: false, unavailableReason: '对话运行时还没配置，管理员启用后才能用通用智能体。' })}
        toolboxItems={items}
        onPick={() => {}}
      />,
    );
    expect(html).toContain('通用智能体不可用，请手动挑');
    expect(html).toContain('对话运行时还没配置');
    expect(html).toContain('var(--semantic-warning-text)');
  });

  it('某个专家在本环境拿不到时禁用并说明，而不是画一个点了没反应的头像', () => {
    const html = renderToStaticMarkup(
      <AgentDelegateBar general={general()} toolboxItems={[items[0]]} onPick={() => {}} />,
    );
    expect(html).toContain('（当前不可用）');
    expect(html.match(/disabled=""/g)?.length).toBe(2); // 文学 + 缺陷 不可用
  });

  it('当前被指派的那位要看得出来（描边用它自己的主题色）', () => {
    const html = renderToStaticMarkup(
      <AgentDelegateBar general={general()} toolboxItems={items} activeAgentKey="defect-agent" onPick={() => {}} />,
    );
    expect(html).toContain('#FB923C2E'); // 选中态底色
  });

  it('后端没下发通用体时整条不渲染，不留半截空壳', () => {
    expect(renderToStaticMarkup(
      <AgentDelegateBar general={null} toolboxItems={items} onPick={() => {}} />,
    )).toBe('');
    expect(renderToStaticMarkup(
      <AgentDelegateBar general={general({ delegates: [] })} toolboxItems={items} onPick={() => {}} />,
    )).toBe('');
  });
});
