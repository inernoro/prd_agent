import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Document, InteractionMode, Session, UserRole } from '../types';

interface SessionState {
  sessionId: string | null;
  activeGroupId: string | null;
  documentLoaded: boolean;
  document: Document | null;
  currentRole: UserRole;
  mode: InteractionMode;
  previousMode: InteractionMode | null;
  guideStep: number;
  
  setSession: (session: Session, doc: Document) => void;
  setActiveGroupId: (groupId: string | null) => void;
  setActiveGroupContext: (groupId: string) => void;
  setRole: (role: UserRole) => void;
  setMode: (mode: InteractionMode) => void;
  openPrdPreviewPage: () => void;
  backFromPrdPreview: () => void;
  setGuideStep: (step: number) => void;
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
      })),

      setRole: (role) => set({ currentRole: role }),

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

      setGuideStep: (step) => set({ guideStep: step }),

      clearSession: () => set({
        sessionId: null,
        activeGroupId: null,
        documentLoaded: false,
        document: null,
        currentRole: 'PM',
        mode: 'QA',
        previousMode: null,
        guideStep: 1,
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
