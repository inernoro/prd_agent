import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SkillItem, SkillsClientResponse, ContextScope, OutputMode, UserRole } from '../types';

interface SkillState {
  // 服务端公共技能
  serverSkills: SkillItem[];
  serverSkillsUpdatedAt: string | null;

  // 客户端本地自定义技能
  localSkills: SkillItem[];

  // 当前选中的技能（用于执行）
  activeSkillKey: string | null;

  // 技能运行时覆盖配置
  runtimeContextScope: ContextScope;
  runtimeOutputMode: OutputMode;

  // actions
  setServerSkills: (resp: SkillsClientResponse) => void;
  addLocalSkill: (skill: SkillItem) => void;
  updateLocalSkill: (skillKey: string, updates: Partial<SkillItem>) => void;
  removeLocalSkill: (skillKey: string) => void;
  setActiveSkillKey: (key: string | null) => void;
  setRuntimeContextScope: (scope: ContextScope) => void;
  setRuntimeOutputMode: (mode: OutputMode) => void;

  // 按角色获取合并后的技能列表（server + local）
  getSkillsForRole: (role: UserRole) => SkillItem[];
}

export const useSkillStore = create<SkillState>()(
  persist(
    (set, get) => ({
      serverSkills: [],
      serverSkillsUpdatedAt: null,
      localSkills: [],
      activeSkillKey: null,
      runtimeContextScope: 'all',
      runtimeOutputMode: 'chat',

      setServerSkills: (resp) => set({
        serverSkills: Array.isArray(resp?.skills) ? resp.skills.map(s => ({ ...s, source: 'server' as const })) : [],
        serverSkillsUpdatedAt: resp?.updatedAt ?? null,
      }),

      addLocalSkill: (skill) => set((state) => ({
        localSkills: [
          ...state.localSkills,
          { ...skill, source: 'local' as const, isEnabled: true },
        ],
      })),

      updateLocalSkill: (skillKey, updates) => set((state) => ({
        localSkills: state.localSkills.map((s) =>
          s.skillKey === skillKey ? { ...s, ...updates } : s
        ),
      })),

      removeLocalSkill: (skillKey) => set((state) => ({
        localSkills: state.localSkills.filter((s) => s.skillKey !== skillKey),
        activeSkillKey: state.activeSkillKey === skillKey ? null : state.activeSkillKey,
      })),

      setActiveSkillKey: (key) => {
        const state = get();
        const all = [...state.serverSkills, ...state.localSkills];
        const skill = all.find((s) => s.skillKey === key);
        set({
          activeSkillKey: key,
          // 选中技能时自动应用其默认上下文/输出配置
          runtimeContextScope: (skill?.contextScope as ContextScope) ?? 'all',
          runtimeOutputMode: (skill?.outputMode as OutputMode) ?? 'chat',
        });
      },

      setRuntimeContextScope: (scope) => set({ runtimeContextScope: scope }),
      setRuntimeOutputMode: (mode) => set({ runtimeOutputMode: mode }),

      getSkillsForRole: (role: UserRole) => {
        const state = get();
        const all = [
          ...state.serverSkills.map(s => ({ ...s, source: 'server' as const })),
          ...state.localSkills.map(s => ({ ...s, source: 'local' as const })),
        ];
        return all
          .filter((s) => s.isEnabled)
          .filter((s) => s.roles.length === 0 || s.roles.includes(role))
          .sort((a, b) => a.order - b.order);
      },
    }),
    {
      name: 'skill-storage',
      version: 1,
      partialize: (s) => ({
        localSkills: s.localSkills,
        runtimeContextScope: s.runtimeContextScope,
        runtimeOutputMode: s.runtimeOutputMode,
      }),
    }
  )
);
