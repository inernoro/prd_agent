import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Document, InteractionMode, Session, UserRole } from '../types';

interface SessionState {
  sessionId: string | null;
  activeGroupId: string | null;
  lastGroupSeqByGroup: Record<string, number>;
  documentLoaded: boolean;
  document: Document | null;
  documents: Document[];
  currentRole: UserRole;
  mode: InteractionMode;
  previousMode: InteractionMode | null;

  setSession: (session: Session, doc: Document, docs?: Document[]) => void;
  setDocuments: (docs: Document[]) => void;
  setActiveGroupId: (groupId: string | null) => void;
  setActiveGroupContext: (groupId: string) => void;
  getLastGroupSeq: (groupId: string) => number;
  setLastGroupSeq: (groupId: string, seq: number) => void;
  setRole: (role: UserRole) => void;
  setMode: (mode: InteractionMode) => void;
  openPrdPreviewPage: () => void;
  backFromPrdPreview: () => void;
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
      documents: [],
      currentRole: 'PM',
      mode: 'QA',
      previousMode: null,

      setSession: (session, doc, docs) => set({
        sessionId: session.sessionId,
        activeGroupId: session.groupId ?? null,
        documentLoaded: true,
        document: doc,
        documents: docs ?? [doc],
        currentRole: session.currentRole,
        mode: session.mode,
      }),

      setDocuments: (docs) => set({ documents: docs }),

      setActiveGroupId: (groupId) => set({ activeGroupId: groupId }),

      // 仅切换当前群组上下文（用于"未绑定 PRD 的群组"），必须清空旧 session/document，避免串信息
      setActiveGroupContext: (groupId) => set((state) => ({
        sessionId: null,
        activeGroupId: groupId,
        documentLoaded: false,
        document: null,
        documents: [],
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
        // 只要离开 PRD 预览页，就清空 previousMode，避免"跨页面返回"错乱
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

      // 仅清理"当前上下文"（不登出、不清群组列表）
      clearContext: () => set((state) => ({
        sessionId: state.sessionId ?? null,
        activeGroupId: state.activeGroupId ?? null,
        documentLoaded: state.documentLoaded ?? false,
        document: state.document ?? null,
        documents: state.documents ?? [],
        currentRole: state.currentRole ?? 'PM',
        mode: 'QA',
        previousMode: null,
      })),

      clearSession: () => set({
        sessionId: null,
        activeGroupId: null,
        lastGroupSeqByGroup: {},
        documentLoaded: false,
        document: null,
        documents: [],
        currentRole: 'PM',
        mode: 'QA',
        previousMode: null,
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
      }),
      onRehydrateStorage: () => (state, err) => {
        if (!err && state) {
          const s = state as any;
          // 修复：刷新/重启时停留在 PrdPreview，会导致用户误以为"聊天丢失"
          if (s.mode === 'PrdPreview' && typeof s.backFromPrdPreview === 'function') {
            try { s.backFromPrdPreview(); } catch { /* ignore */ }
          }
          // 清理旧版本残留的 prompts 字段
          delete s.prompts;
          delete s.promptsUpdatedAt;
        }
      },
    }
  )
);
