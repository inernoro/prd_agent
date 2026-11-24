import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENT_MISSION_DEFINITIONS,
  AGENT_MISSION_ROLE_FOCUS,
  getAgentMissionCategoriesForScope,
  getAgentMissionsForCategory,
  getAgentMissionsForScope,
  getRoleFocusedMissions,
  isRoleFocusedCategory,
  isRoleFocusedMission,
  sortCategoriesForRole,
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

  // 任务条一次只渲染一个分类。只排任务不排分类的话，角色排序只在用户恰好
  // 停留的那个分类内部生效，横幅承诺的「常用的排在最前」在界面上看不到。
  describe('分类条也按角色排序', () => {
    const projectMissions = getAgentMissionsForScope('project');
    const projectCategories = getAgentMissionCategoriesForScope('project');

    it('每个角色的首个分类都含有它的首屏任务', () => {
      for (const roleId of ROLE_IDS as AgentRoleId[]) {
        const sorted = sortCategoriesForRole(projectCategories, projectMissions, roleId);
        expect(
          isRoleFocusedCategory(projectMissions, roleId, sorted[0].id),
          `${roleId} 的首个分类 ${sorted[0].id} 不含它的首屏任务`,
        ).toBe(true);
      }
    });

    it('不改变分类集合，只改顺序；没有角色时原样返回', () => {
      for (const roleId of ROLE_IDS as AgentRoleId[]) {
        const sorted = sortCategoriesForRole(projectCategories, projectMissions, roleId);
        expect(sorted.map((c) => c.id).sort()).toEqual(projectCategories.map((c) => c.id).sort());
      }
      expect(sortCategoriesForRole(projectCategories, projectMissions))
        .toEqual(projectCategories);
    });

    it('不同角色排出不同的首个分类，不是所有人都看到同一个', () => {
      const heads = (ROLE_IDS as AgentRoleId[])
        .map((roleId) => sortCategoriesForRole(projectCategories, projectMissions, roleId)[0].id);
      expect(new Set(heads).size).toBeGreaterThan(1);
    });

    it('isRoleFocusedCategory 对无角色和非焦点分类都为假', () => {
      const devFirst = sortCategoriesForRole(projectCategories, projectMissions, 'dev')[0].id;
      expect(isRoleFocusedCategory(projectMissions, undefined, devFirst)).toBe(false);
      const nonFocus = projectCategories
        .map((c) => c.id)
        .find((id) => !isRoleFocusedCategory(projectMissions, 'dev', id));
      if (nonFocus) expect(isRoleFocusedCategory(projectMissions, 'dev', nonFocus)).toBe(false);
    });

    // 排序在某个作用域里可能一条都命不中（开发的首屏任务全是项目级的，
    // 系统侧无一命中）。横幅不许在那种情况下照样宣称「已按某某重排」。
    it('系统作用域下确实存在「角色排序不生效」的角色，横幅必须能分辨', () => {
      const systemMissions = getAgentMissionsForScope('system');
      const affected = (ROLE_IDS as AgentRoleId[]).filter((roleId) =>
        systemMissions.some((mission) => isRoleFocusedMission(roleId, mission.id)));
      const unaffected = (ROLE_IDS as AgentRoleId[]).filter((roleId) =>
        !systemMissions.some((mission) => isRoleFocusedMission(roleId, mission.id)));
      // 两边都非空，才说明这个判据有实际分辨力，而不是恒真或恒假。
      expect(affected.length).toBeGreaterThan(0);
      expect(unaffected.length).toBeGreaterThan(0);

      const source = readFileSync(
        new URL('../../web/src/components/AgentAccessMap.tsx', import.meta.url),
        'utf8',
      );
      expect(source).toMatch(/const roleAffectsOrder = roleId/);
      expect(source).toContain('roleLabel && roleAffectsOrder');
    });

    // 形状 2：排序函数建好了没人调用，删掉也不会红。这条盯住渲染侧真的用了它。
    it('AgentAccessMap 真的用 sortCategoriesForRole 排分类条', () => {
      const source = readFileSync(
        new URL('../../web/src/components/AgentAccessMap.tsx', import.meta.url),
        'utf8',
      );
      expect(source).toContain('sortCategoriesForRole');
      expect(source).toContain('isRoleFocusedCategory');
      // 分类条渲染的是 draftCategories，它必须是排过序的那一份。
      expect(source).toMatch(/const draftCategories = sortCategoriesForRole\(/);
      expect(source).toMatch(/draftCategories\.map\(/);
    });
  });
});
