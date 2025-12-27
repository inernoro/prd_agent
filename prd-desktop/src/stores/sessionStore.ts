import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Document, InteractionMode, PromptStageEnumItem, PromptStagesClientResponse, Session, UserRole } from '../types';

interface SessionState {
  sessionId: string | null;
  activeGroupId: string | null;
  documentLoaded: boolean;
  document: Document | null;
  currentRole: UserRole;
  mode: InteractionMode;
  previousMode: InteractionMode | null;
  guideStep: number;
  activeStageKey: string | null;
  promptStages: PromptStageEnumItem[] | null;
  promptStagesUpdatedAt: string | null;
  
  setSession: (session: Session, doc: Document) => void;
  setActiveGroupId: (groupId: string | null) => void;
  setActiveGroupContext: (groupId: string) => void;
  setRole: (role: UserRole) => void;
  setMode: (mode: InteractionMode) => void;
  openPrdPreviewPage: () => void;
  backFromPrdPreview: () => void;
  setGuideStep: (step: number) => void;
  setActiveStageKey: (stageKey: string | null) => void;
  setPromptStages: (resp: PromptStagesClientResponse) => void;
  clearSession: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      sessionId: null,
      activeGroupId: null,
      documentLoaded: false,
      document: null,
      currentRole: 'PM',
      mode: 'QA',
      previousMode: null,
      guideStep: 1,
      activeStageKey: null,
      promptStages: null,
      promptStagesUpdatedAt: null,

      setSession: (session, doc) => set({
        sessionId: session.sessionId,
        activeGroupId: session.groupId ?? null,
        documentLoaded: true,
        document: doc,
        currentRole: session.currentRole,
        mode: session.mode,
        guideStep: session.guideStep ?? 1,
      }),

      setActiveGroupId: (groupId) => set({ activeGroupId: groupId }),

      // 仅切换当前群组上下文（用于“未绑定 PRD 的群组”），必须清空旧 session/document，避免串信息
      setActiveGroupContext: (groupId) => set((state) => ({
        sessionId: null,
        activeGroupId: groupId,
        documentLoaded: false,
        document: null,
        currentRole: state.currentRole ?? 'PM',
        mode: 'QA',
        previousMode: null,
        guideStep: 1,
        activeStageKey: null,
      })),

      setRole: (role) => set((state) => {
        const list = Array.isArray(state.promptStages) ? state.promptStages : [];
        const byRole = list.filter((s) => s.role === role).sort((a, b) => a.order - b.order);
        const currentKey = state.activeStageKey;
        const keep = currentKey && byRole.some((s) => s.stageKey === currentKey);
        const nextKey = keep ? currentKey : (byRole[0]?.stageKey ?? null);
        const nextStep = byRole.find((s) => s.stageKey === nextKey)?.order ?? state.guideStep;
        return { currentRole: role, activeStageKey: nextKey, guideStep: nextStep };
      }),

      setMode: (mode) => set((state) => ({
        mode,
        // 只要离开 PRD 预览页，就清空 previousMode，避免“跨页面返回”错乱
        previousMode: mode === 'PrdPreview' ? state.previousMode : null,
      })),

      openPrdPreviewPage: () => set((state) => ({
        previousMode: state.mode,
        mode: 'PrdPreview',
      })),

      backFromPrdPreview: () => set((state) => ({
        mode: (state.previousMode && state.previousMode !== 'PrdPreview') ? state.previousMode : 'QA',
        previousMode: null,
      })),

      setGuideStep: (step) => set((state) => {
        const list = Array.isArray(state.promptStages) ? state.promptStages : [];
        const found = list.find((s) => s.role === state.currentRole && s.order === step);
        return {
          guideStep: step,
          activeStageKey: found?.stageKey ?? state.activeStageKey,
        };
      }),

      setActiveStageKey: (stageKey) => set((state) => {
        const k = (stageKey ?? '').trim();
        if (!k) return { activeStageKey: null };
        const list = Array.isArray(state.promptStages) ? state.promptStages : [];
        const found = list.find((s) => s.stageKey === k);
        return {
          activeStageKey: k,
          guideStep: found ? (found.order || state.guideStep) : state.guideStep,
        };
      }),

      setPromptStages: (resp) => set((state) => {
        const stages = Array.isArray(resp?.stages) ? resp.stages : null;
        const updatedAt = typeof resp?.updatedAt === 'string' ? resp.updatedAt : null;
        const currentKey = state.activeStageKey;
        if (currentKey && stages?.some((s) => s.stageKey === currentKey)) {
          return { promptStages: stages, promptStagesUpdatedAt: updatedAt };
        }
        // 尝试用 currentRole + guideStep 映射 stageKey；否则取该角色第一项
        const step = state.guideStep ?? 1;
        const found = stages?.find((s) => s.role === state.currentRole && s.order === step);
        const byRole = stages?.filter((s) => s.role === state.currentRole).sort((a, b) => a.order - b.order) ?? [];
        const nextKey = found?.stageKey ?? byRole[0]?.stageKey ?? state.activeStageKey;
        const nextStep = stages?.find((s) => s.stageKey === nextKey)?.order ?? state.guideStep;
        return {
          promptStages: stages,
          promptStagesUpdatedAt: updatedAt,
          activeStageKey: nextKey ?? state.activeStageKey,
          guideStep: nextStep,
        };
      }),

      clearSession: () => set({
        sessionId: null,
        activeGroupId: null,
        documentLoaded: false,
        document: null,
        currentRole: 'PM',
        mode: 'QA',
        previousMode: null,
        guideStep: 1,
        activeStageKey: null,
        // promptStages 属于全局枚举，保留；若用户退出登录，App 会重新拉取/覆盖
        promptStages: null,
        promptStagesUpdatedAt: null,
      }),
    }),
    {
      name: 'session-storage',
      version: 1,
      partialize: (s) => ({
        sessionId: s.sessionId,
        activeGroupId: s.activeGroupId,
        documentLoaded: s.documentLoaded,
        document: s.document,
        currentRole: s.currentRole,
        mode: s.mode,
        previousMode: s.previousMode,
        guideStep: s.guideStep,
        activeStageKey: s.activeStageKey,
        promptStages: s.promptStages,
        promptStagesUpdatedAt: s.promptStagesUpdatedAt,
      }),
      onRehydrateStorage: () => (state, err) => {
        // 修复：刷新/重启时停留在 PrdPreview，会导致用户误以为“聊天丢失”，且会影响消息线程切换。
        // 这里将 PrdPreview 视为一次性页面：rehydrate 后自动返回上一模式（或 QA）。
        if (!err && (state as any)?.mode === 'PrdPreview' && typeof (state as any)?.backFromPrdPreview === 'function') {
          try {
            (state as any).backFromPrdPreview();
          } catch {
            // ignore
          }
        }
      },
    }
  )
);
