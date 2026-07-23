export type CdsConnectTarget =
  | { kind: 'existing'; projectId: string }
  | { kind: 'new' };

export type AgentPageContextId =
  | 'projects'
  | 'branches'
  | 'project-settings'
  | 'auth'
  | 'github'
  | 'maintenance'
  | 'release'
  | 'tasks'
  | 'reports'
  | 'settings'
  | 'general';

export interface AgentPageContext {
  id: AgentPageContextId;
  title: string;
  summary: string;
  goal: string;
  checks: string[];
  pagePath: string;
}

export interface AgentPageLocation {
  pathname: string;
  search?: string;
  hash?: string;
}

export interface AgentProjectIdentity {
  id: string;
  name?: string;
  slug?: string;
}

interface BuildPromptOptions {
  cdsOrigin: string;
  target: CdsConnectTarget;
  context?: AgentPageContext;
}

export const OPEN_AGENT_ACCESS_EVENT = 'cds:open-agent-access';

export const PROJECT_SKILL_PATHS = [
  { agent: 'Codex / 通用 Agent Skills', path: '.agents/skills' },
  { agent: 'Cursor', path: '.cursor/skills' },
  { agent: 'Claude Code', path: '.claude/skills' },
] as const;

const CONTEXT_DEFINITIONS: Record<AgentPageContextId, Omit<AgentPageContext, 'pagePath'>> = {
  projects: {
    id: 'projects',
    title: '项目与 Agent 接入',
    summary: '让 Agent 识别仓库、连接已有项目或创建新项目，并把部署推进到可预览状态。',
    goal: '根据当前仓库和 CDS 项目状态完成接入、项目识别、部署与预览验证。',
    checks: ['优先复用已有项目，避免重复创建', '所有访问权限都走 CDS 页面批准', '部署后只使用 preview-url 返回的真实入口'],
  },
  branches: {
    id: 'branches',
    title: '分支部署与预览',
    summary: '让 Agent 理解当前项目与分支，定位失败原因并完成部署、回滚或预览验证。',
    goal: '读取当前项目的分支状态和部署记录，完成用户在当前页面要做的部署操作。',
    checks: ['先确认当前项目和分支，不跨项目操作', '长任务持续回报阶段与进度', '完成后验证真实预览入口'],
  },
  'project-settings': {
    id: 'project-settings',
    title: '项目配置',
    summary: '让 Agent 读取现有配置，自动补齐运行方式、依赖和环境变量声明。',
    goal: '基于当前项目代码和现有配置给出最小变更，并在保存前解释影响范围。',
    checks: ['敏感值不进入对话或日志', '优先自动识别，不要求用户学习部署参数', '保存后执行配置与运行验证'],
  },
  auth: {
    id: 'auth',
    title: '登录与 SSO 认证',
    summary: '让 Agent 识别身份提供方、准备回调与票据配置，用户只处理密钥输入和明确授权。',
    goal: '检查当前认证状态，按平台无关的一次性票据协议完成账号密码或 SSO 接入，并验证登录闭环。',
    checks: [
      '先读取 /api/auth/status 与脱敏后的 /api/auth/sso/config',
      '客户端密钥和登录密码只允许在受保护的页面输入框或运行环境中处理，不得进入对话、命令输出或日志',
      'SSO 登录后默认返回 /project-list，验证完成前不退出当前管理会话',
    ],
  },
  github: {
    id: 'github',
    title: 'GitHub 接入',
    summary: '让 Agent 检查 GitHub App、仓库授权与 Webhook 状态，用户只完成平台侧确认。',
    goal: '完成 GitHub App 接入并验证仓库读取、Webhook 和私有仓库授权。',
    checks: ['使用最小仓库权限', '不在对话中传递私钥或 OAuth 密钥', '接入后验证真实仓库读取'],
  },
  maintenance: {
    id: 'maintenance',
    title: 'CDS 更新与维护',
    summary: '让 Agent 读取实例状态、准备更新方案，并通过 CDS 的明确授权流程执行高风险操作。',
    goal: '诊断当前实例并完成安全更新、重启或维护验证。',
    checks: ['先读取状态再执行', '所有运维写操作必须等待页面明确授权', '更新后验证版本、健康状态和公开入口'],
  },
  release: {
    id: 'release',
    title: '正式发布',
    summary: '让 Agent 检查发布目标、版本与回滚条件，按可追溯流程完成发布。',
    goal: '完成当前项目的发布预检、执行、入口验证与回滚准备。',
    checks: ['确认目标环境与版本', '复用可追溯构建产物', '以最终公开入口可访问作为完成条件'],
  },
  tasks: {
    id: 'tasks',
    title: '任务调度',
    summary: '让 Agent 创建或诊断定时任务，并根据运行记录验证真实执行结果。',
    goal: '完成当前调度任务的配置、触发与结果验证。',
    checks: ['先检查时区和重复执行风险', '手动触发前说明影响', '以运行记录和输出结果完成验收'],
  },
  reports: {
    id: 'reports',
    title: '验收报告',
    summary: '让 Agent 查找、整理或生成可追溯的验收证据。',
    goal: '围绕当前功能完成报告查询、证据整理与结果交付。',
    checks: ['保留目标、步骤、结果和证据', '不伪造未执行的验收结论', '敏感信息进入报告前先脱敏'],
  },
  settings: {
    id: 'settings',
    title: 'CDS 系统设置',
    summary: '让 Agent 理解当前设置分区，读取现状并完成最小、安全、可验证的配置变更。',
    goal: '处理当前设置页面的配置任务，避免让用户学习底层参数。',
    checks: ['先读取现状与权限边界', '敏感写操作等待页面授权', '保存后验证生效状态'],
  },
  general: {
    id: 'general',
    title: '当前 CDS 页面',
    summary: '把当前页面、目标和安全边界一起交给 Agent，让它先理解上下文再操作。',
    goal: '识别当前页面可用能力，完成用户目标并提供可验证结果。',
    checks: ['不猜测项目、分支或环境', '敏感信息不进入对话或日志', '写操作遵循页面授权与最小权限'],
  },
};

export function resolveAgentPageContext(
  location: AgentPageLocation,
  requestedId?: AgentPageContextId,
): AgentPageContext {
  const pagePath = `${location.pathname}${location.search || ''}${location.hash || ''}`;
  let id = requestedId;
  if (!id) {
    const hash = (location.hash || '').replace(/^#/, '');
    if (location.pathname.startsWith('/cds-settings')) {
      if (hash === 'auth') id = 'auth';
      else if (hash === 'github' || hash === 'github-whitelist' || hash === 'webhook-log') id = 'github';
      else if (hash === 'maintenance' || hash === 'update-history' || hash === 'docker-network' || hash === 'danger') id = 'maintenance';
      else id = 'settings';
    } else if (location.pathname === '/login' || location.pathname.startsWith('/auth/sso')) id = 'auth';
    else if (
      location.pathname.startsWith('/branches/') ||
      location.pathname.startsWith('/branch-list') ||
      location.pathname.startsWith('/branch-panel') ||
      location.pathname.startsWith('/branch-topology') ||
      location.pathname.startsWith('/agent-requests/')
    ) id = 'branches';
    else if (location.pathname.startsWith('/settings/')) id = 'project-settings';
    else if (location.pathname.startsWith('/release-center')) id = 'release';
    else if (location.pathname.startsWith('/task-schedule')) id = 'tasks';
    else if (location.pathname.startsWith('/reports')) id = 'reports';
    else if (location.pathname.startsWith('/project-list')) id = 'projects';
    else id = 'general';
  }
  return { ...CONTEXT_DEFINITIONS[id], pagePath };
}

export function requestAgentAccess(contextId?: AgentPageContextId): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_AGENT_ACCESS_EVENT, {
    detail: contextId ? { contextId } : undefined,
  }));
}

export function chooseAgentProjectId(
  projects: AgentProjectIdentity[],
  context?: AgentPageContext,
): string {
  if (projects.length === 0) return '';
  if (context?.id === 'branches' || context?.id === 'project-settings') {
    const match = context.pagePath.match(/^\/(?:branches|settings)\/([^/?#]+)/);
    if (match) {
      const projectId = decodeURIComponent(match[1]);
      const currentProject = projects.find((project) => project.id === projectId || project.slug === projectId);
      if (currentProject) return currentProject.id;
    }
  }
  if (context && ['auth', 'github', 'maintenance', 'settings'].includes(context.id)) {
    const cdsSelf = projects.find((project) =>
      project.id === 'cds-self' ||
      project.slug === 'cds-self' ||
      project.name?.trim().toLowerCase() === 'cds self'
    );
    if (cdsSelf) return cdsSelf.id;
  }
  return projects[0].id;
}

export function buildCdsAgentPrompt({ cdsOrigin, target, context }: BuildPromptOptions): string {
  const connectArgs = target.kind === 'new'
    ? '--new-project'
    : `--project ${target.projectId}`;
  const targetLabel = target.kind === 'new'
    ? '首次接入，需要创建一个新项目'
    : `连接已有项目 ${target.projectId}`;
  const contextLines = context
    ? [
        '',
        '当前页面任务',
        `页面：${context.title}（${cdsOrigin}${context.pagePath}）`,
        `目标：${context.goal}`,
        '验收与安全边界：',
        ...context.checks.map((check) => `- ${check}`),
      ]
    : [];

  return [
    '请帮我接入 CDS。整个过程不要向我索要或展示任何密钥，也不要修改系统环境变量、shell profile 或全局 PATH。',
    '',
    `目标：${targetLabel}`,
    ...contextLines,
    '',
    '1. 下载技能包',
    `从 ${cdsOrigin}/api/export-skill 下载 tar.gz。包内 skills/ 目录必须包含 cds、cds-deploy-pipeline、cds-project-scan、preview-url。`,
    '',
    '2. 按当前 Agent 安装到项目级技能目录',
    '先识别你当前运行在 Codex、Cursor、Claude Code 还是其他支持 Agent Skills 的宿主，再选择该宿主的项目级技能目录。',
    '已知目录：Codex/通用 Agent Skills 用 .agents/skills，Cursor 用 .cursor/skills，Claude Code 用 .claude/skills。',
    '不要安装到用户主目录。旧版本如需备份，放到当前项目 .cds/skill-backups，不要留在技能扫描目录。',
    '安装完成后确认四个技能各只有一个可发现版本；缺 preview-url 视为接入未完成。',
    '',
    '3. 发起页面授权',
    `运行 cds 技能内的 cli/cdscli.py connect --host ${cdsOrigin} ${connectArgs} --agent <当前 Agent 名称>。`,
    '命令会等待 CDS 页面批准。告诉我去 CDS 右下角点击批准，然后继续等待，不要改用复制密钥的旧流程。',
    '',
    '4. 自动验证',
    '授权完成后运行 cdscli auth check，并确认当前 git 仓库没有新增可提交的凭据文件、shell 配置没有变化。',
    '随后必须调用 preview-url 技能，由它运行当前宿主项目技能目录中的 cdscli.py --human preview-url。',
    '预览地址只能使用 CDS API 返回的 previewUrl / previewUrls；主应用、模型网关等独立命名服务都属于实际入口，CDS 返回几条就全部列出。所有入口只使用公开 previewDomain；rootDomains 可能包含隐藏、备用或内部域名，禁止向用户暴露。禁止把 rootDomains 数量当成入口数量，也禁止根据分支名、项目名、profileId、CDS host 或旧公式自行拼接。',
    '如当前分支尚未在 CDS 创建或部署，preview-url 应明确失败并说明原因，不得伪造一个看似可用的地址。',
    '如果目标是新项目，接下来可直接用 cdscli onboard <Git 仓库 URL> 创建并部署，创建权限使用一次后会自动切换为项目级权限。',
  ].join('\n');
}
