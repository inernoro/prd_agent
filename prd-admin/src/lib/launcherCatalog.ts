/**
 * Launcher Catalog —— v7 全改造后变成 NAV_REGISTRY 的薄派生层。
 *
 * 单一数据源：`@/app/navRegistry.tsx` 的 NAV_REGISTRY。
 * 本文件只做 3 件事：
 *   1. 把 NavRegistryEntry → LauncherItem（保持下游 AgentSwitcher 字段不变）
 *   2. 拼接后端 menuCatalog 中 launcher 没注册的项作为 'menu' 组
 *   3. 按权限过滤 + route 维度去重
 *
 * 加新 Agent / 工具 / 页面：去 navRegistry.tsx 写一行，本文件零改动，
 * 「我的导航」可添加池 + Cmd+K 命令面板自动同步。
 */

import { NAV_REGISTRY, navIdFromPath, type RegistrySection } from '@/app/navRegistry';
import type { AdminMenuItem } from '@/services/contracts/authz';

export type LauncherGroup = RegistrySection | 'menu';

export interface LauncherItem {
  id: string;
  name: string;
  description: string;
  icon: string;
  group: LauncherGroup;
  route: string;
  tags: string[];
  /** Agent 卡片主题色文字（用于命令面板高亮） */
  accentColor?: string;
  /** 关联 appKey */
  agentKey?: string;
  permission?: string | string[];
  wip?: boolean;
}

/** Group 中文标签 */
export const LAUNCHER_GROUP_LABELS: Record<LauncherGroup, string> = {
  agent: '智能体',
  toolbox: '百宝箱',
  utility: '实用工具',
  infra: '基础设施',
  menu: '其他菜单',
};

/** 把后端菜单项打包为 LauncherItem，进入「其他菜单」分组 */
function buildMenuItems(menuCatalog: AdminMenuItem[]): LauncherItem[] {
  return menuCatalog
    .filter((m) => !!m.group && m.group !== 'home' && m.appKey !== 'settings')
    .map<LauncherItem>((m) => ({
      id: m.appKey,
      name: m.label,
      description: m.description ?? '',
      icon: m.icon,
      group: 'menu',
      route: m.path,
      tags: [m.label, m.appKey, m.path].filter(Boolean) as string[],
    }));
}

/** 把 NAV_REGISTRY 条目转成 LauncherItem */
function buildFromRegistry(): LauncherItem[] {
  return NAV_REGISTRY.filter((e) => !!e.nav).map<LauncherItem>((e) => {
    const nav = e.nav!;
    return {
      id: navIdFromPath(e.path),
      name: nav.label,
      description: nav.description,
      icon: nav.icon,
      group: nav.section,
      route: e.path,
      tags: nav.tags ?? [],
      accentColor: nav.accentColor,
      agentKey: nav.appKey,
      permission: e.permission,
      wip: nav.wip,
    };
  });
}

/**
 * 返回用户可见的目录。
 *
 * 权限过滤原则：
 *   - 没有权限的条目一律不展示
 *   - root / super 用户全开
 *   - 没有 permission 字段的条目视为"人人可用"
 *   - permission 为字符串数组时，命中任意一项即可见
 *
 * 双维度去重（id + route）。registry 优先于 menu，同 route 时 menu 项被丢。
 */
export function getLauncherCatalog(opts: {
  permissions: string[];
  isRoot: boolean;
  /**
   * 可选：传入后端 menuCatalog，则把 launcher 没注册的 menu 项作为
   * 'menu' 组并入。命令面板（AgentSwitcher / Cmd+K）传入即可同步「其他菜单」。
   */
  menuCatalog?: AdminMenuItem[];
}): LauncherItem[] {
  const all = [
    ...buildFromRegistry(),
    ...(opts.menuCatalog ? buildMenuItems(opts.menuCatalog) : []),
  ];

  const permSet = new Set(opts.permissions);
  const isSuper = opts.isRoot || permSet.has('super');

  const idSeen = new Set<string>();
  const routeSeen = new Set<string>();
  const dedup: LauncherItem[] = [];
  for (const it of all) {
    if (idSeen.has(it.id)) continue;
    if (routeSeen.has(it.route)) continue;
    if (!isSuper && it.permission) {
      const required = Array.isArray(it.permission) ? it.permission : [it.permission];
      const hit = required.some((p) => permSet.has(p));
      if (!hit) continue;
    }
    idSeen.add(it.id);
    routeSeen.add(it.route);
    dedup.push(it);
  }

  return dedup;
}

/**
 * 旧 ID → 新 ID 迁移
 *
 * v7 之前 launcherCatalog 用前缀 ID（`agent:visual-agent` / `toolbox:builtin-visual-agent`
 * / `utility:logs` / `infra:document-store`）；v7 起统一改为路径派生 ID（`visual-agent`
 * / `logs` / `document-store`）。
 *
 * 用户已经持久化的偏好（AgentSwitcher pinnedIds/recentVisits/usageCounts、
 * navOrderStore navOrder/navHidden）若用旧 ID 存的，需要在读取时透明转换。
 */
export function migrateLegacyNavId(id: string): string {
  if (!id || id === '---') return id;
  return id
    .replace(/^(agent|toolbox|utility|infra|builtin):/, '')
    .replace(/^builtin-/, '');
}

/** 按 id 查找 LauncherItem（自动兼容 v7 之前的旧 ID 格式） */
export function findLauncherItem(
  catalog: LauncherItem[],
  id: string
): LauncherItem | undefined {
  const direct = catalog.find((it) => it.id === id);
  if (direct) return direct;
  const migrated = migrateLegacyNavId(id);
  if (migrated !== id) return catalog.find((it) => it.id === migrated);
  return undefined;
}
