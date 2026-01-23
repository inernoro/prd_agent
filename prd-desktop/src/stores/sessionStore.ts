import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { InteractionMode, PromptItem, PromptsClientResponse, Session, UserRole } from '../types';

interface SessionState {
  sessionId: string | null;
  activeGroupId: string | null;
  lastGroupSeqByGroup: Record<string, number>;
  currentRole: UserRole;
  mode: InteractionMode;
  previousMode: InteractionMode | null;
  prompts: PromptItem[] | null;
  promptsUpdatedAt: string | null;

  setSession: (session: Session) => void;
  setActiveGroupId: (groupId: string | null) => void;
  setActiveGroupContext: (groupId: string) => void;
  getLastGroupSeq: (groupId: string) => number;
  setLastGroupSeq: (groupId: string, seq: number) => void;
  setRole: (role: UserRole) => void;
  setMode: (mode: InteractionMode) => void;
  openPrdPreviewPage: () => void;
  backFromPrdPreview: () => void;
  setPrompts: (resp: PromptsClientResponse) => void;
  clearContext: () => void;
  clearSession: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessionId: null,
      activeGroupId: null,
      lastGroupSeqByGroup: {},
      currentRole: 'PM',
      mode: 'QA',
      previousMode: null,
      prompts: null,
      promptsUpdatedAt: null,

      setSession: (session) => set({
        sessionId: session.sessionId,
        activeGroupId: session.groupId ?? null,
        currentRole: session.currentRole,
        mode: session.mode,
      }),

      setActiveGroupId: (groupId) => set({ activeGroupId: groupId }),

      setActiveGroupContext: (groupId) => set((state) => ({
        sessionId: null,
        activeGroupId: groupId,
        currentRole: state.currentRole ?? 'PM',
        mode: 'QA',
        previousMode: null,
      })),

      getLastGroupSeq: (groupId) => {
        const gid = String(groupId || '').trim();
        if (!gid) return 0;
        const map = get().lastGroupSeqByGroup as Record<string, number> | undefined;
        const v = map?.[gid];
        return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
      },

      setLastGroupSeq: (groupId, seq) => set((state) => {
        const gid = String(groupId || '').trim();
        const s = Number(seq);
        if (!gid) return state;
        if (!Number.isFinite(s) || s <= 0) return state;
        const prev = state.lastGroupSeqByGroup?.[gid] ?? 0;
        if (s <= prev) return state;
        return { lastGroupSeqByGroup: { ...(state.lastGroupSeqByGroup || {}), [gid]: Math.floor(s) } };
      }),

      setRole: (role) => set({ currentRole: role }),

      setMode: (mode) => set((state) => ({
        mode,
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

      setPrompts: (resp) => set(() => {
        const prompts = Array.isArray(resp?.prompts) ? resp.prompts : null;
        const updatedAt = typeof resp?.updatedAt === 'string' ? resp.updatedAt : null;
        return { prompts, promptsUpdatedAt: updatedAt };
      }),

      clearContext: () => set((state) => ({
        sessionId: state.sessionId ?? null,
        activeGroupId: state.activeGroupId ?? null,
        currentRole: state.currentRole ?? 'PM',
        mode: 'QA',
        previousMode: null,
        prompts: state.prompts ?? null,
        promptsUpdatedAt: state.promptsUpdatedAt ?? null,
      })),

      clearSession: () => set({
        sessionId: null,
        activeGroupId: null,
        lastGroupSeqByGroup: {},
        currentRole: 'PM',
        mode: 'QA',
        previousMode: null,
        prompts: null,
        promptsUpdatedAt: null,
      }),
    }),
    {
      name: 'session-storage',
      version: 2,
      partialize: (s) => ({
        sessionId: s.sessionId,
        activeGroupId: s.activeGroupId,
        lastGroupSeqByGroup: s.lastGroupSeqByGroup,
        currentRole: s.currentRole,
        mode: s.mode,
        previousMode: s.previousMode,
        prompts: s.prompts,
        promptsUpdatedAt: s.promptsUpdatedAt,
      }),
      onRehydrateStorage: () => (state, err) => {
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
