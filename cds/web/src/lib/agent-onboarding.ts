import { buildAgentSetupUrl, getAgentSetupSkillKeys, type CdsConnectTarget } from '../../../src/shared/agent-setup';
export type { CdsConnectTarget } from '../../../src/shared/agent-setup';
import {
  createRegisteredAgentContext,
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
  AGENT_MISSION_CAPABILITY_BINDINGS,
  AGENT_MISSION_ROLE_FOCUS,
  AGENT_MISSION_DEFINITIONS,
  CDS_AGENT_CAPABILITY_DEFINITIONS,
  CDS_AGENT_SKILL_DEFINITIONS,
  getAgentCapabilitiesForMission,
  getAgentMissionCategoriesForScope,
  getAgentMissionDefinition,
  getAgentMissionsForCategory,
  getAgentMissionsForScope,
  getRoleFocusedMissions,
  isRoleFocusedCategory,
  isRoleFocusedMission,
  sortCategoriesForRole,
  sortMissionsForRole,
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
  CdsAgentCapabilityDefinition,
  CdsAgentSkillDefinition,
  CdsMcpExposure,
} from '@/lib/agent-mission-registry';

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
    // 发布控制台是发布的落地页；两页同属 release 语境，漏掉 console 会让
    // 接入 Agent 在新落地页上退化成 general。
    else if (
      location.pathname.startsWith('/release-center')
      || location.pathname.startsWith('/release-console')
    ) id = 'release';
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

export type AgentConnectSelection =
  | { kind: 'system' }
  | { kind: 'new' }
  | { kind: 'project'; projectId: string };

function agentPageProjectReference(context: AgentPageContext): string | undefined {
  if (context.scope !== 'project') return undefined;
  const query = new URLSearchParams(context.pagePath.split('?')[1]?.split('#')[0] || '');
  if (query.has('project')) return query.get('project')!;
  if (query.has('projectId')) return query.get('projectId')!;
  const match = context.pagePath.match(/^\/(?:branches|settings|agent-requests)\/([^/?#]+)/);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

export function initialAgentConnectSelection(projects: AgentProjectIdentity[], context: AgentPageContext): AgentConnectSelection {
  // Project onboarding must still be able to start without an existing project or key.
  if (context.id === 'projects' || context.id === 'project-onboarding') return { kind: 'new' };
  if (getAgentMissionScope(context.id) === 'system') return { kind: 'system' };
  const projectId = chooseAgentProjectId(projects, context);
  const reference = agentPageProjectReference(context);
  // Preserve an unavailable page target so the dialog can stop and ask for an explicit choice.
  if (reference !== undefined) return { kind: 'project', projectId: projectId || reference };
  return projectId ? { kind: 'project', projectId } : { kind: 'new' };
}

/**
 * 「接入 Agent」弹窗里，当前页签 + 目标选择 → 口令要写哪种接入目标。
 *
 * 关键一条：**上手助手页签不允许落到 system 目标**。从 /project-list 打开时
 * mapSelection 默认是 system（该页 mission scope 就是 system），而 system 分支的
 * 口令明确写着「不运行 connect --project、不生成占位项目命令」——复制出来的口令
 * 于是恰好缺了 connect --new-project，也就是解开「没有密钥建不了项目 / 没有项目
 * 用不上密钥」这个环的那一步。上手助手是零基础用户的主路径，必须默认走新建项目。
 */
export function resolveAgentConnectTarget(input: {
  tab: string;
  selection: AgentConnectSelection;
  effectiveProjectId: string;
}): CdsConnectTarget {
  const selection = input.tab === 'starter' && input.selection.kind === 'system'
    ? ({ kind: 'new' } as const)
    : input.selection;
  if (selection.kind === 'new') return { kind: 'new' };
  if (selection.kind === 'system') return { kind: 'system' };
  return { kind: 'existing', projectId: selection.projectId };
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
    const reference = agentPageProjectReference(context);
    if (reference !== undefined) {
      return projects.find((project) => project.id === reference || project.slug === reference)?.id || '';
    }
  }
  if (context?.scope === 'system') {
    const cdsSelf = projects.find((project) =>
      project.id === 'cds-self'
      || project.slug === 'cds-self'
      || project.name?.trim().toLowerCase() === 'cds self'
    );
    if (cdsSelf) return cdsSelf.id;
    return '';
  }
  return projects[0].id;
}

export function resolveAgentMissionContextForTarget(
  missionId: AgentPageContextId,
  sourceContext: AgentPageContext,
  projects: AgentProjectIdentity[],
  effectiveProjectId: string,
): AgentPageContext {
  const sourceProjectId = chooseAgentProjectId(projects, sourceContext);
  const canReuseSourceContext = missionId === sourceContext.id
    && (
      getAgentMissionScope(missionId) === 'system'
      || Boolean(effectiveProjectId && effectiveProjectId === sourceProjectId)
    );
  return canReuseSourceContext
    ? sourceContext
    : createAgentMissionContext(missionId, effectiveProjectId);
}

/** Copy only the task and a public, scoped bootstrap URL. Full guides load after discovery. */
export function buildCdsAgentPrompt({ cdsOrigin, target, context }: BuildPromptOptions): string {
  const skills = getAgentSetupSkillKeys(target, context?.id);
  const setupUrl = buildAgentSetupUrl(cdsOrigin, target, skills, context?.id);
  return [
    `请读取 ${setupUrl}，按说明接入当前仓库。`,
    `任务：${context?.title || '连接 CDS'}。${context?.goal || '确认当前目标可用。'}`,
    '只加载当前任务所需资料；复用现有授权，缺权限时走 CDS 页面批准。接入自检通过后再执行任务，不输出密钥。',
  ].join('\n');
}

export const __agentContextIdsForContract = {
  system: SYSTEM_AGENT_CONTEXT_IDS,
  project: PROJECT_AGENT_CONTEXT_IDS,
};
