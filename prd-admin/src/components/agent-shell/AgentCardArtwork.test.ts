import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import { buildStaticAgents } from '@/lib/homeLauncherItems';
import {
  AgentCardArtwork,
  AgentCardFrame,
  AgentCardTask,
  getAgentCardTask,
  hasAgentCardArtwork,
} from './AgentCardArtwork';
import { AGENT_CARD_ART, buildAgentCardArtSvg } from './agentCardArtSource';

describe('AgentCardArtwork', () => {
  const builtinAgents = Array.from(
    new Map([...BUILTIN_TOOLS, ...buildStaticAgents()].map((item) => [item.agentKey, item])).values(),
  );

  it('为全部内置百宝箱条目提供职责化背景', () => {
    const missingArtwork = builtinAgents
      .filter((item) => !hasAgentCardArtwork(item.agentKey))
      .map((item) => item.agentKey);

    expect(builtinAgents).toHaveLength(new Set([
      ...BUILTIN_TOOLS.map((item) => item.agentKey),
      ...buildStaticAgents().map((item) => item.agentKey),
    ]).size);
    expect(missingArtwork).toEqual([]);
  });

  it('为全部内置百宝箱条目提供直接任务说明', () => {
    const missingTasks = builtinAgents
      .filter((item) => !getAgentCardTask(item.agentKey))
      .map((item) => item.agentKey);

    expect(missingTasks).toEqual([]);
  });

  it('每个内置条目都有一张自己的画，没有两个 key 共用同一份', () => {
    const drawings = builtinAgents.map((item) => AGENT_CARD_ART[item.agentKey!]);

    expect(drawings.every(Boolean)).toBe(true);
    expect(new Set(drawings).size).toBe(builtinAgents.length);
  });

  it('pattern id 按 key 隔离，同页多张卡片不会互相串纹理', () => {
    // `url(#ink-hatch)` 是文档级查找，只认整篇里第一个同名 id；而 pattern 里的
    // currentColor 解析的是定义处的颜色，不是使用处的。首页一屏十几张卡片，
    // id 不隔离就会整片跟着第一张走——不报错，只是悄悄画错。
    const a = buildAgentCardArtSvg('visual-agent')!;
    const b = buildAgentCardArtSvg('defect-agent')!;

    expect(a).toContain('id="ink-hatch-visual-agent"');
    expect(a).toContain('url(#ink-hatch-visual-agent)');
    expect(b).toContain('id="ink-hatch-defect-agent"');
    // 两张图的 id 集合必须完全不相交
    const ids = (svg: string) => new Set([...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const [idsA, idsB] = [ids(a), ids(b)];
    expect(idsA.size).toBeGreaterThan(0);
    expect([...idsA].filter((id) => idsB.has(id))).toEqual([]);
    // 加后缀不能漏掉 dense 那一支（`#ink-hatch-dense` 以 `#ink-hatch` 开头，替换有先后坑）
    expect(a).not.toMatch(/url\(#ink-hatch(-dense)?\)/);
  });

  it('一张画同时成立于双主题：只用 currentColor 与 accent 变量，不写死颜色', () => {
    // 写死一个 hex 就意味着它在另一个主题下失效，也就重新需要 -light 副本——
    // 那正是这次要根除的东西。顺带把紫色挡在门外（首页三端不许发紫）。
    const offenders: string[] = [];
    for (const [key, art] of Object.entries(AGENT_CARD_ART)) {
      for (const m of art.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        // `#ink-hatch` 这类 id 引用不是颜色，正则已限定十六进制字符，这里只会命中真色值
        offenders.push(`${key}: ${m[0]}`);
      }
      for (const m of art.matchAll(/\brgba?\(/g)) offenders.push(`${key}: ${m[0]}`);
    }

    expect(offenders, ['插画里出现了写死的颜色，双主题会失效：', ...offenders].join('\n')).toEqual([]);
  });

  it('支持限制图片高度，为下部信息面板留出空间', () => {
    const html = renderToStaticMarkup(
      createElement(AgentCardArtwork, { agentKey: 'visual-agent', imageHeight: '57%' }),
    );

    expect(html).toContain('clip-path:inset(0 0 calc(100% - 57%) 0)');
  });

  it('动作那一笔恒为赭红，不吃外部类别色', () => {
    // 真机教训：把 INK_HUES 八色接到这一笔上，35 张画各响各的，整片就散了。
    // 判据盯两头——画里只引用 --accent-primary，组件也不再暴露注入口。
    for (const [key, art] of Object.entries(AGENT_CARD_ART)) {
      expect(art.includes('--agent-art-accent'), `${key} 又把类别色接进画里了`).toBe(false);
    }
    const html = renderToStaticMarkup(createElement(AgentCardArtwork, { agentKey: 'visual-agent' }));
    expect(html).not.toContain('--agent-art-accent');
    expect(html).not.toContain('agent-card-artwork-tint');
    expect(html).toContain('agent-card-artwork-wash');
    expect(html).toContain('agent-card-artwork-overlay');
  });

  it('画避开标题与标签条，不再让地平线从文字中间穿过去', () => {
    const html = renderToStaticMarkup(createElement(AgentCardArtwork, { agentKey: 'visual-agent' }));

    // 顶部安全区留给标题、底部留给标签条；两者都为 0 就是真机上那个「标题压在画上」的样子
    expect(html).toMatch(/top:34px/);
    expect(html).toMatch(/bottom:30px/);
    expect(html).not.toContain('agent-card-artwork-image absolute inset-0');
  });

  it('用共享契约区分紧凑遮罩，不在组件里判断明暗主题', () => {
    const html = renderToStaticMarkup(
      createElement(AgentCardArtwork, { agentKey: 'visual-agent', compact: true }),
    );

    expect(html).toContain('data-compact="true"');
    expect(html).toContain('agent-card-artwork-image');
    expect(html).toContain('<svg viewBox="0 0 320 200"');
    // 位图那条路必须彻底断掉，不是"暂时没人用"
    expect(html).not.toContain('background-image');
    expect(html).not.toContain('.webp');
    expect(html).not.toContain('data-theme');
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
