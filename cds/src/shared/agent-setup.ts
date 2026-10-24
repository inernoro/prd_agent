import { AGENT_MISSION_DEFINITIONS, getAgentCapabilitiesForMission, type AgentPageContextId } from './agent-mission-registry.js';

/** Public bootstrap contract shared by the dashboard and server. No credentials or project data. */
export type AgentRoleId = 'pm' | 'owner' | 'domain-expert' | 'dev' | 'qa';
export const AGENT_SETUP_VERSION = 'cds-agent-setup.v1';
export const AGENT_SETUP_MIN_CLI_VERSION = '0.17.5';
export const AGENT_SETUP_PATH = '/api/agent/setup.md';
export const AGENT_SETUP_MANIFEST_PATH = '/api/agent/setup.json';
export const CDS_SKILL_KEYS = ['cds', 'cds-project-scan', 'cds-deploy-pipeline', 'cds-release', 'preview-url'] as const;
export type CdsSkillKey = typeof CDS_SKILL_KEYS[number];
export type CdsConnectTarget = { kind: 'existing'; projectId: string } | { kind: 'new' } | { kind: 'system' };

export function isPublicAgentSetupRoute(method: string, path: string): boolean {
  return method === 'GET' && (path === AGENT_SETUP_PATH || path === AGENT_SETUP_MANIFEST_PATH);
}

export function buildAgentSetupUrl(origin: string, target: CdsConnectTarget, skills: readonly string[], mission?: AgentPageContextId): string {
  const url = new URL(AGENT_SETUP_PATH, origin);
  url.searchParams.set('target', target.kind);
  if (target.kind === 'existing') url.searchParams.set('project', target.projectId);
  url.searchParams.set('skills', [...new Set(skills)].join(','));
  if (mission) url.searchParams.set('mission', mission);
  return url.toString();
}

export interface AgentSetupSelection {
  target: CdsConnectTarget;
  skills: CdsSkillKey[];
  mission?: AgentPageContextId;
  stage: 'connect' | 'task';
}

export function parseAgentSetupSelection(query: Record<string, unknown>): AgentSetupSelection | null {
  const kind = query.target ?? 'system';
  const project = query.project;
  if (typeof kind !== 'string' || !['existing', 'new', 'system'].includes(kind)) return null;
  if (kind === 'existing' && (typeof project !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(project))) return null;
  if (kind !== 'existing' && project !== undefined) return null;
  if (query.skills !== undefined && typeof query.skills !== 'string') return null;
  if (query.stage !== undefined && query.stage !== 'connect' && query.stage !== 'task') return null;
  if (query.mission !== undefined && (typeof query.mission !== 'string' || !Object.hasOwn(AGENT_MISSION_DEFINITIONS, query.mission))) return null;
  const skills = [...new Set(String(query.skills ?? 'cds').split(','))];
  if (!skills.length || skills.some((key) => !(CDS_SKILL_KEYS as readonly string[]).includes(key))) return null;
  const target: CdsConnectTarget = kind === 'existing' ? { kind, projectId: project as string } : { kind: kind as 'new' | 'system' };
  if (query.mission) {
    const mission = AGENT_MISSION_DEFINITIONS[query.mission as AgentPageContextId];
    const compatible = mission.connectTargets?.includes(target.kind)
      ?? (mission.scope === 'system' ? target.kind === 'system' : target.kind !== 'system');
    if (!compatible) return null;
  }
  return {
    target,
    skills: query.mission ? getAgentSetupSkillKeys(target, query.mission as AgentPageContextId) : skills as CdsSkillKey[],
    mission: query.mission as AgentPageContextId | undefined,
    stage: query.stage === 'task' ? 'task' : 'connect',
  };
}

export function getAgentSetupSkillKeys(target: CdsConnectTarget, mission?: AgentPageContextId): CdsSkillKey[] {
  const skills = mission ? [...new Set([
    ...getAgentCapabilitiesForMission(mission).map((item) => item.preferredSkill),
    ...(AGENT_MISSION_DEFINITIONS[mission].requiredSkills || []),
  ])] : ['cds' as const];
  if (target.kind === 'new' && !skills.includes('cds-project-scan')) skills.push('cds-project-scan');
  return skills;
}
