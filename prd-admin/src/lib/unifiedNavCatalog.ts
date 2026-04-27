/**
 * 统一导航目录（Single Source of Truth）
 *
 * 设计目标：「我的导航」（设置 → 导航顺序）和 ⌘K 命令面板用同一份数据，
 * 新增功能只需在 launcherCatalog.ts 注册一次，两个地方自动看见，
 * 杜绝「加了功能但找不到」的体验缺陷。
 *
 * 数据来源（按权威度从高到低）：
 *   1. 快捷操作（硬编码：首页 / 设置 / 百宝箱）—— Cmd+K 专用
 *   2. 后端 menuCatalog —— 含权限信息，权威
 *   3. launcherCatalog —— 前端注册的 agent / toolbox / utility / infra
 *
 * 同 route 去重：高权威覆盖低权威。
 */

import { getLauncherCatalog, LAUNCHER_GROUP_LABELS, type LauncherItem } from '@/lib/launcherCatalog';
import { getAugmentedAdminMenuCatalog } from '@/lib/adminMenuCatalog';
import { getShortLabel } from '@/lib/shortLabel';
import type { AdminMenuItem } from '@/services/contracts/authz';

export type NavSection =
  | 'home' // 固定栏顶，不出现在「可添加」池
  | 'shortcut'
  | 'agent'
  | 'toolbox'
  | 'utility'
  | 'infra'
  | 'menu';

/** 分组中文标签（统一文案） */
export const NAV_SECTION_LABELS: Record<NavSection, string> = {
  home: '首页',
  shortcut: '快捷操作',
  agent: LAUNCHER_GROUP_LABELS.agent, // 智能体
  toolbox: LAUNCHER_GROUP_LABELS.toolbox, // 百宝箱
  utility: LAUNCHER_GROUP_LABELS.utility, // 实用工具
  infra: LAUNCHER_GROUP_LABELS.infra, // 基础设施
  menu: '其他菜单',
};

/**
 * 分组元信息（标题 / 副标题 / Lucide 图标名）
 * 与 AgentSwitcher 命令面板保持一致，让「设置 → 我的导航」和 ⌘K 看起来是同一族。
 */
export const NAV_SECTION_META: Record<
  NavSection,
  { label: string; subtitle: string; iconName: string }
> = {
  home: { label: '首页', subtitle: '固定在侧栏顶部', iconName: 'Home' },
  shortcut: { label: '快捷操作', subtitle: '常用动作的一键入口', iconName: 'Zap' },
  agent: { label: '智能体', subtitle: 'AI + 完备生命周期 + 存储', iconName: 'Star' },
  toolbox: { label: '百宝箱', subtitle: '官方与社区共建的工具', iconName: 'Hammer' },
  utility: { label: '实用工具', subtitle: '日常高频入口', iconName: 'Sparkles' },
  infra: {
    label: '基础设施',
    subtitle: '平台级能力（知识库/市场/模型/团队等）',
    iconName: 'Boxes',
  },
  menu: { label: '其他菜单', subtitle: '后端注册的管理入口', iconName: 'Menu' },
};

/** 分组在 UI 上的固定顺序（home 不入此列，由调用方单独取 findHomeItem 处理） */
export const NAV_SECTION_ORDER: NavSection[] = [
  'shortcut',
  'agent',
  'toolbox',
  'utility',
  'infra',
  'menu',
];

export interface NavCatalogItem {
  /** 全局唯一 id，作为 navOrder/navHidden 的稳定 key */
  id: string;
  /** 完整名（Cmd+K 主标题、tooltip） */
  label: string;
  /** ≤ 4 字短标签（侧栏折叠态、设置页芯片） */
  shortLabel: string;
  /** 描述（Cmd+K 副标题） */
  description?: string;
  /** Lucide 图标名 */
  icon: string;
  /** 路由路径 */
  route: string;
  /** 分组归属 */
  section: NavSection;
  /** 已 normalize 的搜索关键字 */
  keywords: string;
  /** 权限（已在上游做过过滤，此处仅用于 UI 提示） */
  permission?: string | string[];
  /** Agent 颜色（Cmd+K 卡片可选高亮） */
  accentColor?: string;
  /** 关联 appKey */
  agentKey?: string;
  /** 施工中标记 */
  wip?: boolean;
}

function normalize(s: string): string {
  return (s || '').toLowerCase().trim();
}

/** 把 LauncherItem 的 group 翻成 NavSection */
function launcherGroupToSection(group: LauncherItem['group']): NavSection {
  return group; // launcher group 与 NavSection 在 agent/toolbox/utility/infra 上同名
}

function buildShortcuts(): NavCatalogItem[] {
  return [
    {
      id: 'shortcut:home',
      label: '返回首页',
      shortLabel: '首页',
      description: '智能体启动器',
      icon: 'Home',
      route: '/',
      section: 'shortcut',
      keywords: normalize('home 首页 launcher 启动器'),
    },
    {
      id: 'shortcut:toolbox',
      label: '打开百宝箱',
      shortLabel: '百宝箱',
      description: '全部内置与自定义工具',
      icon: 'Wrench',
      route: '/ai-toolbox',
      section: 'shortcut',
      keywords: normalize('toolbox 百宝箱 工具'),
    },
    {
      id: 'shortcut:settings',
      label: '打开设置',
      shortLabel: '设置',
      description: '账户 / 皮肤 / 导航 / 小技巧',
      icon: 'Settings',
      route: '/settings',
      section: 'shortcut',
      keywords: normalize('settings 设置 account profile 皮肤 skin'),
    },
  ];
}

function fromMenuItem(m: AdminMenuItem): NavCatalogItem {
  // 后端 menu group 为 'home' 时归入 home 分类（固定栏顶，不进 pool）
  const section: NavSection = m.group === 'home' ? 'home' : 'menu';
  return {
    id: m.appKey, // 后端权威 navKey 直接用 appKey（与现有 navOrder 兼容）
    label: m.label,
    shortLabel: getShortLabel(m.appKey, m.label),
    description: m.description ?? undefined,
    icon: m.icon,
    route: m.path,
    section,
    keywords: normalize([m.label, m.description, m.appKey, m.path, m.group].filter(Boolean).join(' ')),
  };
}

/** 找到首页项（侧栏顶部固定，不可移除） */
export function findHomeItem(items: NavCatalogItem[]): NavCatalogItem | null {
  return items.find((it) => it.section === 'home') ?? null;
}

function fromLauncherItem(it: LauncherItem): NavCatalogItem {
  return {
    id: it.id,
    label: it.name,
    shortLabel: getShortLabel(it.agentKey ?? it.id, it.name),
    description: it.description,
    icon: it.icon,
    route: it.route,
    section: launcherGroupToSection(it.group),
    keywords: normalize([it.name, it.description, ...(it.tags ?? []), it.agentKey, it.route]
      .filter(Boolean)
      .join(' ')),
    permission: it.permission,
    accentColor: it.accentColor,
    agentKey: it.agentKey,
    wip: it.wip,
  };
}

/**
 * 获取统一目录。
 * 已经过权限过滤（getLauncherCatalog 内部处理，menuCatalog 由后端处理）。
 */
export function getUnifiedNavCatalog(opts: {
  menuCatalog: AdminMenuItem[];
  permissions: string[];
  isRoot: boolean;
  /** 是否包含「快捷操作」分组（仅 Cmd+K 需要） */
  includeShortcuts?: boolean;
}): NavCatalogItem[] {
  const { menuCatalog, permissions, isRoot, includeShortcuts = false } = opts;

  const result: NavCatalogItem[] = [];
  const routeSeen = new Set<string>();
  const idSeen = new Set<string>();

  const push = (item: NavCatalogItem) => {
    if (idSeen.has(item.id)) return;
    if (routeSeen.has(item.route)) return;
    idSeen.add(item.id);
    routeSeen.add(item.route);
    result.push(item);
  };

  // 1) 快捷操作（最高优先级）
  if (includeShortcuts) {
    buildShortcuts().forEach(push);
  }

  // 2) 后端菜单（权威，包含权限信息）
  const augmented = getAugmentedAdminMenuCatalog({
    items: menuCatalog,
    permissions,
    isRoot,
  });
  augmented.forEach((m) => push(fromMenuItem(m)));

  // 3) launcherCatalog（前端注册的全部能力）
  const launcher = getLauncherCatalog({ permissions, isRoot });
  launcher.forEach((it) => push(fromLauncherItem(it)));

  return result;
}

/** 按 section 分组 */
export function groupBySection(items: NavCatalogItem[]): {
  section: NavSection;
  label: string;
  items: NavCatalogItem[];
}[] {
  const buckets = new Map<NavSection, NavCatalogItem[]>();
  for (const it of items) {
    const arr = buckets.get(it.section) ?? [];
    arr.push(it);
    buckets.set(it.section, arr);
  }
  return NAV_SECTION_ORDER.filter((s) => (buckets.get(s)?.length ?? 0) > 0).map((s) => ({
    section: s,
    label: NAV_SECTION_LABELS[s],
    items: buckets.get(s) ?? [],
  }));
}

/** 简易匹配评分（与原 CommandPalette matchScore 对齐） */
export function matchKeywordScore(query: string, keywords: string): number {
  if (!query) return 1;
  if (keywords.includes(query)) return 100 - keywords.indexOf(query);
  const parts = query.split(/\s+/).filter(Boolean);
  if (parts.every((p) => keywords.includes(p))) return 50;
  return 0;
}
