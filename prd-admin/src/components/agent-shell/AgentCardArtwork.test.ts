import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import { buildStaticAgents } from '@/lib/homeLauncherItems';
import { AgentCardArtwork, AgentCardTask, getAgentCardTask, hasAgentCardArtwork } from './AgentCardArtwork';

describe('AgentCardArtwork', () => {
  it('为全部内置智能体提供职责化背景', () => {
    const builtinAgents = [
      ...BUILTIN_TOOLS.filter((item) => item.kind === 'agent'),
      ...buildStaticAgents(),
    ];
    const missingArtwork = builtinAgents
      .filter((item) => !hasAgentCardArtwork(item.agentKey))
      .map((item) => item.agentKey);

    expect(builtinAgents).toHaveLength(23);
    expect(missingArtwork).toEqual([]);
  });

  it('为全部内置智能体提供直接任务说明', () => {
    const builtinAgents = [
      ...BUILTIN_TOOLS.filter((item) => item.kind === 'agent'),
      ...buildStaticAgents(),
    ];
    const missingTasks = builtinAgents
      .filter((item) => !getAgentCardTask(item.agentKey))
      .map((item) => item.agentKey);

    expect(missingTasks).toEqual([]);
  });

  it('支持限制图片高度，为下部信息面板留出空间', () => {
    const html = renderToStaticMarkup(
      createElement(AgentCardArtwork, { agentKey: 'visual-agent', imageHeight: '57%' }),
    );

    expect(html).toContain('clip-path:inset(0 0 calc(100% - 57%) 0)');
  });

  it('高密度任务标识保留可访问名称并省略重复标签', () => {
    const html = renderToStaticMarkup(
      createElement(AgentCardTask, { agentKey: 'visual-agent', dense: true }),
    );

    expect(html).toContain('aria-label="任务：完成视觉创作"');
    expect(html).not.toContain('>任务</span>');
  });
});
