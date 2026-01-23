import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Document, InteractionMode, PromptItem, PromptsClientResponse, Session, UserRole } from '../types';

interface SessionState {
  sessionId: string | null;
  activeGroupId: string | null;
  lastGroupSeqByGroup: Record<string, number>;
  documentLoaded: boolean;
  document: Document | null;
  currentRole: UserRole;
  mode: InteractionMode;
  previousMode: InteractionMode | null;
  prompts: PromptItem[] | null;
  promptsUpdatedAt: string | null;
  
  setSession: (session: Session, doc: Document) => void;
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
      documentLoaded: false,
      document: null,
      currentRole: 'PM',
      mode: 'QA',
      previousMode: null,
      prompts: null,
      promptsUpdatedAt: null,

      setSession: (session, doc) => set({
        sessionId: session.sessionId,
        activeGroupId: session.groupId ?? null,
        documentLoaded: true,
        document: doc,
        currentRole: session.currentRole,
        mode: session.mode,
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

      setPrompts: (resp) => set(() => {
        const prompts = Array.isArray(resp?.prompts) ? resp.prompts : null;
        const updatedAt = typeof resp?.updatedAt === 'string' ? resp.updatedAt : null;
        return { prompts, promptsUpdatedAt: updatedAt };
      }),

      // 仅清理“当前上下文”（不登出、不清群组列表、不清 prompts）
      // - 不应影响 PRD 绑定与会话（否则 UI 会误显示“未绑定 PRD”）
      // - 仅用于把页面状态从 PrdPreview 等拉回到 QA，避免“清理后仍停留在预览页”的错觉
      clearContext: () => set((state) => ({
        sessionId: state.sessionId ?? null,
        activeGroupId: state.activeGroupId ?? null,
        documentLoaded: state.documentLoaded ?? false,
        document: state.document ?? null,
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
        documentLoaded: false,
        document: null,
        currentRole: 'PM',
        mode: 'QA',
        previousMode: null,
        prompts: null,
        promptsUpdatedAt: null,
      }),
    }),
    {
      name: 'session-storage',
      version: 1,
      partialize: (s) => ({
        sessionId: s.sessionId,
        activeGroupId: s.activeGroupId,
        lastGroupSeqByGroup: s.lastGroupSeqByGroup,
        documentLoaded: s.documentLoaded,
        document: s.document,
        currentRole: s.currentRole,
        mode: s.mode,
        previousMode: s.previousMode,
        prompts: s.prompts,
        promptsUpdatedAt: s.promptsUpdatedAt,
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
