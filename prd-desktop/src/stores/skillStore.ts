import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Skill, UserRole } from '../types';

interface SkillState {
  /** 从服务端获取的全部可见技能 */
  skills: Skill[];
  /** 用户置顶的技能 key（本地偏好） */
  pinnedSkillKeys: string[];
  /** 上次获取时间 */
  lastFetchedAt: string | null;
  /** 是否正在加载 */
  isLoading: boolean;

  // Actions
  setSkills: (skills: Skill[]) => void;
  setLoading: (loading: boolean) => void;
  togglePin: (skillKey: string) => void;
  /** 获取按角色过滤 + 置顶排序的技能列表 */
  getVisibleSkills: (role?: UserRole) => Skill[];
}

export const useSkillStore = create<SkillState>()(
  persist(
    (set, get) => ({
      skills: [],
      pinnedSkillKeys: [],
      lastFetchedAt: null,
      isLoading: false,

      setSkills: (skills) => set({ skills, lastFetchedAt: new Date().toISOString() }),
      setLoading: (loading) => set({ isLoading: loading }),

      togglePin: (skillKey) => {
        const { pinnedSkillKeys } = get();
        if (pinnedSkillKeys.includes(skillKey)) {
          set({ pinnedSkillKeys: pinnedSkillKeys.filter((k) => k !== skillKey) });
        } else {
          set({ pinnedSkillKeys: [...pinnedSkillKeys, skillKey] });
        }
      },

      getVisibleSkills: (role?: UserRole) => {
        const { skills, pinnedSkillKeys } = get();
        let filtered = skills.filter((s) => s.isEnabled);

        // 角色过滤
        if (role) {
          filtered = filtered.filter(
            (s) => s.roles.length === 0 || s.roles.includes(role)
          );
        }

        // 排序：置顶优先，然后按 order
        return filtered.sort((a, b) => {
          const aPinned = pinnedSkillKeys.includes(a.skillKey) ? 0 : 1;
          const bPinned = pinnedSkillKeys.includes(b.skillKey) ? 0 : 1;
          if (aPinned !== bPinned) return aPinned - bPinned;
          return a.order - b.order;
        });
      },
    }),
    {
      name: 'prd-skill-store',
      version: 2,
      // 只持久化本地偏好
      partialize: (state) => ({
        pinnedSkillKeys: state.pinnedSkillKeys,
      }),
    }
  )
);
