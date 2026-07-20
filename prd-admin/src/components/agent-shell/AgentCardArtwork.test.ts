import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import { buildStaticAgents } from '@/lib/homeLauncherItems';
import { AgentCardArtwork, AgentCardFrame, AgentCardTask, getAgentCardTask, hasAgentCardArtwork } from './AgentCardArtwork';

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

  it('支持按智能体类别给灰阶插画注入色彩层', () => {
    const html = renderToStaticMarkup(
      createElement(AgentCardArtwork, { agentKey: 'visual-agent', tint: 'hsl(271 68% 64%)' }),
    );

    expect(html).toContain('linear-gradient(128deg, hsl(271 68% 64%) 0%, transparent 72%)');
    expect(html).toContain('mix-blend-mode:color');
  });

  it('高密度任务标识保留可访问名称并省略重复标签', () => {
    const html = renderToStaticMarkup(
      createElement(AgentCardTask, { agentKey: 'visual-agent', dense: true }),
    );

    expect(html).toContain('aria-label="任务：完成视觉创作"');
    expect(html).not.toContain('>任务</span>');
    expect(html).toContain('var(--text-on-media-muted)');
    expect(html).toContain('var(--media-card-task-muted)');
  });

  it('卡片边缘层统一基础与悬浮描边的裁切边界', () => {
    const html = renderToStaticMarkup(
      createElement(AgentCardFrame, { hoverBorder: 'rgba(84, 222, 176, 0.26)' }),
    );

    expect(html).toContain('rounded-[inherit]');
    expect(html).toContain('z-20');
    expect(html).toContain('var(--media-card-border)');
    expect(html).toContain('rgba(84, 222, 176, 0.26)');
  });
});
