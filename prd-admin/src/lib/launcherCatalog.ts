/**
 * Launcher Catalog — Agent / 工具 / 实用工具 的统一目录
 *
 * Agent Switcher 浮层和「我的空间」设置页共享同一份目录，避免各自维护拷贝。
 */

import { AGENT_DEFINITIONS } from '@/stores/agentSwitcherStore';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';

export type LauncherGroup = 'agent' | 'toolbox' | 'utility' | 'infra';

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

/** Agent 的图标/描述兜底（PR #496 起 prd-agent Web 端已下线，不再注册描述） */
const AGENT_DESCRIPTIONS: Record<string, string> = {
  'visual-agent': 'AI 驱动的视觉创作，一键生成精美图像',
  'literary-agent': '文学创作智能体，为文章配图赋予灵魂',
  'defect-agent': '缺陷管理专家，高效追踪问题闭环',
  'video-agent': '文章转视频教程，AI 驱动分镜创作',
};

/** Agent 条目（来自 AGENT_DEFINITIONS） */
// permission 直接读 AgentDefinition.permission（每个 Agent 必填，与目标路由 RequirePermission 1:1）。
// 禁止 fallback 到 `${appKey}.use` 自动推导 —— 见 buildToolboxItems 同样反模式注释。
function buildAgentItems(): LauncherItem[] {
  return AGENT_DEFINITIONS.map((a) => ({
    id: `agent:${a.key}`,
    name: a.name,
    description: AGENT_DESCRIPTIONS[a.key] ?? `${a.name} - 智能体`,
    icon: a.icon,
    group: 'agent' as const,
    route: a.route,
    tags: [a.name, '智能体', a.appKey],
    accentColor: a.color.text,
    agentKey: a.appKey,
    permission: a.permission,
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
    // 显式映射：每个 BUILTIN_TOOLS 条目自带 permission（与目标路由 RequirePermission 一致）。
    // 禁止用 ${agentKey}.use 推导——arena 的 agentKey="arena" 但路由要 arena-agent.use，
    // shortcuts-agent / marketplace-openapi 路由只要 access，自动推导会错误隐藏掉这些条目。
    permission: t.permission,
  }));
}

/**
 * 实用工具（与 AgentLauncherPage 的 staticUtilities 保持同步）
 * 每项可以带 permission 来做门控。
 *
 * 分类：
 *   - emergence（涌现探索）= 'agent'：AI + 生命周期（种子→探索→涌现）+ 存储（emergence_trees）
 *   - skill-agent / prompts / lab / automations / logs / settings = 'utility'：工具型，无完备生命周期
 */
function buildUtilityItems(): LauncherItem[] {
  return [
    {
      id: 'utility:emergence',
      name: '涌现探索智能体',
      description: '从文档出发，AI 辅助发现功能创意与交叉价值',
      icon: 'Sparkle',
      group: 'agent',
      route: '/emergence',
      tags: ['涌现', '探索', 'AI', '创意', '智能体'],
      permission: 'emergence-agent.use',
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
 * 基础设施（平台级能力，不进百宝箱）
 *
 * 分类原则：能被其他智能体/工具复用的"底座"，如知识库、模型、市场、团队等。
 * 用户即使隐藏了侧边栏，也必须有稳定的入口能到达这些能力。
 */
function buildInfraItems(): LauncherItem[] {
  return [
    {
      id: 'infra:document-store',
      name: '知识库',
      description: '文档存储与知识管理，支持文件夹、GitHub 同步',
      icon: 'Library',
      group: 'infra',
      route: '/document-store',
      tags: ['文档', '知识', '知识库', 'docs'],
    },
    {
      id: 'infra:my-assets',
      name: '我的资源',
      description: '图片、附件、素材等个人资源统一管理',
      icon: 'FolderHeart',
      group: 'infra',
      route: '/visual-agent?tab=assets',
      tags: ['资源', '素材', '附件'],
    },
    {
      id: 'infra:marketplace',
      name: '海鲜市场',
      description: '社区共享的提示词、水印、参考图、工具',
      icon: 'Store',
      group: 'infra',
      route: '/marketplace',
      tags: ['市场', 'marketplace', '分享', '社区'],
    },
    {
      id: 'infra:models',
      name: '模型中心',
      description: '大模型与模型池配置、健康监控',
      icon: 'Cpu',
      group: 'infra',
      route: '/models',
      tags: ['模型', 'LLM', '模型池', '调度'],
      permission: ['mds.read', 'mds.write'],
    },
    {
      id: 'infra:teams',
      name: '团队协作',
      description: '团队成员、用户组、分享与协作',
      icon: 'Users',
      group: 'infra',
      route: '/users',
      tags: ['团队', '用户', '协作', '权限'],
      permission: ['users.read', 'users.write'],
    },
    {
      id: 'infra:workflow-agent',
      name: '工作流引擎',
      description: '可视化工作流编排，自动化多步骤任务串联',
      icon: 'Workflow',
      group: 'infra',
      route: '/workflow-agent',
      tags: ['工作流', '自动化', '编排'],
    },
    {
      id: 'infra:web-pages',
      name: '网页托管',
      description: '上传 HTML 或 ZIP，托管并分享你的网页',
      icon: 'Globe',
      group: 'infra',
      route: '/web-pages',
      tags: ['托管', '网页', 'hosting'],
    },
    {
      id: 'infra:changelog',
      name: '更新中心',
      description: '代码级周报：自动汇总仓库内的变更',
      icon: 'Sparkles',
      group: 'infra',
      route: '/changelog',
      tags: ['更新', '周报', 'changelog', 'release'],
    },
    {
      id: 'infra:library',
      name: '智识殿堂',
      description: '社区共享的知识库与精选文档',
      icon: 'BookOpenText',
      group: 'infra',
      route: '/library',
      tags: ['智识', '殿堂', '知识', 'library', '社区', '殿'],
    },
  ];
}

/**
 * 返回用户可见的目录。
 *
 * 权限过滤原则（2026-04-24 规则 #navigation-registry 强化）：
 *   - 没有权限的条目一律不展示，禁止"看得到加得进点开 403"的体验缺陷
 *   - root / super 用户全开
 *   - 没有 permission 字段的条目视为"人人可用"（如本就开放给全员的 Agent）
 *   - permission 为字符串数组时，命中任意一项即可见
 */
export function getLauncherCatalog(opts: {
  permissions: string[];
  isRoot: boolean;
}): LauncherItem[] {
  const all = [
    ...buildAgentItems(),
    ...buildToolboxItems(),
    ...buildUtilityItems(),
    ...buildInfraItems(),
  ];

  const permSet = new Set(opts.permissions);
  const isSuper = opts.isRoot || permSet.has('super');

  // 根据 id 去重（toolbox 中的 Agent 已在 agent: 前缀下独立呈现）
  const seen = new Set<string>();
  const dedup: LauncherItem[] = [];
  for (const it of all) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    if (!isSuper && it.permission) {
      const required = Array.isArray(it.permission) ? it.permission : [it.permission];
      const hit = required.some((p) => permSet.has(p));
      if (!hit) continue;
    }
    dedup.push(it);
  }

  return dedup;
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
  agent: '智能体',
  toolbox: '百宝箱',
  utility: '实用工具',
  infra: '基础设施',
};
