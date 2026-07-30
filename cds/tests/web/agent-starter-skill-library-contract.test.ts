import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.join(process.cwd(), 'web/src/components/AgentStarterTab.tsx'),
  'utf8',
);
const styles = fs.readFileSync(path.join(process.cwd(), 'web/src/index.css'), 'utf8');

describe('Agent 上手助手技能库契约', () => {
  it('默认只展示角色推荐，不把完整技能库一次铺满', () => {
    expect(source).toContain('skill.recommendedRoles.includes(roleId)');
    expect(source).toContain('.slice(0, 6)');
    expect(source).toContain('recommendedSkills');
  });

  it('用户可以主动进入分组技能库并返回推荐结果', () => {
    expect(source).toContain('选择更多技能（共 ${availableSkills.length} 项）');
    expect(source).toContain("role=\"tablist\"");
    expect(source).toContain('activeSkillGroup');
    expect(source).toContain('返回角色推荐');
  });

  it('技能库只在助手内部滚动，不拉长整个页面', () => {
    expect(source).toContain('overflow-y-auto');
    expect(source).toContain('overflow-hidden');
  });

  it('只有打开的上手助手弹窗才能隐藏全局入口和锁定页面滚动', () => {
    const openDialogSelector = "body:has([role='dialog'][data-state='open'] [data-agent-starter='true'])";
    expect(styles.match(new RegExp(openDialogSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBe(3);
    expect(styles).not.toContain("body:has([data-agent-starter='true'])");
  });

  it('手机端隐藏总导航后让逐步选择内容填满弹窗', () => {
    expect(styles).toContain("[role='dialog']:has([data-agent-starter='true']) > div:first-child");
    expect(styles).toContain('flex: 1 1 auto !important;');
    expect(styles).toContain('min-height: 0 !important;');
  });
});
