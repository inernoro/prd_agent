/**
 * 导航覆盖率护栏测试
 *
 * 目标：任何新增的用户可见路由必须满足以下二选一，否则 CI 失败：
 *   1. 在 `lib/launcherCatalog.ts` 注册（自动出现在「我的导航」可添加池 + Cmd+K 命令面板）
 *   2. 在本文件 ALLOW_LIST 中显式标注原因（参数化子路由 / 已废弃 redirect / 分享链接 / 移动端等）
 *
 * 这条测试是 SSOT 治理的最后一道闸：
 *   - 加菜单/智能体/页面 → 写到 launcherCatalog → 两处自动同步
 *   - 写不进 launcher 的（admin 后端注册、子路由）→ 在 ALLOW_LIST 解释
 *
 * 触发：`pnpm test` / CI。失败时按照报错提示决定是注册还是入白名单。
 */

import { describe, expect, it } from 'vitest';
import { getLauncherCatalog } from '@/lib/launcherCatalog';
// Vite ?raw 导入：把 App.tsx 内容作为字符串注入，规避 fs/path 类型依赖
import appTsxRaw from '../../app/App.tsx?raw';

/**
 * 不需要进入 launcherCatalog 的路由白名单。
 * 每条都必须有原因（注释）—— 看到 reviewer 就该问「为什么不能放 launcher」。
 */
const ALLOW_LIST: Record<string, string> = {
  // ── 系统级特殊路由 ────────────────────────
  '/': '首页 IndexPage（站点根，固定栏顶不参与可定制）',
  '/home': '首页移动版别名',
  '/login': '登录页（未鉴权状态）',
  '/agent-launcher': '首页浮层入口（与 Cmd+K 等价的 UI）',

  // ── 子路由（详情页等，由父功能统一暴露入口） ──────
  '/visual-agent-fullscreen': '视觉创作沉浸模式（不需要单独导航）',
  '/showcase': '展示页（演示用）',

  // ── 移动端专用 ────────────────────────
  '/profile': '移动端个人资料抽屉',
  '/notifications': '移动端通知抽屉',

  // ── 已废弃 / Redirect ──────────────────
  '/prd-agent': '已废弃，重定向到首页',
  '/stats': '已废弃 redirect 到 /',

  // ── 后端 menuCatalog 注册的入口（admin/特殊权限） ──
  // 这些通过 backend AdminMenuCatalog 注入，在 Cmd+K 的「其他菜单」分组显示
  '/executive': '总裁面板，后端 menuCatalog 注册',
  '/open-platform': '开放平台 admin，后端 menuCatalog 注册',
  '/assets': '素材管理 admin，后端 menuCatalog 注册',
  '/skills': '技能 admin，后端 menuCatalog 注册',
  '/data-transfers': '数据迁移 admin，后端 menuCatalog 注册',
  '/weekly-poster': '海报设计，前端 augmentedAdminMenuCatalog 注入',
  '/ai-toolbox': '百宝箱聚合页，后端 menuCatalog（group=tools）注册 + Cmd+K shortcut',
};

/** 提取 App.tsx 里所有 <Route path="X"> 的路径（含子路由） */
function parseRoutesFromAppTsx(): string[] {
  const matches = [...appTsxRaw.matchAll(/<Route\s+(?:[^>]*?\s+)?path=["'`]([^"'`]+)["'`]/g)];
  const routes = matches
    .map((m) => m[1])
    .map((p) => (p.startsWith('/') ? p : '/' + p));
  return [...new Set(routes)];
}

/** 判断一个路由是否是参数化 / 通配 / 子路由（自动豁免） */
function isParameterizedOrSubRoute(route: string): boolean {
  if (route.includes(':')) return true; // /foo/:id
  if (route.includes('*')) return true; // /foo/*
  if (route.startsWith('/_dev/')) return true; // 开发工具
  if (route.startsWith('/s/')) return true; // 分享链接
  if (route.startsWith('/shared/')) return true; // 分享链接
  if (route.startsWith('/u/')) return true; // 公开主页
  // 子路由：路径深度 > 1 且父路径已注册
  // 例：/review-agent/submit、/weekly-poster/wizard
  const segments = route.split('/').filter(Boolean);
  return segments.length > 1;
}

describe('导航覆盖率护栏', () => {
  it('每个用户可见路由要么在 launcherCatalog 注册，要么在 ALLOW_LIST 显式豁免', () => {
    const allRoutes = parseRoutesFromAppTsx();

    // launcherCatalog（不传 menuCatalog，仅前端硬编码部分）
    const catalog = getLauncherCatalog({ permissions: [], isRoot: true });
    const registered = new Set(catalog.map((c) => c.route));

    const missing: string[] = [];
    for (const route of allRoutes) {
      if (registered.has(route)) continue;
      if (route in ALLOW_LIST) continue;
      if (isParameterizedOrSubRoute(route)) continue;
      missing.push(route);
    }

    if (missing.length > 0) {
      const hint = missing
        .map(
          (r) =>
            `  - ${r}\n    ↳ 修复：在 prd-admin/src/lib/launcherCatalog.ts 添加该路由的 LauncherItem，` +
            `\n      或在 navCoverage.test.ts 的 ALLOW_LIST 中加一行解释为何不需要注册。`,
        )
        .join('\n');
      throw new Error(
        `\n发现 ${missing.length} 个未注册到导航目录的路由。\n` +
          `每个路由必须二选一：① 进 launcherCatalog（让「设置→导航顺序」和 Cmd+K 自动同步）` +
          `② 进 ALLOW_LIST（说明为何不需要导航入口）。\n\n${hint}\n`,
      );
    }
  });

  it('launcherCatalog 中的所有 route 都对应 App.tsx 实存的 Route（防止 phantom 路由）', () => {
    const allRoutes = new Set(parseRoutesFromAppTsx());
    const catalog = getLauncherCatalog({ permissions: [], isRoot: true });

    const phantom: { id: string; route: string }[] = [];
    for (const item of catalog) {
      // launcher 中的 menu 组（来自 backend menuCatalog）不在 App.tsx 里也合理
      if (item.group === 'menu') continue;
      // 去掉 query string / hash 再比对
      const clean = item.route.split(/[?#]/)[0];
      if (!allRoutes.has(clean)) {
        phantom.push({ id: item.id, route: item.route });
      }
    }

    if (phantom.length > 0) {
      const hint = phantom
        .map(
          (p) =>
            `  - ${p.id} (route=${p.route})\n    ↳ 修复：检查 App.tsx 里的实际路由，更新 launcherCatalog`,
        )
        .join('\n');
      throw new Error(
        `\n发现 ${phantom.length} 个 phantom 路由（launcherCatalog 注册了但 App.tsx 没有）。\n` +
          `点击会 404。请修正路由或删除该 launcher 项。\n\n${hint}\n`,
      );
    }
    expect(phantom).toEqual([]);
  });
});
