/**
 * 导航覆盖率护栏测试（v7 重构后）
 *
 * 数据流：
 *   NAV_REGISTRY (单一数据源)
 *     ├─ App.tsx 的 <Routes> 通过 .map() 渲染
 *     └─ launcherCatalog 通过 buildFromRegistry() 派生
 *
 * 本测试做两件事：
 *   1. 校验 NAV_REGISTRY 元数据完整（path 唯一、shortLabel ≤ 4 字、icon 非空）
 *   2. 校验 App.tsx 内剩余的 JSX `<Route>` 都在 ALLOW_LIST（login/share/dev/sub-route/admin-menu）
 *
 * 这样就保证：加新功能 = 在 NAV_REGISTRY 写一个 entry，App.tsx + launcherCatalog
 * 都自动同步，CI 不会报错。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV_REGISTRY, navIdFromPath } from '@/app/navRegistry';
import { getLauncherCatalog, findLauncherItem } from '@/lib/launcherCatalog';
import { QUICK_LINK_BY_ID } from '@/pages/AgentLauncherPage';
import appTsxRaw from '../../app/App.tsx?raw';
import launcherSource from '../../pages/AgentLauncherPage.tsx?raw';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 不通过 NAV_REGISTRY 注册、但在 App.tsx 直接写 <Route> 的路由白名单。
 * 每条都要有原因——reviewer 看到能问"为什么不能放 NAV_REGISTRY"。
 */
const ALLOW_LIST: Record<string, string> = {
  // ── 公共路由 ──
  '/': '首页 IndexPage（站点根，固定栏顶不参与可定制）',
  '/home': '首页移动版别名',
  '/login': '登录页（未鉴权状态）',
  '/agent-launcher': '首页浮层入口',

  // ── 全屏非 nav ──
  '/visual-agent-fullscreen': '视觉创作旧路径兼容',
  '/showcase': '作品广场（演示用）',

  // ── 移动端专用 ──
  '/profile': '移动端个人资料',
  '/notifications': '移动端通知',
  '/daily-post': '米多早报（首页副页面，从首页推广行进入，不参与可定制导航）',

  // ── 已废弃 / Redirect ──
  '/prd-agent': 'Web 端已下线，重定向到首页',
  '/stats': '已废弃 redirect 到 /',

  // ── 后端 menuCatalog 注册的入口（admin 类，由 backend 注入「其他菜单」分组）──
  '/executive': '总裁面板',
  '/assets': '素材管理 admin',
  '/skills': '技能管理 admin',
  '/data-transfers': '数据迁移 admin',
  '/weekly-poster': '海报设计（augmenter 注入）',
  '/ai-toolbox': '百宝箱聚合页',
  '/settings': '设置（栏顶固定，不参与可定制）',
};

/** 从 App.tsx 提取所有 <Route path="X"> 字符串字面量路径 */
function parseLiteralRoutesFromAppTsx(): string[] {
  const matches = [...appTsxRaw.matchAll(/<Route\s+(?:[^>]*?\s+)?path=["'`]([^"'`]+)["'`]/g)];
  const routes = matches.map((m) => m[1]).map((p) => (p.startsWith('/') ? p : '/' + p));
  return [...new Set(routes)];
}

/** 参数化 / 通配 / 子路由（自动豁免 ALLOW_LIST 检查） */
function isParameterizedOrSubRoute(route: string): boolean {
  if (route.includes(':')) return true;
  if (route.includes('*')) return true;
  if (route.startsWith('/_dev/')) return true;
  if (route.startsWith('/s/')) return true;
  if (route.startsWith('/shared/')) return true;
  if (route.startsWith('/u/')) return true;
  // 子路由：路径深度 > 1
  return route.split('/').filter(Boolean).length > 1;
}

describe('NAV_REGISTRY 元数据校验', () => {
  it('每个 entry 的 path 唯一', () => {
    const seen = new Map<string, number>();
    for (const e of NAV_REGISTRY) {
      seen.set(e.path, (seen.get(e.path) ?? 0) + 1);
    }
    const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p);
    expect(dup, `发现重复 path: ${dup.join(', ')}`).toEqual([]);
  });

  it('nav.shortLabel 都不超过 4 字', () => {
    const tooLong = NAV_REGISTRY.filter((e) => e.nav && [...e.nav.shortLabel].length > 4).map(
      (e) => `${e.path} → "${e.nav!.shortLabel}"`,
    );
    expect(tooLong, `shortLabel 超过 4 字会被截断:\n${tooLong.join('\n')}`).toEqual([]);
  });

  it('nav.icon 非空', () => {
    const noIcon = NAV_REGISTRY.filter((e) => e.nav && !e.nav.icon).map((e) => e.path);
    expect(noIcon, `缺 icon: ${noIcon.join(', ')}`).toEqual([]);
  });

  it('path 必须以 "/" 开头', () => {
    const bad = NAV_REGISTRY.filter((e) => !e.path.startsWith('/')).map((e) => e.path);
    expect(bad, `path 必须以 "/" 开头: ${bad.join(', ')}`).toEqual([]);
  });
});

describe('App.tsx 路由覆盖', () => {
  it('App.tsx 中字符串字面量路径都在 ALLOW_LIST 或是参数化子路由', () => {
    const literalRoutes = parseLiteralRoutesFromAppTsx();
    const registryPaths = new Set(NAV_REGISTRY.map((e) => e.path));

    const missing: string[] = [];
    for (const route of literalRoutes) {
      if (registryPaths.has(route)) continue; // 已在 registry
      if (route in ALLOW_LIST) continue; // 显式豁免
      if (isParameterizedOrSubRoute(route)) continue; // 子路由
      missing.push(route);
    }

    if (missing.length > 0) {
      const hint = missing
        .map(
          (r) =>
            `  - ${r}\n    ↳ 修复：在 navRegistry.tsx 添加该路由的 NavRegistryEntry，` +
            `\n      或在 navCoverage.test.ts 的 ALLOW_LIST 中加一行解释为何不需要 nav 元数据。`,
        )
        .join('\n');
      throw new Error(
        `\n发现 ${missing.length} 个 App.tsx 中独立声明、但未登记的路由。\n\n${hint}\n`,
      );
    }
  });

  it('首页快捷入口按目录 id 记账，不许留下查无此项的幽灵 id', () => {
    // 快捷入口的 key 是「偏好 id」（updates / voc / models / teams / my-assets），
    // 而目录 id 由路由推导（changelog / team-activity / mds / users / visual-agent）。
    // 拿偏好 id 去 addRecentVisit，记进去的就是一串谁也查不到的 id：
    // Cmd+K 的最近使用、设置里的使用统计都会静默把它丢掉——不报错，只是永远不出现。
    //
    // 判据落在**消费方真正用的那本目录**上（getLauncherCatalog + findLauncherItem）。
    // 按路由找条目：找得到就要求推导出的 id 与它一致；找不到（如 /showcase 这类
    // 刻意不进目录的演示页）说明它本来就不该记账，由页面那道 catalogIds 闸拦住。
    const catalog = getLauncherCatalog({ permissions: [], isRoot: true });
    expect(catalog.length, '目录是空的，判据已经失效').toBeGreaterThan(0);

    let checked = 0;
    for (const [prefId, link] of Object.entries(QUICK_LINK_BY_ID)) {
      if (!link) continue;
      const byRoute = catalog.find((item) => item.route === link.path);
      if (!byRoute) continue;
      checked += 1;
      const trackedId = navIdFromPath(link.path);
      expect(
        findLauncherItem(catalog, trackedId)?.id,
        `快捷入口 ${prefId}（${link.path}）记账用的 id「${trackedId}」对不上目录里的「${byRoute.id}」`,
      ).toBe(byRoute.id);
    }
    expect(checked, '一个快捷入口都没对上目录路由，判据已经失效').toBeGreaterThan(0);
  });

  it('页面确实按这条规则记账（上面那条只证明规则对，不证明页面在用）', () => {
    // 上面的用例自己算 navIdFromPath(path)，页面改成别的写法它照样绿（实测）。
    // 判据必须看页面真正传了什么：id 来自路由推导，且跳转前过 catalogIds 这道闸。
    const quickLinkBlock = launcherSource.slice(
      launcherSource.indexOf('首页快捷入口'),
      launcherSource.indexOf('home-desk-badge'),
    );
    expect(quickLinkBlock, '找不到快捷入口那段渲染，判据已经失效').toBeTruthy();
    expect(quickLinkBlock, '快捷入口的记账 id 不是从路由推导的').toMatch(/const trackedId = navIdFromPath\(link\.path\);/);
    expect(quickLinkBlock, '快捷入口把偏好别名当记账 id 用了').not.toMatch(/\{ id: link\.id/);
    // 目录闸已经收进 useTrackedNavigate（出口本身），调用方不再各写一遍——
    // 写在调用方就会有人忘记：移动端的「米多早报」就是这么记了个目录里没有的 id。
    const tracker = fs.readFileSync(path.resolve(TEST_DIR, '../useTrackedNavigate.ts'), 'utf8');
    expect(tracker, '记账出口没有目录闸，不在目录里的 id 会被记进使用统计').toMatch(
      /if \(entry && findLauncherItem\(catalog, migrateLegacyNavId\(entry\.agentKey \|\| entry\.id\)\)\)/,
    );
  });
});
