import {
  AGENT_EXPERIENCE_PROFILES,
  AGENT_ROLE_PROFILES,
  type AgentExperienceId,
  type AgentRoleId,
} from './agent-starter';

/**
 * 当前用户角色的唯一读写口。
 *
 * 角色此前只活在 AgentStarterTab 的组件 state 里：选完生成一份提示词就丢，
 * 面板上的任务清单、项目卡都读不到它。这里把它提成浏览器级偏好，
 * 让「上手助手」「任务地图」共享同一个值，避免两处各自维护一份而漂移。
 *
 * 只存偏好，不存任何凭据。localStorage 在隐私窗口或禁站点数据时会抛，
 * 因此所有读写都必须走本文件的 try/catch 包装。
 */

const STORAGE_KEY = 'cds.agent.role-selection.v1';
const CHANGE_EVENT = 'cds:agent-role-selection-changed';

export interface AgentRoleSelection {
  roleId: AgentRoleId;
  experienceId: AgentExperienceId;
}

export const DEFAULT_AGENT_ROLE_SELECTION: AgentRoleSelection = {
  roleId: AGENT_ROLE_PROFILES[0].id,
  experienceId: AGENT_EXPERIENCE_PROFILES[0].id,
};

function isRoleId(value: unknown): value is AgentRoleId {
  return AGENT_ROLE_PROFILES.some((profile) => profile.id === value);
}

function isExperienceId(value: unknown): value is AgentExperienceId {
  return AGENT_EXPERIENCE_PROFILES.some((profile) => profile.id === value);
}

/**
 * 读取当前选择。任何异常、缺字段或不认识的取值都退回默认值，
 * 不让一条脏记录把面板卡住。
 */
export function readAgentRoleSelection(): AgentRoleSelection {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_AGENT_ROLE_SELECTION;
    const parsed = JSON.parse(raw) as Partial<AgentRoleSelection>;
    return {
      roleId: isRoleId(parsed?.roleId) ? parsed.roleId : DEFAULT_AGENT_ROLE_SELECTION.roleId,
      experienceId: isExperienceId(parsed?.experienceId)
        ? parsed.experienceId
        : DEFAULT_AGENT_ROLE_SELECTION.experienceId,
    };
  } catch {
    return DEFAULT_AGENT_ROLE_SELECTION;
  }
}

/** 写入并广播。存储失败不影响本次会话内的联动。 */
export function writeAgentRoleSelection(selection: AgentRoleSelection): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // 隐私窗口 / 禁站点数据：本次会话仍要联动，只是不持久化。
  }
  try {
    window.dispatchEvent(new CustomEvent<AgentRoleSelection>(CHANGE_EVENT, { detail: selection }));
  } catch {
    // 环境不支持 CustomEvent 时退化为「本次不广播」，不抛给调用方。
  }
}

/** 订阅角色变化，返回取消订阅函数。同页多个组件靠它保持一致。 */
export function subscribeAgentRoleSelection(
  listener: (selection: AgentRoleSelection) => void,
): () => void {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<AgentRoleSelection>).detail;
    listener(detail && isRoleId(detail.roleId) ? detail : readAgentRoleSelection());
  };
  const storageHandler = (): void => listener(readAgentRoleSelection());
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener('storage', storageHandler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener('storage', storageHandler);
  };
}
