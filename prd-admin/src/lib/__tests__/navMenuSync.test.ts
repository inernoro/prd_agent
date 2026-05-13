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
 * 本文件防止此类 bug 复现：
 *   sidebar 有效条目集 ≡ NavLayoutEditor currentOrder 集（逻辑级护栏）
 *
 * 测试均为纯函数级别，不依赖 DOM / React，可在 CI 中快速跑通。
 */

import { describe, expect, it } from 'vitest';
import { getMenuGroupedDefaultOrder, DEFAULT_NAV_ORDER } from '@/lib/unifiedNavCatalog';
import { getSidebarMenuItems, getSidebarAutoAppendItems, SIDEBAR_HIDDEN_APPKEYS } from '@/lib/adminMenuCatalog';
import { NAV_DIVIDER_KEY } from '@/stores/navOrderStore';
import type { AdminMenuItem } from '@/services/contracts/authz';

// ─── 辅助：镜像 NavLayoutEditor 的孤立条目检测逻辑（唯一来源版） ────────────
// 与 NavLayoutEditor.tsx currentOrder useMemo 里的逻辑保持 1:1 一致

function detectOrphans(
  navOrder: string[],
  menuCatalog: AdminMenuItem[],
  navHidden: string[] = [],
  fallbackNavHidden: string[] = [],
  fallbackNavOrder: string[] = [],
  permissions: string[] = [],
  isRoot = true,
): string[] {
  // 镜像 NavLayoutEditor currentOrder useMemo：无守卫条件，始终执行孤立检测
  const base = (() => {
    if (navOrder.length > 0) return navOrder;
    if (fallbackNavOrder.length > 0) return fallbackNavOrder;
    return getMenuGroupedDefaultOrder({ menuCatalog, permissions, isRoot });
  })();
  const inBase = new Set(base.filter((k) => k !== NAV_DIVIDER_KEY));
  const effectiveHidden = new Set([...navHidden, ...fallbackNavHidden]);
  const appShellVisibleIds = new Set(
    getSidebarAutoAppendItems({ items: menuCatalog, permissions, isRoot }).map((m) => m.appKey),
  );
  return [...appShellVisibleIds].filter((id) => !inBase.has(id) && !effectiveHidden.has(id));
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
  it("不包含 'settings'，settings 是普通导航条目，可出现在 sidebar", () => {
    expect(SIDEBAR_HIDDEN_APPKEYS.has('settings')).toBe(false);
  });
});

describe('getSidebarMenuItems 过滤规则', () => {
  it('settings 出现在结果里（普通导航条目，不再被过滤）', () => {
    const ids = getSidebarMenuItems({ items: WITH_POSTER_AND_NO_GROUP, permissions: [], isRoot: true })
      .map((m) => m.appKey);
    expect(ids).toContain('settings');
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
  it('navOrder 为空时不产生孤立条目（getMenuGroupedDefaultOrder 已覆盖所有侧边栏条目）', () => {
    // BASE_MENU 中 toolbox 和 settings 是侧边栏条目（isRoot=true 还会注入 weekly-poster）；
    // getMenuGroupedDefaultOrder 将全部纳入 base，inBase 覆盖 appShellVisibleIds → 孤立集合为空
    const orphans = detectOrphans([], BASE_MENU);
    expect(orphans).toHaveLength(0);
  });

  it('navOrder 不含 weekly-poster 时将其识别为孤立条目', () => {
    const orphans = detectOrphans(['toolbox'], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).toContain('weekly-poster');
  });

  it('navOrder 已含 weekly-poster 时不再重复追加', () => {
    const orphans = detectOrphans(['toolbox', 'weekly-poster'], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).not.toContain('weekly-poster');
  });

  it('settings 若不在 navOrder 中会被识别为孤立条目（与普通菜单条目行为一致）', () => {
    const orphans = detectOrphans(['toolbox'], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).toContain('settings');
  });

  it('home 条目不出现在孤立条目里（group=home 被 getSidebarAutoAppendItems 排除）', () => {
    const orphans = detectOrphans(['toolbox'], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).not.toContain('home');
  });

  it('无 group 字段的条目不出现在孤立条目里', () => {
    const orphans = detectOrphans(['toolbox'], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).not.toContain('skills');
    expect(orphans).not.toContain('prompts');
  });

  it('用户已隐藏的条目不被重新追加（navHidden 优先）', () => {
    // 用户隐藏了 weekly-poster，navOrder 里也没有它
    const orphans = detectOrphans(['toolbox'], WITH_POSTER_AND_NO_GROUP, ['weekly-poster']);
    expect(orphans).not.toContain('weekly-poster');
  });

  it('fallbackNavHidden 同样生效', () => {
    const orphans = detectOrphans(['toolbox'], WITH_POSTER_AND_NO_GROUP, [], ['weekly-poster']);
    expect(orphans).not.toContain('weekly-poster');
  });

  it('navOrder 为空但 fallbackNavOrder 非空时，同样触发孤立检测', () => {
    // fallbackNavOrder 只含 toolbox，weekly-poster 是新上线条目 → 应识别为孤立
    const orphans = detectOrphans([], WITH_POSTER_AND_NO_GROUP, [], [], ['toolbox']);
    expect(orphans).toContain('weekly-poster');
  });

  it('navOrder 和 fallbackNavOrder 均为空时，getMenuGroupedDefaultOrder 已涵盖全部侧边栏条目，孤立检测返回空', () => {
    // getMenuGroupedDefaultOrder 现在把侧边栏可见但不在 DEFAULT_NAV_ORDER 的条目
    // 也插入对应组段——toolbox/weekly-poster 均被纳入 base，无孤立条目
    const orphans = detectOrphans([], WITH_POSTER_AND_NO_GROUP);
    expect(orphans).toHaveLength(0);
  });

  it('追加孤立条目后，currentOrder 覆盖的 id 集合 ⊇ AppShell 会展示的非隐藏条目', () => {
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

describe('DEFAULT_NAV_ORDER 硬编码默认顺序', () => {
  it('包含预期的核心条目', () => {
    expect(DEFAULT_NAV_ORDER).toContain('ai-toolbox');
    expect(DEFAULT_NAV_ORDER).toContain('workflow-agent');
    expect(DEFAULT_NAV_ORDER).toContain('executive');
    expect(DEFAULT_NAV_ORDER).toContain('marketplace');
    expect(DEFAULT_NAV_ORDER).toContain('my-assets');
    expect(DEFAULT_NAV_ORDER).toContain('emergence');
    expect(DEFAULT_NAV_ORDER).toContain('mds');
    expect(DEFAULT_NAV_ORDER).toContain('users');
    expect(DEFAULT_NAV_ORDER).toContain('document-store');
    expect(DEFAULT_NAV_ORDER).toContain('web-pages');
  });

  it('包含 settings（settings 是正常导航条目，出现在 admin 组段末尾）', () => {
    expect(DEFAULT_NAV_ORDER).toContain('settings');
  });

  it('不包含 home（home 固定在侧栏顶部，不参与 navOrder）', () => {
    expect(DEFAULT_NAV_ORDER).not.toContain('home');
  });

  it('包含分隔符将条目分为三组', () => {
    const dividerCount = DEFAULT_NAV_ORDER.filter((k) => k === NAV_DIVIDER_KEY).length;
    expect(dividerCount).toBe(2);
  });

  it('分隔符不在首尾，且无连续分隔符', () => {
    expect(DEFAULT_NAV_ORDER[0]).not.toBe(NAV_DIVIDER_KEY);
    expect(DEFAULT_NAV_ORDER[DEFAULT_NAV_ORDER.length - 1]).not.toBe(NAV_DIVIDER_KEY);
    for (let i = 1; i < DEFAULT_NAV_ORDER.length; i++) {
      if (DEFAULT_NAV_ORDER[i] === NAV_DIVIDER_KEY) {
        expect(DEFAULT_NAV_ORDER[i - 1]).not.toBe(NAV_DIVIDER_KEY);
      }
    }
  });
});

describe('getMenuGroupedDefaultOrder 基于硬编码顺序过滤', () => {
  it('只返回用户有权访问的侧边栏条目', () => {
    // isRoot=false + 无权限 → weekly-poster 不注入，BASE_MENU 中 toolbox 和 settings 是侧边栏条目
    // home(group='home') 不参与导航
    const order = getMenuGroupedDefaultOrder({
      menuCatalog: BASE_MENU,
      permissions: [],
      isRoot: false,
    });
    expect(order).toContain('toolbox');
    expect(order).toContain('settings');
    expect(order).not.toContain('home');
    expect(order).not.toContain('weekly-poster');
  });

  it('包含 settings（settings 是普通导航条目）', () => {
    const order = getMenuGroupedDefaultOrder({
      menuCatalog: WITH_POSTER_AND_NO_GROUP,
      permissions: [],
      isRoot: true,
    });
    expect(order).toContain('settings');
  });

  it('结果无连续分隔符、无首尾分隔符', () => {
    // 构造含 DEFAULT_NAV_ORDER 中部分 appKey 的 catalog
    const partialCatalog: AdminMenuItem[] = [
      { appKey: 'ai-toolbox', path: '/ai-toolbox', label: '百宝箱', icon: 'Sparkles', group: 'tools', sortOrder: 10 },
      { appKey: 'mds', path: '/mds', label: '模型', icon: 'Cpu', group: 'admin', sortOrder: 50 },
    ];
    const order = getMenuGroupedDefaultOrder({ menuCatalog: partialCatalog, permissions: [], isRoot: true });
    if (order.length > 0) {
      expect(order[0]).not.toBe(NAV_DIVIDER_KEY);
      expect(order[order.length - 1]).not.toBe(NAV_DIVIDER_KEY);
    }
    for (let i = 1; i < order.length; i++) {
      if (order[i] === NAV_DIVIDER_KEY) {
        expect(order[i - 1]).not.toBe(NAV_DIVIDER_KEY);
      }
    }
  });

  it('不在 DEFAULT_NAV_ORDER 的条目按 sortOrder 插入段内正确位置，而非追加到末尾', () => {
    // weekly-poster sortOrder:15 应插入到 ai-toolbox(10) 和 workflow-agent(20) 之间
    const catalogWithExtra: AdminMenuItem[] = [
      { appKey: 'ai-toolbox', path: '/ai-toolbox', label: '百宝箱', icon: 'Sparkles', group: 'tools', sortOrder: 10 },
      { appKey: 'workflow-agent', path: '/workflow-agent', label: '工作流', icon: 'Workflow', group: 'tools', sortOrder: 20 },
      { appKey: 'executive', path: '/executive', label: '洞察', icon: 'BarChart3', group: 'tools', sortOrder: 25 },
      // weekly-poster 不在 DEFAULT_NAV_ORDER，sortOrder:15 应在 ai-toolbox 和 workflow-agent 之间
      { appKey: 'weekly-poster', path: '/weekly-poster', label: '海报', icon: 'Sparkles', group: 'tools', sortOrder: 15 },
    ];
    // isRoot=false 避免 getAugmentedAdminMenuCatalog 注入第二个 weekly-poster
    const order = getMenuGroupedDefaultOrder({ menuCatalog: catalogWithExtra, permissions: [], isRoot: false });
    const wpIdx = order.indexOf('weekly-poster');
    expect(wpIdx).toBeGreaterThan(order.indexOf('ai-toolbox'));
    expect(wpIdx).toBeLessThan(order.indexOf('workflow-agent'));
  });

  it('相邻组之间保留一个分隔符', () => {
    const mixedCatalog: AdminMenuItem[] = [
      { appKey: 'ai-toolbox', path: '/ai-toolbox', label: '百宝箱', icon: 'Sparkles', group: 'tools', sortOrder: 10 },
      { appKey: 'mds', path: '/mds', label: '模型', icon: 'Cpu', group: 'admin', sortOrder: 50 },
    ];
    // isRoot=false → weekly-poster 不自动注入，结果只含 ai-toolbox 和 mds
    const order = getMenuGroupedDefaultOrder({ menuCatalog: mixedCatalog, permissions: [], isRoot: false });
    // ai-toolbox(tools 组) 和 mds(admin 组) 之间恰好一个分隔符
    const dividerCount = order.filter((k) => k === NAV_DIVIDER_KEY).length;
    expect(dividerCount).toBe(1);
    expect(order).toEqual(['ai-toolbox', NAV_DIVIDER_KEY, 'mds']);
  });
});
