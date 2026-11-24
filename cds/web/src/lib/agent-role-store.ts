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
  /**
   * 用户是否真的选过角色。
   *
   * 没有这个字段就分不清「他选了产品经理」和「他还没选，我们默认填了产品经理」——
   * 两者在界面上会长成同一个样子，于是一个开发第一次打开面板，会看到按产品经理
   * 排序的任务并标着「产品经理常用」，而他从没这么声明过。默认值不得冒充声明。
   */
  declared: boolean;
}

export const DEFAULT_AGENT_ROLE_SELECTION: AgentRoleSelection = {
  roleId: AGENT_ROLE_PROFILES[0].id,
  experienceId: AGENT_EXPERIENCE_PROFILES[0].id,
  declared: false,
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
    if (!isRoleId(parsed?.roleId)) return DEFAULT_AGENT_ROLE_SELECTION;
    return {
      roleId: parsed.roleId,
      experienceId: isExperienceId(parsed?.experienceId)
        ? parsed.experienceId
        : DEFAULT_AGENT_ROLE_SELECTION.experienceId,
      // 存在合法角色不等于用户选过它：只选了经验也会把默认角色一起落盘。
      // 声明与否只认落盘时记下的那一位，读的时候不再自行推断。
      declared: parsed.declared === true,
    };
  } catch {
    return DEFAULT_AGENT_ROLE_SELECTION;
  }
}

/**
 * 写入并广播。存储失败不影响本次会话内的联动。
 *
 * `declared` 原样落盘，不由本函数代为置真：只改经验（此时 roleId 还是默认值）
 * 也会走这条写入，若在这里强行盖成已声明，用户没选过的默认角色就会被当成
 * 他的选择，任务清单随即按那个角色排序并标注。声明只能由选角色的动作产生。
 */
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
