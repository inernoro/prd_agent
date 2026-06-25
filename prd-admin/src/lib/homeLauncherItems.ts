import type { ToolboxItem } from '@/services';

/**
 * 首页/启动器的「静态入口」单一数据源（SSOT）。
 *
 * 这三组入口（智能体 / 实用工具 / 基础设施）原本内联在 AgentLauncherPage（桌面首页）里，
 * 导致移动端首页（MobileHomePage）无法复用 —— 知识库等「基础设施」在桌面首页有、手机首页没有，
 * 正是这种「各写一份」造成的割裂。抽到这里后，桌面首页、手机首页、个人中心快捷区
 * 全部读同一份，名称/顺序/权限门一致，改一处处处同步。
 *
 * 分类原则（严格，与原注释一致）：
 *   - 智能体（agents）：AI + 完备生命周期 + 存储，三者缺一不可
 *   - 实用工具（utilities）：工具型，缺 AI / 生命周期 / 存储 之一
 *   - 基础设施（infra）：平台级底座（知识库/市场/模型/团队/工作流/更新中心等），
 *     即使用户自定义导航隐藏了它们，首页仍稳定显示，避免"找不到入口"。
 */

export interface LauncherPerms {
  canReadModels: boolean;
  canReadUsers: boolean;
  canReadPrompts: boolean;
  canReadLab: boolean;
  canManageAutomations: boolean;
  canReadLogs: boolean;
  canReadTeamActivity: boolean;
  canManageOpenPlatform: boolean;
}

/** 从权限串解析启动器入口的权限门（桌面/移动共用，口径唯一） */
export function deriveLauncherPerms(permissions: string[]): LauncherPerms {
  return {
    canReadPrompts: permissions.includes('prompts.read') || permissions.includes('prompts.write'),
    canReadLab: permissions.includes('lab.read') || permissions.includes('lab.write'),
    canManageAutomations: permissions.includes('automations.manage'),
    canReadLogs: permissions.includes('logs.read'),
    canReadModels: permissions.includes('mds.read') || permissions.includes('mds.write'),
    canReadUsers: permissions.includes('users.read') || permissions.includes('users.write'),
    canReadTeamActivity: permissions.includes('team-activity.read'),
    canManageOpenPlatform: permissions.includes('open-platform.manage'),
  };
}

/** 智能体（涌现探索）—— AI 辅助 + 种子→探索→涌现完整生命周期 + 存储 */
export function buildStaticAgents(): ToolboxItem[] {
  return [
    {
      id: '__emergence__',
      name: '涌现探索智能体',
      description: '从文档出发，AI 辅助发现功能创意与交叉价值',
      icon: 'Sparkle',
      tags: ['涌现', '探索', 'AI', '创意', '智能体'],
      routePath: '/emergence',
    } as ToolboxItem,
  ];
}

/** 实用工具（权限门控） */
export function buildStaticUtilities(p: LauncherPerms): ToolboxItem[] {
  const items: ToolboxItem[] = [
    {
      id: '__skill-agent__',
      name: '技能创建助手',
      description: 'AI 引导你逐步创建可复用的技能模板',
      icon: 'Wand2',
      tags: ['技能', 'skill', 'AI', '创建', '模板'],
      routePath: '/skill-agent',
    } as ToolboxItem,
  ];

  if (p.canReadPrompts) {
    items.push({
      id: '__prompts__',
      name: '提示词管理',
      description: '管理系统与技能提示词',
      icon: 'FileText',
      tags: ['提示词', 'prompts', '管理'],
      routePath: '/prompts',
    } as ToolboxItem);
  }
  if (p.canReadLab) {
    items.push({
      id: '__lab__',
      name: '实验室',
      description: 'Model Lab / 桌面实验 / 工具箱',
      icon: 'FlaskConical',
      tags: ['实验室', 'lab', 'beta'],
      routePath: '/lab',
    } as ToolboxItem);
  }
  if (p.canManageAutomations) {
    items.push({
      id: '__automations__',
      name: '自动化规则',
      description: '创建和管理跨系统的自动化任务',
      icon: 'Zap',
      tags: ['自动化', 'automation', '规则'],
      routePath: '/automations',
    } as ToolboxItem);
  }
  if (p.canReadLogs) {
    items.push({
      id: '__logs__',
      name: '请求日志',
      description: 'LLM 调用与 API 请求日志审计',
      icon: 'ScrollText',
      tags: ['日志', 'logs', '审计'],
      routePath: '/logs',
    } as ToolboxItem);
  }

  return items;
}

/** 基础设施：平台级能力，用户即使隐藏了侧边栏也必须稳定出现（知识库置首） */
export function buildStaticInfra(p: LauncherPerms): ToolboxItem[] {
  const items: ToolboxItem[] = [
    {
      id: '__document-store__',
      name: '知识库',
      description: '文档存储与知识管理，支持文件夹、GitHub 同步',
      icon: 'Library',
      tags: ['文档', '知识', '知识库', 'docs'],
      routePath: '/document-store',
    } as ToolboxItem,
    {
      id: '__my-assets__',
      name: '我的资源',
      description: '图片、附件、素材等个人资源统一管理',
      icon: 'FolderHeart',
      tags: ['资源', '素材', '附件'],
      routePath: '/visual-agent?tab=assets',
    } as ToolboxItem,
    {
      id: '__marketplace__',
      name: '海鲜市场',
      description: '社区共享的提示词、水印、参考图、工具',
      icon: 'Store',
      tags: ['市场', 'marketplace', '分享', '社区'],
      routePath: '/marketplace',
    } as ToolboxItem,
    {
      id: '__workflow-agent__',
      name: '工作流引擎',
      description: '可视化工作流编排，自动化多步骤任务串联',
      icon: 'Workflow',
      tags: ['工作流', '自动化', '编排'],
      routePath: '/workflow-agent',
    } as ToolboxItem,
    {
      id: '__web-pages__',
      name: '网页托管',
      description: '上传 HTML 或 ZIP，托管并分享你的网页',
      icon: 'Globe',
      tags: ['托管', '网页', 'hosting'],
      routePath: '/web-pages',
    } as ToolboxItem,
    {
      id: '__changelog__',
      name: '更新中心',
      description: '代码级周报：自动汇总仓库内的变更',
      icon: 'Sparkles',
      tags: ['更新', '周报', 'changelog', 'release'],
      routePath: '/changelog',
    } as ToolboxItem,
    {
      id: '__library__',
      name: '智识殿堂',
      description: '公开知识精选，沉淀团队的最佳实践与教程',
      icon: 'GraduationCap',
      tags: ['知识', '殿堂', 'library', '教程', '精选'],
      routePath: '/library',
    } as ToolboxItem,
  ];

  // VOC（行为洞察）—— 平台级能力，桌面靠侧边栏可达，但移动端首页此前无任何入口，
  // 导致手机上完全找不到。挂到首页 SSOT 后桌面/移动/个人中心三处同步出现。
  if (p.canReadTeamActivity) {
    items.push({
      id: '__team-activity__',
      name: 'VOC',
      description: '行为洞察 + 全员工作动态时间线，端点体验下钻与 AI 根因诊断',
      icon: 'Radar',
      tags: ['VOC', '行为洞察', '动态', '活动', 'voice of customer'],
      routePath: '/team-activity',
    } as ToolboxItem);
  }
  if (p.canManageOpenPlatform) {
    items.push({
      id: '__open-platform__',
      name: '开放平台',
      description: 'API 签发、应用接入与调用监控',
      icon: 'Plug',
      tags: ['开放平台', 'open platform', 'API', '接入'],
      routePath: '/open-platform',
    } as ToolboxItem);
  }

  if (p.canReadModels) {
    items.push({
      id: '__models__',
      name: '模型中心',
      description: '大模型与模型池配置、健康监控',
      icon: 'Cpu',
      tags: ['模型', 'LLM', '模型池', '调度'],
      routePath: '/mds',
    } as ToolboxItem);
  }
  if (p.canReadUsers) {
    items.push({
      id: '__teams__',
      name: '团队协作',
      description: '团队成员、用户组、分享与协作',
      icon: 'Users',
      tags: ['团队', '用户', '协作', '权限'],
      routePath: '/users',
    } as ToolboxItem);
  }

  return items;
}
