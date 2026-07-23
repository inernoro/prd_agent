import {
  createRegisteredAgentContext,
  getAgentMissionCategoryDefinition,
  getAgentMissionDefinition,
  PROJECT_AGENT_CONTEXT_IDS,
  SYSTEM_AGENT_CONTEXT_IDS,
} from './agent-mission-registry';
import type {
  AgentMissionScope,
  AgentPageContext,
  AgentPageContextId,
} from './agent-mission-registry';

export {
  AGENT_MISSION_CATEGORY_DEFINITIONS,
  AGENT_MISSION_DEFINITIONS,
  getAgentMissionCategoriesForScope,
  getAgentMissionCategoryDefinition,
  getAgentMissionDefinition,
  getAgentMissionsForCategory,
  getAgentMissionsForScope,
  PROJECT_AGENT_CONTEXT_IDS,
  SYSTEM_AGENT_CONTEXT_IDS,
} from './agent-mission-registry';
export type {
  AgentMissionCategoryDefinition,
  AgentMissionCategoryId,
  AgentMissionDefinition,
  AgentMissionIconKey,
  AgentMissionScope,
  AgentPageContext,
  AgentPageContextId,
} from '@/lib/agent-mission-registry';

export type CdsConnectTarget =
  | { kind: 'existing'; projectId: string }
  | { kind: 'new' };

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
      else if (hash === 'access-keys') id = 'agent-access';
      else if (hash === 'github' || hash === 'github-whitelist' || hash === 'webhook-log') id = 'github';
      else if (hash === 'http-logs' || hash === 'server-events') id = 'system-observability';
      else if (hash === 'maintenance' || hash === 'update-history' || hash === 'docker-network' || hash === 'danger') id = 'maintenance';
      else id = 'settings';
    } else if (location.pathname === '/login' || location.pathname.startsWith('/auth/sso')) id = 'auth';
    else if (
      location.pathname.startsWith('/branches/')
      || location.pathname.startsWith('/branch-list')
      || location.pathname.startsWith('/branch-panel')
      || location.pathname.startsWith('/branch-topology')
      || location.pathname.startsWith('/agent-requests/')
    ) id = 'branches';
    else if (location.pathname.startsWith('/settings/')) id = 'project-settings';
    else if (location.pathname.startsWith('/release-center')) id = 'release';
    else if (location.pathname.startsWith('/task-schedule')) id = 'tasks';
    else if (location.pathname.startsWith('/reports')) id = 'reports';
    else if (location.pathname.startsWith('/project-list')) id = 'projects';
    else id = 'general';
  }
  return createRegisteredAgentContext(id, undefined, pagePath);
}

export function getAgentMissionScope(contextId: AgentPageContextId): AgentMissionScope {
  return getAgentMissionDefinition(contextId).scope;
}

export function createAgentMissionContext(
  contextId: AgentPageContextId,
  projectId?: string,
): AgentPageContext {
  return createRegisteredAgentContext(contextId, projectId);
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
  if (context?.scope === 'project') {
    const match = context.pagePath.match(/^\/(?:branches|settings)\/([^/?#]+)/);
    if (match) {
      const projectId = decodeURIComponent(match[1]);
      const currentProject = projects.find((project) => project.id === projectId || project.slug === projectId);
      if (currentProject) return currentProject.id;
    }
  }
  if (context?.scope === 'system') {
    const cdsSelf = projects.find((project) =>
      project.id === 'cds-self'
      || project.slug === 'cds-self'
      || project.name?.trim().toLowerCase() === 'cds self'
    );
    if (cdsSelf) return cdsSelf.id;
  }
  return projects[0].id;
}

function missionPromptLines(context?: AgentPageContext): string[] {
  if (!context) return [];
  const category = getAgentMissionCategoryDefinition(context.categoryId);
  return [
    '',
    '当前任务',
    `分类：${category.label}`,
    `页面：${context.title}`,
    `目标：${context.goal}`,
    '',
    '建议执行顺序：',
    ...context.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '安全边界：',
    ...context.checks.map((check) => `- ${check}`),
    '',
    '完成标准：',
    ...context.completion.map((item) => `- ${item}`),
  ];
}

export function buildCdsAgentPrompt({ cdsOrigin, target, context }: BuildPromptOptions): string {
  const connectArgs = target.kind === 'new'
    ? '--new-project'
    : `--project ${target.projectId}`;
  const targetLabel = target.kind === 'new'
    ? '首次接入，需要创建一个新项目'
    : `已有项目 ${target.projectId}`;
  const projectPermissionCheck = target.kind === 'new'
    ? '当前任务需要创建新项目；如果已有凭据不具备创建权限，再申请一次性新项目授权。'
    : `认证通过后继续运行 cdscli project show ${target.projectId}；只有该命令也成功，才算已经拥有目标项目权限。`;
  const projectStorageRule = target.kind === 'new'
    ? '新项目创建成功后，一次性创建权限会自动吊销并换成该项目的长期项目级凭据。'
    : `批准后把 CDS 主机、项目 ID ${target.projectId} 和项目级凭据保存到当前仓库 .cds/credentials.json；该文件必须保持 Git 忽略。`;
  const missionLines = missionPromptLines(context);

  return [
    '请作为 CDS 操作 Agent 完成下面的任务。把我当作不熟悉开发工具的用户：能自动读取的不要反问我，必须由我决定的授权和高风险操作再清楚提示。',
    '整个过程不要向我索要、展示或复述任何密钥，也不要修改系统环境变量、shell profile、用户主目录或全局 PATH。',
    '',
    `CDS 主机：${cdsOrigin}`,
    `项目目标：${targetLabel}`,
    `任务页面：${cdsOrigin}${context?.pagePath || '/'}`,
    ...missionLines,
    '',
    '一、复用现有技能，不重复安装',
    '先识别当前宿主的项目级技能目录。Codex/通用 Agent Skills 使用 .agents/skills，Cursor 使用 .cursor/skills，Claude Code 使用 .claude/skills。',
    '如果 cds、cds-deploy-pipeline、cds-project-scan、preview-url 四个技能已经存在且能读取，直接复用，不重新下载。',
    `只有缺失时才从 ${cdsOrigin}/api/export-skill 下载技能包，并安装到当前仓库的项目级技能目录。`,
    '不要安装到用户主目录。旧版本备份放到当前项目 .cds/skill-backups，不得留在技能扫描目录。',
    '',
    '二、静默检查认证',
    '先在当前仓库运行 cds 技能内的 cli/cdscli.py auth check。成功时不要让用户重新登录或批准。',
    projectPermissionCheck,
    '如果认证或目标项目检查失败，先判断是无凭据、凭据已失效，还是当前凭据只属于另一个项目，不要把三种情况混为一谈。',
    '',
    '三、仅在缺少权限时申请授权',
    `仅在第二步未通过时运行 cli/cdscli.py connect --host ${cdsOrigin} ${connectArgs} --agent <当前 Agent 名称>。`,
    '命令会等待 CDS 页面批准。只告诉用户去 CDS 右下角处理这一条申请，然后继续等待，不使用复制密钥的旧流程。',
    projectStorageRule,
    '',
    '四、认证范围与提权规则',
    '项目级凭据是长期授权：同一 CDS 主机、同一项目再次使用时应静默复用，直到它被吊销。',
    '当前凭据属于其他项目时，只为目标项目申请项目级授权；不要因为操作另一个项目就自动申请全局权限。',
    `只有用户明确要求长期跨项目操作时，才引导到 ${cdsOrigin}/cds-settings#access-keys 签发全局通行证。`,
    '全局通行证属于认证提权，必须由用户明确选择单项目或所有项目范围。Agent 不得自行签发、扩大或批准自己的权限。',
    '当前 CDS 只支持全局通行证绑定单个项目或所有项目，不支持多个指定项目的组合；遇到该需求要明确说明边界，并分别申请项目级权限。',
    '',
    '五、执行任务并持续反馈',
    '按照上面的建议执行顺序工作。先读取状态再做变更；部署、更新、发布和回滚等长任务必须持续展示当前阶段、进度和下一步。',
    '优先使用 cdscli health、project show、branch status、deployment-run、diagnose、help-me-check、branch logs、smoke 和 preview-url 等已经存在的能力，不手写旁路请求替代 CDS 技能。',
    '',
    '六、自动验证',
    '完成后再次运行 auth check，并确认当前仓库没有新增可提交的凭据文件，shell 配置没有变化。',
    '涉及部署或预览时必须调用 preview-url 技能。预览地址只能使用 CDS API 返回的 previewUrl / previewUrls；返回几条就验证并列出几条。',
    '所有入口只使用公开 previewDomain；rootDomains 可能包含隐藏、备用或内部域名，禁止向用户暴露。',
    '禁止把 rootDomains 数量当成入口数量，也禁止根据分支名、项目名、profileId、CDS host 或旧公式自行拼接预览地址。',
    '如果目标分支尚未部署或 API 没有返回入口，应明确失败原因，不得伪造一个看似可用的地址。',
  ].join('\n');
}

export const __agentContextIdsForContract = {
  system: SYSTEM_AGENT_CONTEXT_IDS,
  project: PROJECT_AGENT_CONTEXT_IDS,
};
