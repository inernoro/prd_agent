/**
 * 菜单与权限的映射关系
 * 用于权限管理页面根据菜单过滤权限列表
 */

export interface MenuDef {
  appKey: string;
  label: string;
  icon: string;
  permissions: string[]; // 该菜单关联的权限 keys
}

/**
 * 菜单定义列表（与后端 AdminMenuCatalog 保持一致）
 */
export const menuList: MenuDef[] = [
  {
    appKey: 'dashboard',
    label: '仪表盘',
    icon: 'LayoutDashboard',
    permissions: ['access'],
  },
  {
    appKey: 'users',
    label: '用户管理',
    icon: 'Users',
    permissions: ['users.read', 'users.write'],
  },
  {
    appKey: 'groups',
    label: '群组管理',
    icon: 'Users2',
    permissions: ['groups.read', 'groups.write'],
  },
  {
    appKey: 'mds',
    label: '模型管理',
    icon: 'Cpu',
    permissions: ['mds.read', 'mds.write'],
  },
  {
    appKey: 'prd-agent',
    label: '米多智能体平台',
    icon: 'MessagesSquare',
    permissions: ['prd-agent.use'],
  },
  {
    appKey: 'visual-agent',
    label: '视觉创作 Agent',
    icon: 'Wand2',
    permissions: ['visual-agent.use'],
  },
  {
    appKey: 'literary-agent',
    label: '文学创作 Agent',
    icon: 'PenLine',
    permissions: ['literary-agent.use'],
  },
  {
    appKey: 'video-agent',
    label: '视频 Agent',
    icon: 'Video',
    permissions: ['video-agent.use'],
  },
  {
    appKey: 'assets',
    label: '资源管理',
    icon: 'Image',
    permissions: ['assets.read', 'assets.write'],
  },
  {
    appKey: 'logs',
    label: '请求日志',
    icon: 'ScrollText',
    permissions: ['logs.read'],
  },
  {
    appKey: 'data',
    label: '数据管理',
    icon: 'Database',
    permissions: ['data.read', 'data.write'],
  },
  {
    appKey: 'open-platform',
    label: '开放平台',
    icon: 'Plug',
    permissions: ['open-platform.manage'],
  },
  {
    appKey: 'settings',
    label: '系统设置',
    icon: 'Settings',
    permissions: ['settings.read', 'settings.write'],
  },
  {
    appKey: 'authz',
    label: '权限管理',
    icon: 'UserCog',
    permissions: ['authz.manage'],
  },
  {
    appKey: 'defect-agent',
    label: '缺陷管理 Agent',
    icon: 'Bug',
    permissions: ['defect-agent.use', 'defect-agent.manage'],
  },
  {
    appKey: 'arena-agent',
    label: '竞技场 Agent',
    icon: 'Swords',
    permissions: ['arena-agent.use'],
  },
  {
    appKey: 'ai-toolbox',
    label: 'AI 百宝箱',
    icon: 'Wrench',
    permissions: ['ai-toolbox.use', 'ai-toolbox.manage'],
  },
  {
    appKey: 'report-agent',
    label: '周报 Agent',
    icon: 'FileBarChart',
    permissions: [
      'report-agent.use',
      'report-agent.template.manage',
      'report-agent.team.manage',
      'report-agent.view.all',
      'report-agent.datasource.manage',
    ],
  },
  {
    appKey: 'workflow-agent',
    label: '工作流引擎',
    icon: 'Workflow',
    permissions: ['workflow-agent.use', 'workflow-agent.manage'],
  },
  {
    appKey: 'shortcuts-agent',
    label: '快捷指令',
    icon: 'Smartphone',
    permissions: ['access'],
  },
  {
    appKey: 'data-migration-agent',
    label: '数据迁移 Agent',
    icon: 'DatabaseZap',
    permissions: ['data-migration-agent.use', 'data-migration-agent.write'],
  },
  {
    appKey: 'skills',
    label: '技能管理',
    icon: 'Sparkles',
    permissions: ['skills.read', 'skills.write'],
  },
  {
    appKey: 'automations',
    label: '自动化',
    icon: 'Zap',
    permissions: ['automations.manage'],
  },
  {
    appKey: 'tutorial-email',
    label: '教程邮件',
    icon: 'Mail',
    permissions: ['tutorial-email.read', 'tutorial-email.write'],
  },
  {
    appKey: 'lab',
    label: '实验室',
    icon: 'FlaskConical',
    permissions: ['lab.read', 'lab.write'],
  },
  {
    appKey: 'executive',
    label: '总裁面板',
    icon: 'Crown',
    permissions: ['executive.read'],
  },
];

/**
 * 所有权限定义
 */
export interface PermissionDef {
  key: string;
  label: string;
  description?: string;
  category: 'access' | 'read' | 'write' | 'manage' | 'use' | 'super';
}

export const allPermissions: PermissionDef[] = [
  // 基础访问
  { key: 'access', label: '后台访问', description: '允许进入管理后台', category: 'access' },

  // 用户管理
  { key: 'users.read', label: '用户管理 - 读', description: '查看用户列表和详情', category: 'read' },
  { key: 'users.write', label: '用户管理 - 写', description: '创建、编辑、删除用户', category: 'write' },

  // 群组管理
  { key: 'groups.read', label: '群组管理 - 读', description: '查看群组列表和详情', category: 'read' },
  { key: 'groups.write', label: '群组管理 - 写', description: '创建、编辑、删除群组', category: 'write' },

  // 模型管理
  { key: 'mds.read', label: '模型管理 - 读', description: '查看模型配置', category: 'read' },
  { key: 'mds.write', label: '模型管理 - 写', description: '编辑模型配置', category: 'write' },

  // 日志
  { key: 'logs.read', label: '日志 - 读', description: '查看请求日志', category: 'read' },

  // 开放平台
  { key: 'open-platform.manage', label: '开放平台 - 管理', description: '管理 API 应用', category: 'manage' },

  // 数据管理
  { key: 'data.read', label: '数据管理 - 读', description: '查看数据概览', category: 'read' },
  { key: 'data.write', label: '数据管理 - 写', description: '数据导入导出', category: 'write' },

  // 资源管理
  { key: 'assets.read', label: '资源管理 - 读', description: '查看资源', category: 'read' },
  { key: 'assets.write', label: '资源管理 - 写', description: '上传、删除资源', category: 'write' },

  // 系统设置
  { key: 'settings.read', label: '系统设置 - 读', description: '查看系统设置', category: 'read' },
  { key: 'settings.write', label: '系统设置 - 写', description: '修改系统设置', category: 'write' },

  // 提示词管理
  // 实验室
  { key: 'lab.read', label: '实验室 - 读', description: '查看实验室功能', category: 'read' },
  { key: 'lab.write', label: '实验室 - 写', description: '使用实验室功能', category: 'write' },

  // 权限管理
  { key: 'authz.manage', label: '权限管理', description: '管理系统角色和用户权限', category: 'manage' },

  // 技能管理
  { key: 'skills.read', label: '技能 - 读', description: '查看技能配置', category: 'read' },
  { key: 'skills.write', label: '技能 - 写', description: '创建/编辑/删除技能', category: 'write' },

  // 自动化
  { key: 'automations.manage', label: '自动化 - 管理', description: '管理自动化规则', category: 'manage' },

  // Agent 权限
  { key: 'prd-agent.use', label: '米多智能体平台', description: '智能解读与问答', category: 'use' },
  { key: 'visual-agent.use', label: '视觉创作 Agent', description: '高级视觉创作工作区', category: 'use' },
  { key: 'literary-agent.use', label: '文学创作 Agent', description: '文章配图智能生成', category: 'use' },
  { key: 'video-agent.use', label: '视频 Agent', description: '文章转视频教程生成', category: 'use' },
  { key: 'defect-agent.use', label: '缺陷管理 Agent', description: '提交和查看缺陷', category: 'use' },
  { key: 'defect-agent.manage', label: '缺陷管理 Agent - 管理', description: '设置模板、指派处理人', category: 'manage' },
  { key: 'arena-agent.use', label: '竞技场 Agent', description: '模型盲评对战', category: 'use' },
  { key: 'ai-toolbox.use', label: 'AI 百宝箱', description: '使用 AI 百宝箱功能', category: 'use' },
  { key: 'ai-toolbox.manage', label: 'AI 百宝箱 - 管理', description: '管理工作流、配置等', category: 'manage' },
  { key: 'report-agent.use', label: '周报 Agent', description: '基础使用周报功能', category: 'use' },
  { key: 'report-agent.template.manage', label: '周报 - 模板管理', description: '创建/编辑周报模板', category: 'manage' },
  { key: 'report-agent.team.manage', label: '周报 - 团队管理', description: '管理周报团队与成员', category: 'manage' },
  { key: 'report-agent.view.all', label: '周报 - 查看全部', description: '查看所有团队周报', category: 'read' },
  { key: 'report-agent.datasource.manage', label: '周报 - 数据源管理', description: '配置 Git/SVN 仓库连接', category: 'manage' },
  { key: 'workflow-agent.use', label: '工作流引擎', description: '创建和执行自动化工作流', category: 'use' },
  { key: 'workflow-agent.manage', label: '工作流引擎 - 管理', description: '管理所有工作流与执行记录', category: 'manage' },
  { key: 'data-migration-agent.use', label: '数据迁移 Agent - 读', description: '查看实体与集合映射', category: 'use' },
  { key: 'data-migration-agent.write', label: '数据迁移 Agent - 写', description: '删除集合、修复数据', category: 'write' },

  // 教程邮件
  { key: 'tutorial-email.read', label: '教程邮件 - 读', description: '查看教程邮件序列与模板', category: 'read' },
  { key: 'tutorial-email.write', label: '教程邮件 - 写', description: '编辑序列、模板、触发发送', category: 'write' },

  // 总裁面板
  { key: 'executive.read', label: '总裁面板 - 读', description: '查看总裁面板和周报', category: 'read' },

  // 超级权限
  { key: 'super', label: '超级权限', description: '绕过所有权限检查', category: 'super' },
];

/**
 * 根据权限 key 获取权限定义
 */
export function getPermissionDef(key: string): PermissionDef | undefined {
  return allPermissions.find((p) => p.key === key);
}

/**
 * 根据菜单 appKey 获取关联的权限列表
 */
export function getPermissionsByMenu(appKey: string): PermissionDef[] {
  const menu = menuList.find((m) => m.appKey === appKey);
  if (!menu) return allPermissions;
  return menu.permissions.map((key) => getPermissionDef(key)).filter((p): p is PermissionDef => p !== undefined);
}

/**
 * 根据角色权限列表判断是否能访问某个菜单
 */
export function canAccessMenu(rolePermissions: string[], appKey: string): boolean {
  const menu = menuList.find((m) => m.appKey === appKey);
  if (!menu) return false;
  // 有该菜单关联的任意权限即可访问
  return menu.permissions.some((p) => rolePermissions.includes(p));
}
