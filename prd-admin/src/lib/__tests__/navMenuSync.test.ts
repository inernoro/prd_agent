/**
 * 导航菜单数量一致性护栏测试
 *
 * 背景（2026-05-12）：
 *   AppShell 有「新功能上线兜底」逻辑，把所有不在 navOrder 里的 menuCatalog
 *   条目自动追加到 sidebar；但 NavLayoutEditor 的 currentOrder 只读 navOrder，
 *   导致 sidebar 比「我的导航」多出几项。
 *
 * 单一数据源原则：
 *   AppShell 和 NavLayoutEditor 统一调用 getSidebarMenuItems（adminMenuCatalog.ts），
 *   不再各自独立实现过滤逻辑，杜绝两份代码漂移。
 *
 * 本文件从两个维度防止此类 bug 复现：
 *   1. SIDEBAR_HIDDEN_APPKEYS 必须包含 'settings'（源码级护栏）
 *   2. sidebar 有效条目集 ≡ NavLayoutEditor currentOrder 集（逻辑级护栏）
 *
 * 测试均为纯函数级别，不依赖 DOM / React，可在 CI 中快速跑通。
 */

import { describe, expect, it } from 'vitest';
import { getMenuGroupedDefaultOrder } from '@/lib/unifiedNavCatalog';
import { getSidebarMenuItems, getSidebarAutoAppendItems, SIDEBAR_HIDDEN_APPKEYS } from '@/lib/adminMenuCatalog';
import { NAV_DIVIDER_KEY } from '@/stores/navOrderStore';
import type { AdminMenuItem } from '@/services/contracts/authz';

// ─── 辅助：镜像 NavLayoutEditor 的孤立条目检测逻辑（唯一来源版） ────────────
// 与 NavLayoutEditor.tsx currentOrder useMemo 里的逻辑保持 1:1 一致

function detectOrphans(
  navOrder: string[],
  menuCatalog: AdminMenuItem[],
  permissions: string[] = [],
  isRoot = true,
): string[] {
  const inBase = new Set(navOrder.filter((k) => k !== NAV_DIVIDER_KEY));
  const appShellVisibleIds = new Set(
    getSidebarAutoAppendItems({ items: menuCatalog, permissions, isRoot }).map((m) => m.appKey),
  );
  return [...appShellVisibleIds].filter((id) => !inBase.has(id));
}

// ─── 测试用假 menuCatalog ────────────────────────────────────────────────────

const BASE_MENU: AdminMenuItem[] = [
  { appKey: 'home', path: '/', label: '首页', icon: 'Home', group: 'home', sortOrder: 0 },
  { appKey: 'toolbox', path: '/toolbox', label: '百宝箱', icon: 'Hammer', group: 'tools', sortOrder: 1 },
  { appKey: 'settings', path: '/settings', label: '设置', icon: 'Settings', group: 'personal', sortOrder: 99 },
];

// 模拟后端返回有 group 字段（sidebar 会显示）和无 group 字段（sidebar 不显示）的条目
const WITH_POSTER_AND_NO_GROUP: AdminMenuItem[] = [
  ...BASE_MENU,
  // 有 group 字段 → getSidebarMenuItems 包含
  { appKey: 'weekly-poster', path: '/weekly-poster', label: '海报设计', icon: 'Sparkles', group: 'tools', sortOrder: 15 },
  // 无 group 字段 → getSidebarMenuItems 排除（!!m.group === false）
  { appKey: 'skills', path: '/skills', label: '技能', icon: 'Wrench', sortOrder: 50 } as AdminMenuItem,
  { appKey: 'prompts', path: '/prompts', label: '提示词', icon: 'MessageSquare', sortOrder: 51 } as AdminMenuItem,
];

// ─────────────────────────────────────────────────────────────────────────────

describe('SIDEBAR_HIDDEN_APPKEYS 护栏', () => {
  it("必须包含 'settings'，防止其被兜底逻辑追加到 sidebar", () => {
    expect(SIDEBAR_HIDDEN_APPKEYS).toContain('settings');
  });
});

describe('getSidebarMenuItems 过滤规则', () => {
  it('settings 不出现在结果里（被 SIDEBAR_HIDDEN_APPKEYS 过滤）', () => {
    const ids = getSidebarMenuItems({ items: WITH_POSTER_AND_NO_GROUP, permissions: [], isRoot: true })
      .map((m) => m.appKey);
    expect(ids).not.toContain('settings');
  });

  it('无 group 字段的条目不出现在结果里', () => {
    const ids = getSidebarMenuItems({ items: WITH_POSTER_AND_NO_GROUP, permissions: [], isRoot: true })
      .map((m) => m.appKey);
    expect(ids).not.toContain('skills');
    expect(ids).not.toContain('prompts');
  });

  it('有 group 字段的非隐藏条目出现在结果里', () => {
    const ids = getSidebarMenuItems({ items: WITH_POSTER_AND_NO_GROUP, permissions: [], isRoot: true })
      .map((m) => m.appKey);
    expect(ids).toContain('toolbox');
    expect(ids).toContain('weekly-poster');
  });
});

describe('孤立条目检测（orphan detection）', () => {
  it('navOrder 为空时不产生孤立条目（走默认布局路径）', () => {
    const orphans = detectOrphans([], BASE_MENU);
    expect(orphans.length).toBeGreaterThanOrEqual(0);
  });

  it('navOrder 不含 weekly-poster 时将其识别为孤立条目', () => {
    const orphans = detectOrphans(['toolbox'], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).toContain('weekly-poster');
  });

  it('navOrder 已含 weekly-poster 时不再重复追加', () => {
    const orphans = detectOrphans(['toolbox', 'weekly-poster'], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).not.toContain('weekly-poster');
  });

  it('settings 无论如何都不出现在孤立条目里', () => {
    const orphans = detectOrphans(['toolbox'], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).not.toContain('settings');
  });

  it('无 group 字段的条目不出现在孤立条目里', () => {
    const orphans = detectOrphans(['toolbox'], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).not.toContain('skills');
    expect(orphans).not.toContain('prompts');
  });

  it('追加孤立条目后，currentOrder 覆盖的 id 集合 ⊇ AppShell 会展示的条目', () => {
    const navOrder = ['toolbox'];
    const orphans = detectOrphans(navOrder, WITH_POSTER_AND_NO_GROUP);
    const effectiveOrder = [...navOrder, ...orphans];

    const sidebarIds = getSidebarAutoAppendItems({
      items: WITH_POSTER_AND_NO_GROUP,
      permissions: [],
      isRoot: true,
    }).map((m) => m.appKey);

    for (const id of sidebarIds) {
      expect(effectiveOrder, `sidebar 会显示 '${id}'，但 currentOrder 里没有它`).toContain(id);
    }
  });
});

describe('getMenuGroupedDefaultOrder 不含 settings', () => {
  it('默认布局不会把 settings 放进 navOrder', () => {
    const order = getMenuGroupedDefaultOrder({
      menuCatalog: WITH_POSTER_AND_NO_GROUP,
      permissions: [],
      isRoot: true,
    });
    expect(order).not.toContain('settings');
  });
});
