/**
 * Launcher Catalog — Agent / 工具 / 实用工具 的统一目录
 *
 * Agent Switcher 浮层和「我的空间」设置页共享同一份目录，避免各自维护拷贝。
 */

import { AGENT_DEFINITIONS } from '@/stores/agentSwitcherStore';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';

export type LauncherGroup = 'agent' | 'toolbox' | 'utility';

export interface LauncherItem {
  /** 稳定 id，用作置顶 / 使用次数 / 最近访问的 key */
  id: string;
  name: string;
  description: string;
  /** Lucide 图标名 */
  icon: string;
  group: LauncherGroup;
  route: string;
  tags: string[];
  /** Agent 卡片的主题色（hex） */
  accentColor?: string;
  /** Agent 卡片的 appKey（用于首屏封面图） */
  agentKey?: string;
  /** 权限键，缺失则无门控 */
  permission?: string | string[];
  /** 标记为施工中（WIP） */
  wip?: boolean;
}

/** Agent 的图标/描述兜底 */
const AGENT_DESCRIPTIONS: Record<string, string> = {
  'prd-agent': '智能解读 PRD 文档，快速提取需求要点',
  'visual-agent': 'AI 驱动的视觉创作，一键生成精美图像',
  'literary-agent': '文学创作助手，为文章配图赋予灵魂',
  'defect-agent': '缺陷管理专家，高效追踪问题闭环',
  'video-agent': '文章转视频教程，AI 驱动分镜创作',
};

/** Agent 条目（来自 AGENT_DEFINITIONS） */
function buildAgentItems(): LauncherItem[] {
  return AGENT_DEFINITIONS.map((a) => ({
    id: `agent:${a.key}`,
    name: a.name,
    description: AGENT_DESCRIPTIONS[a.key] ?? `${a.name} - 智能助手`,
    icon: a.icon,
    group: 'agent' as const,
    route: a.route,
    tags: [a.name, 'Agent', a.appKey],
    accentColor: a.color.text,
    agentKey: a.appKey,
  }));
}

/** 百宝箱内置工具（来自 toolboxStore.BUILTIN_TOOLS） */
function buildToolboxItems(): LauncherItem[] {
  return BUILTIN_TOOLS.filter((t) => !!t.routePath).map((t) => ({
    id: `toolbox:${t.id}`,
    name: t.name,
    description: t.description ?? '',
    icon: t.icon ?? 'Bot',
    group: 'toolbox' as const,
    route: t.routePath!,
    tags: [t.name, ...(t.tags ?? [])],
    agentKey: t.agentKey,
    wip: t.wip,
  }));
}

/**
 * 实用工具（与 AgentLauncherPage 的 staticUtilities 保持同步）
 * 每项可以带 permission 来做门控。
 */
function buildUtilityItems(): LauncherItem[] {
  return [
    {
      id: 'utility:document-store',
      name: '知识库',
      description: '文档存储与知识管理，支持文件夹、GitHub 同步',
      icon: 'Library',
      group: 'utility',
      route: '/document-store',
      tags: ['文档', '知识', '知识库', 'docs'],
    },
    {
      id: 'utility:emergence',
      name: '涌现探索',
      description: '从文档出发，AI 辅助发现功能创意与交叉价值',
      icon: 'Sparkle',
      group: 'utility',
      route: '/emergence',
      tags: ['涌现', '探索', 'AI', '创意'],
    },
    {
      id: 'utility:web-pages',
      name: '网页托管',
      description: '上传 HTML 或 ZIP，托管并分享你的网页',
      icon: 'Globe',
      group: 'utility',
      route: '/web-pages',
      tags: ['托管', '网页', 'hosting'],
    },
    {
      id: 'utility:skill-agent',
      name: '技能创建助手',
      description: 'AI 引导你逐步创建可复用的技能模板',
      icon: 'Wand2',
      group: 'utility',
      route: '/skill-agent',
      tags: ['技能', 'skill', 'AI', '创建', '模板'],
    },
    {
      id: 'utility:prompts',
      name: '提示词管理',
      description: '管理系统与技能提示词',
      icon: 'FileText',
      group: 'utility',
      route: '/prompts',
      tags: ['提示词', 'prompts', '管理'],
      permission: ['prompts.read', 'prompts.write'],
    },
    {
      id: 'utility:lab',
      name: '实验室',
      description: 'Model Lab / 桌面实验 / 工具箱',
      icon: 'FlaskConical',
      group: 'utility',
      route: '/lab',
      tags: ['实验室', 'lab', 'beta'],
      permission: ['lab.read', 'lab.write'],
    },
    {
      id: 'utility:automations',
      name: '自动化规则',
      description: '创建和管理跨系统的自动化任务',
      icon: 'Zap',
      group: 'utility',
      route: '/automations',
      tags: ['自动化', 'automation', '规则'],
      permission: 'automations.manage',
    },
    {
      id: 'utility:logs',
      name: '请求日志',
      description: 'LLM 调用与 API 请求日志审计',
      icon: 'ScrollText',
      group: 'utility',
      route: '/logs',
      tags: ['日志', 'logs', '审计'],
      permission: 'logs.read',
    },
    {
      id: 'utility:settings',
      name: '设置',
      description: '皮肤、导航、数据管理等系统设置',
      icon: 'Settings',
      group: 'utility',
      route: '/settings',
      tags: ['设置', 'settings', '偏好'],
    },
  ];
}

/**
 * 按当前用户权限与 isRoot 过滤出完整目录。
 * - isRoot = true：绕过所有权限校验
 * - permission 为字符串：必须拥有该权限
 * - permission 为数组：任一命中即可
 */
export function getLauncherCatalog(opts: {
  permissions: string[];
  isRoot: boolean;
}): LauncherItem[] {
  const { permissions, isRoot } = opts;
  const perms = new Set(permissions);
  const hasPerm = (p: string) => isRoot || perms.has(p) || perms.has('super');

  const match = (item: LauncherItem) => {
    if (!item.permission) return true;
    if (Array.isArray(item.permission)) return item.permission.some(hasPerm);
    return hasPerm(item.permission);
  };

  const all = [...buildAgentItems(), ...buildToolboxItems(), ...buildUtilityItems()];

  // 根据 id 去重（toolbox 中的 Agent 已在 agent: 前缀下独立呈现）
  const seen = new Set<string>();
  const dedup: LauncherItem[] = [];
  for (const it of all) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    dedup.push(it);
  }

  return dedup.filter(match);
}

/** 按 id 查找 LauncherItem */
export function findLauncherItem(
  catalog: LauncherItem[],
  id: string
): LauncherItem | undefined {
  return catalog.find((it) => it.id === id);
}

/** Group 中文标签 */
export const LAUNCHER_GROUP_LABELS: Record<LauncherGroup, string> = {
  agent: 'Agent',
  toolbox: '百宝箱',
  utility: '实用工具',
};
