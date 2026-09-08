import { describe, expect, it } from 'vitest';
import { buildStaticUtilities, deriveLauncherPerms } from '@/lib/homeLauncherItems';
import { getLauncherCatalog } from '@/lib/launcherCatalog';
import { MOBILE_DRAWER_UTILITY_ROUTES, resolveMobileDrawerUtilities } from '@/lib/mobileDrawerUtilities';
import appShellSource from '../../layouts/AppShell.tsx?raw';

/**
 * #1479：授权健康中心页能打开，但桌面首页搜索与移动抽屉都找不到它。
 *
 * 两条入口各守一条判据：
 *   - 首页搜索读的是 buildStaticUtilities（不是 NAV_REGISTRY），所以要在这份清单里能按名字命中；
 *   - 移动抽屉默认只画后端 menuCatalog 带 group 的项，实用工具靠抽屉底部的直达清单，
 *     清单条目必须从 launcherCatalog（NAV_REGISTRY 派生、已按权限过滤）取出来。
 */

/** 与 AgentLauncherPage.searchResults 同一个匹配口径：名字 / 描述 / 标签任一命中 */
function matchesQuery(item: { name: string; description: string; tags: string[] }, query: string) {
  const q = query.toLowerCase();
  return item.name.toLowerCase().includes(q)
    || item.description.toLowerCase().includes(q)
    || item.tags.some((t) => t.toLowerCase().includes(q));
}

describe('授权健康中心 · 桌面首页搜索', () => {
  it('有 logs.read 的用户搜「授权健康」能命中唯一入口', () => {
    const items = buildStaticUtilities(deriveLauncherPerms(['access', 'logs.read']));
    const hits = items.filter((it) => matchesQuery(it, '授权健康'));
    expect(hits.map((it) => it.routePath)).toEqual(['/authorization-health']);
    expect(hits[0].name).toBe('授权健康中心');
  });

  it('权限门与 navRegistry 一致：没有 logs.read 就不出现', () => {
    const items = buildStaticUtilities(deriveLauncherPerms(['access']));
    expect(items.some((it) => it.routePath === '/authorization-health')).toBe(false);
  });

  it('super 与 root 同路由守卫一样是万能钥匙：没有字面 logs.read 也能搜到 (Codex P2)', () => {
    const viaSuper = buildStaticUtilities(deriveLauncherPerms(['access', 'super']));
    expect(viaSuper.some((it) => it.routePath === '/authorization-health')).toBe(true);
    const viaRoot = buildStaticUtilities(deriveLauncherPerms(['access'], true));
    expect(viaRoot.some((it) => it.routePath === '/authorization-health')).toBe(true);
  });
});

describe('授权健康中心 · 移动抽屉直达', () => {
  it('直达清单登记了授权健康中心', () => {
    expect(MOBILE_DRAWER_UTILITY_ROUTES.map((r) => r.route)).toContain('/authorization-health');
  });

  it('条目从 launcherCatalog 取，且按权限过滤', () => {
    const withLogs = resolveMobileDrawerUtilities(getLauncherCatalog({ permissions: ['access', 'logs.read'], isRoot: false }));
    expect(withLogs.map((u) => u.route)).toEqual(['/mcp-console', '/authorization-health']);
    const auth = withLogs.find((u) => u.route === '/authorization-health')!;
    expect(auth.item.name).toBe('授权健康中心');
    expect(auth.item.icon).toBeTruthy();

    const withoutLogs = resolveMobileDrawerUtilities(getLauncherCatalog({ permissions: ['access'], isRoot: false }));
    expect(withoutLogs.map((u) => u.route)).toEqual(['/mcp-console']);
  });

  it('AppShell 的抽屉真的在渲染这份清单（接线守卫，删掉不会红的那种）', () => {
    expect(appShellSource).toContain("from '@/lib/mobileDrawerUtilities'");
    expect(appShellSource).toMatch(/mobileDrawerUtilities\.map\(/);
    // 之前的写法是抽屉里手写一个 /mcp-console 按钮；改成清单驱动后不该再回到手写
    expect(appShellSource).not.toMatch(/navigate\('\/mcp-console'\); setMobileDrawerOpen\(false\)/);
  });
});
