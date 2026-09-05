import { describe, expect, it } from 'vitest';
import { buildEffectiveNavOrder } from '@/lib/navEffectiveOrder';

/**
 * 守卫：全员导航总览每一行必须等于该用户侧栏真实渲染的那一列。
 * 2026-09-05 用户反馈「只覆盖了一部分」：沿用默认的人侧栏里有网页 / 知识库 / 海报 / VOC，
 * 总览只画了默认顺序里的九项——因为没复演 AppShell 的「目录里有、顺序里没有 → 自动补到末尾」。
 */
describe('buildEffectiveNavOrder', () => {
  const sidebar = ['ai-toolbox', 'workflow-agent', 'marketplace', 'web-pages', 'document-store', 'users', 'settings'];

  it('顺序里没有但侧栏可见的目录项被追加到末尾，并标记 auto', () => {
    const out = buildEffectiveNavOrder({ order: ['ai-toolbox', '---', 'users', 'settings'], hidden: [], sidebarIds: sidebar });
    expect(out.map((e) => e.token)).toEqual(['ai-toolbox', '---', 'users', 'settings', 'workflow-agent', 'marketplace', 'web-pages', 'document-store']);
    expect(out.filter((e) => e.auto).map((e) => e.id)).toEqual(['workflow-agent', 'marketplace', 'web-pages', 'document-store']);
  });

  it('被隐藏的项既不出现在顺序里也不会被自动补回', () => {
    const out = buildEffectiveNavOrder({ order: ['ai-toolbox', 'web-pages'], hidden: ['web-pages', 'users'], sidebarIds: sidebar });
    expect(out.map((e) => e.id)).not.toContain('web-pages');
    expect(out.map((e) => e.id)).not.toContain('users');
  });

  it('旧前缀 id 按迁移后的 id 去重，不会被再追加一次', () => {
    const out = buildEffectiveNavOrder({ order: ['utility:emergence'], hidden: [], sidebarIds: ['emergence', 'users'] });
    expect(out.map((e) => e.token)).toEqual(['utility:emergence', 'users']);
    expect(out[0].id).toBe('emergence');
  });

  it('目录里已不存在的 token 原样保留在原位（总览要把它标成红框）', () => {
    const out = buildEffectiveNavOrder({ order: ['ai-toolbox', 'mds', 'users'], hidden: [], sidebarIds: ['ai-toolbox', 'users'] });
    expect(out.map((e) => e.token)).toEqual(['ai-toolbox', 'mds', 'users']);
  });
});
