import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import menuIntents from '../../../.claude/skills/cds/reference/menu-intents.json';
import { designHandoffPrompts, lifecycle, SkillGuide } from '../../web/src/pages/design-workspace/SkillGuide';

describe('设计页技能指南', () => {
  it('使用同一技能路由表的六个开发环节', () => {
    const examples = new Set(menuIntents.menus.flatMap(menu => menu.intents.flatMap(intent => intent.say)));
    expect(lifecycle.map(step => step.stage)).toEqual(['规划', '设计', '实现', '验收', '发布', '监控']);
    for (const step of lifecycle) expect(examples.has(step.say.slice('/cds '.length))).toBe(true);
    const html = renderToStaticMarkup(createElement(SkillGuide, { onAccess() {} }));
    expect(html.match(/<h5>/g)).toHaveLength(4);
    expect(html).toContain('aria-label="示例结果"');
    expect(html).toContain('接入 Agent');
  });

  it('交接指令锁定实际稿件和用户正在查看的版本', () => {
    const steps = designHandoffPrompts('DSN-FIXTURE', 7);
    expect(steps.map(step => step.say)).toEqual([
      '/cds 帮我实现 DSN-FIXTURE V7', '/cds 跑 DSN-FIXTURE V7 的验收', '/cds 改 DSN-FIXTURE V7 的设计',
    ]);
    const html = renderToStaticMarkup(createElement(SkillGuide, { designId: 'DSN-FIXTURE', version: 7 }));
    expect(html.match(/data-action="copy-skill"/g)).toHaveLength(3);
  });
});
