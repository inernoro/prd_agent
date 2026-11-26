import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import menuIntents from '../../../.claude/skills/cds/reference/menu-intents.json';
import { designBuildPrompt, lifecycle, SkillGuide } from '../../web/src/pages/design-workspace/SkillGuide';

describe('设计页技能指南', () => {
  it('使用同一技能路由表的六个开发环节', () => {
    const examples = new Set(menuIntents.menus.flatMap(menu => menu.intents.flatMap(intent => intent.say)));
    expect(lifecycle.map(step => step.stage)).toEqual(['规划', '设计', '实现', '验收', '发布', '监控']);
    for (const step of lifecycle) expect(examples.has(step.say.slice('/cds '.length))).toBe(true);
    expect(lifecycle.find(step => step.key === 'design')?.steps.join(' ')).toContain('G-01 至 G-11');
    expect(lifecycle.find(step => step.key === 'build')?.steps[0]).toMatch(/有权评审人.*实施基线.*升级目标/);
    const html = renderToStaticMarkup(createElement(SkillGuide, { onAccess() {} }));
    expect(html.match(/<h5>/g)).toHaveLength(4);
    expect(html).toContain('aria-label="示例结果"');
    expect(html).toContain('接入 Agent');
  });

  it('交接指南使用获准的实现版本，验收和续版仍引用正在查看的版本', () => {
    const designId = 'DSN-FIXTURE';
    const buildPrompt = designBuildPrompt({ id: designId, projectId: 'fixture-project', frozen: 4 });
    const html = renderToStaticMarkup(createElement(SkillGuide, { designId, version: 7, buildPrompt }));
    expect(html).toContain('/cds-build 帮我实现 DSN-FIXTURE V4');
    expect(html).toContain('/cds 跑 DSN-FIXTURE V7 的验收');
    expect(html).toContain('/cds 改 DSN-FIXTURE V7 的设计');
    expect(html.match(/data-action="copy-skill"/g)).toHaveLength(3);
  });
});
