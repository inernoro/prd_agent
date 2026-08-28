import { describe, expect, it } from 'vitest';
import {
  AGENT_MISSION_DEFINITIONS,
  AGENT_MISSION_ROLE_FOCUS,
  getAgentMissionsForCategory,
  getAgentMissionsForScope,
  getRoleFocusedMissions,
  isRoleFocusedMission,
  sortMissionsForRole,
} from '../../web/src/lib/agent-mission-registry';
import { AGENT_ROLE_PROFILES, type AgentRoleId } from '../../web/src/lib/agent-starter';

const ROLE_IDS = AGENT_ROLE_PROFILES.map((profile) => profile.id);

describe('角色与任务清单联动', () => {
  it('五个角色都在焦点表里，没有角色被漏掉', () => {
    expect(Object.keys(AGENT_MISSION_ROLE_FOCUS).sort()).toEqual([...ROLE_IDS].sort());
  });

  it('焦点表里不存在幽灵任务 id', () => {
    const known = new Set(Object.keys(AGENT_MISSION_DEFINITIONS));
    for (const [roleId, contextIds] of Object.entries(AGENT_MISSION_ROLE_FOCUS)) {
      for (const contextId of contextIds) {
        expect(known.has(contextId), `${roleId} 指向不存在的任务 ${contextId}`).toBe(true);
      }
    }
  });

  it('每个角色至少三条首屏任务，且不重复', () => {
    for (const roleId of ROLE_IDS) {
      const focus = AGENT_MISSION_ROLE_FOCUS[roleId];
      expect(focus.length, `${roleId} 首屏任务过少`).toBeGreaterThanOrEqual(3);
      expect(new Set(focus).size, `${roleId} 首屏任务有重复`).toBe(focus.length);
    }
  });

  it('不同角色的首屏任务不完全相同，否则等于没做角色区分', () => {
    const signatures = ROLE_IDS.map((roleId) => AGENT_MISSION_ROLE_FOCUS[roleId].join('|'));
    expect(new Set(signatures).size).toBe(ROLE_IDS.length);
  });

  it('排序真的按角色改变顺序，且不丢任务、不加任务', () => {
    const missions = getAgentMissionsForScope('project');
    const baseline = missions.map((mission) => mission.id);

    const devOrder = sortMissionsForRole(missions, 'dev').map((mission) => mission.id);
    const pmOrder = sortMissionsForRole(missions, 'pm').map((mission) => mission.id);

    // 集合不变：排序不是过滤。
    expect([...devOrder].sort()).toEqual([...baseline].sort());
    expect([...pmOrder].sort()).toEqual([...baseline].sort());
    // 顺序确实变了，且两个角色彼此不同。
    expect(devOrder).not.toEqual(pmOrder);
    // 首位必须是该角色焦点表里在本作用域内的第一条。
    expect(devOrder[0]).toBe(getRoleFocusedMissions('project', 'dev')[0].id);
    expect(pmOrder[0]).toBe(getRoleFocusedMissions('project', 'pm')[0].id);
  });

  it('不传角色时顺序与注册表原顺序一致', () => {
    const missions = getAgentMissionsForScope('project');
    expect(sortMissionsForRole(missions, undefined)).toEqual(missions);
  });

  it('分类内列表也按角色排序', () => {
    const category = AGENT_MISSION_DEFINITIONS['build-diagnostics'].categoryId;
    const withDev = getAgentMissionsForCategory('project', category, 'dev').map((m) => m.id);
    const withoutRole = getAgentMissionsForCategory('project', category).map((m) => m.id);
    expect([...withDev].sort()).toEqual([...withoutRole].sort());
    expect(withDev[0]).toBe('build-diagnostics');
  });

  it('isRoleFocusedMission 只对该角色的焦点任务为真', () => {
    expect(isRoleFocusedMission('dev', 'build-diagnostics')).toBe(true);
    expect(isRoleFocusedMission('pm', 'build-diagnostics')).toBe(false);
    expect(isRoleFocusedMission(undefined, 'build-diagnostics')).toBe(false);
  });

  it('焦点任务的作用域过滤成立：系统作用域不会混进项目任务', () => {
    for (const roleId of ROLE_IDS as AgentRoleId[]) {
      for (const mission of getRoleFocusedMissions('system', roleId)) {
        expect(mission.scope).toBe('system');
      }
      for (const mission of getRoleFocusedMissions('project', roleId)) {
        expect(mission.scope).toBe('project');
      }
    }
  });
});
