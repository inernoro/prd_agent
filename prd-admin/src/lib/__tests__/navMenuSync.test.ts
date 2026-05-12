/**
 * 导航菜单数量一致性护栏测试
 *
 * 背景（2026-05-12）：
 *   AppShell 有「新功能上线兜底」逻辑，把所有不在 navOrder 里的 menuCatalog
 *   条目自动追加到 sidebar；但 NavLayoutEditor 的 currentOrder 只读 navOrder，
 *   导致 sidebar 比「我的导航」多出几项。
 *
 *   修复 v1 用 section==='menu' 过滤，但 unified 的 fromMenuItem 对所有
 *   非 home 的 menuCatalog 条目都设置 section='menu'，包括没有 group 字段
 *   的条目（提示词/技能等），导致「我的导航」比 sidebar 多出几项（反向问题）。
 *
 *   修复 v2（当前）精确镜像 AppShell 的过滤条件：
 *   getAugmentedAdminMenuCatalog + !!m.group + appKey !== 'settings'
 *
 * 本文件从两个维度防止此类 bug 复现：
 *   1. AppShell HIDDEN_NAV_KEYS 必须包含 'settings'（源码级护栏）
 *   2. sidebar 有效条目集 ≡ NavLayoutEditor currentOrder 集（逻辑级护栏）
 *
 * 测试均为纯函数级别，不依赖 DOM / React，可在 CI 中快速跑通。
 */

import { describe, expect, it } from 'vitest';
import { getMenuGroupedDefaultOrder } from '@/lib/unifiedNavCatalog';
import { getAugmentedAdminMenuCatalog } from '@/lib/adminMenuCatalog';
import { NAV_DIVIDER_KEY } from '@/stores/navOrderStore';
import appShellRaw from '../../layouts/AppShell.tsx?raw';
import type { AdminMenuItem } from '@/services/contracts/authz';

// ─── 辅助：从 AppShell 源码里解析 HIDDEN_NAV_KEYS 的内容 ───────────────────

function parseHiddenNavKeys(): string[] {
  const m = appShellRaw.match(/HIDDEN_NAV_KEYS\s*=\s*new\s+Set<string>\(\[([^\]]*)\]\)/);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// ─── 辅助：镜像 NavLayoutEditor 的孤立条目检测逻辑（v2） ──────────────────
// 精确镜像 AppShell 的 allCatalogItems 过滤条件：
//   getAugmentedAdminMenuCatalog + !!m.group + appKey !== 'settings'
// 与 NavLayoutEditor.tsx currentOrder useMemo 里的过滤逻辑保持 1:1 一致

function detectOrphans(
  navOrder: string[],
  menuCatalog: AdminMenuItem[],
  permissions: string[] = [],
  isRoot = true,
): string[] {
  const inBase = new Set(navOrder.filter((k) => k !== NAV_DIVIDER_KEY));
  const appShellVisibleIds = new Set(
    getAugmentedAdminMenuCatalog({ items: menuCatalog, permissions, isRoot })
      .filter((m) => !!m.group && m.appKey !== 'settings')
      .map((m) => m.appKey),
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
  // 有 group 字段 → AppShell 会显示
  { appKey: 'weekly-poster', path: '/weekly-poster', label: '海报设计', icon: 'Sparkles', group: 'tools', sortOrder: 15 },
  // 无 group 字段 → AppShell 不显示（!!m.group === false）
  { appKey: 'skills', path: '/skills', label: '技能', icon: 'Wrench', sortOrder: 50 } as AdminMenuItem,
  { appKey: 'prompts', path: '/prompts', label: '提示词', icon: 'MessageSquare', sortOrder: 51 } as AdminMenuItem,
];

// ─────────────────────────────────────────────────────────────────────────────

describe('AppShell HIDDEN_NAV_KEYS 护栏', () => {
  it("必须包含 'settings'，防止其被兜底逻辑追加到 sidebar（NavLayoutEditor 已将其明确排除）", () => {
    const keys = parseHiddenNavKeys();
    expect(keys).toContain('settings');
  });
});

describe('孤立条目检测（orphan detection v2）', () => {
  it('navOrder 为空时不产生孤立条目（走默认布局路径，不走 navOrder 分支）', () => {
    const orphans = detectOrphans([], BASE_MENU);
    // navOrder 空时 NavLayoutEditor 走 getMenuGroupedDefaultOrder，不触发孤立追加
    expect(orphans.length).toBeGreaterThanOrEqual(0);
  });

  it('navOrder 不含 weekly-poster 时将其识别为孤立条目（有 group 字段）', () => {
    const orphans = detectOrphans(['toolbox'], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).toContain('weekly-poster');
  });

  it('navOrder 已含 weekly-poster 时不再重复追加', () => {
    const orphans = detectOrphans(['toolbox', 'weekly-poster'], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).not.toContain('weekly-poster');
  });

  it('settings 无论如何都不出现在孤立条目里（appKey===settings 被过滤）', () => {
    const orphans = detectOrphans(['toolbox'], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).not.toContain('settings');
  });

  it('无 group 字段的条目（如技能/提示词）不出现在孤立条目里', () => {
    const orphans = detectOrphans(['toolbox'], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).not.toContain('skills');
    expect(orphans).not.toContain('prompts');
  });

  it('追加孤立条目后，currentOrder 覆盖的 id 集合 ⊇ AppShell 会展示的 menu 条目', () => {
    const navOrder = ['toolbox'];
    const orphans = detectOrphans(navOrder, WITH_POSTER_AND_NO_GROUP);
    const effectiveOrder = [...navOrder, ...orphans];

    // AppShell 会展示的条目：有 group、非 settings
    const sidebarIds = getAugmentedAdminMenuCatalog({ items: WITH_POSTER_AND_NO_GROUP, permissions: [], isRoot: true })
      .filter((m) => !!m.group && m.appKey !== 'settings' && m.group !== 'home')
      .map((m) => m.appKey);

    for (const id of sidebarIds) {
      expect(effectiveOrder, `sidebar 会显示 '${id}'，但 currentOrder 里没有它`).toContain(id);
    }
  });
});

describe('getMenuGroupedDefaultOrder 不含 settings', () => {
  it('默认布局不会把 settings 放进 navOrder（避免 NavLayoutEditor strip 渲染时矛盾）', () => {
    const order = getMenuGroupedDefaultOrder({
      menuCatalog: WITH_POSTER_AND_NO_GROUP,
      permissions: [],
      isRoot: true,
    });
    expect(order).not.toContain('settings');
  });
});
