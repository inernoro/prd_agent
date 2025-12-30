import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DocCitation } from '../types';

type PrdCitationPreviewState = {
  isOpen: boolean;
  documentId: string | null;
  groupId: string | null;
  targetHeadingId: string | null;
  targetHeadingTitle: string | null;
  citations: DocCitation[];
  activeCitationIndex: number;
  drawerWidth: number;

  open: (args: {
    documentId: string;
    groupId: string;
    targetHeadingId?: string | null;
    targetHeadingTitle?: string | null;
    citations: DocCitation[];
    activeCitationIndex?: number;
  }) => void;
  close: () => void;
  clear: () => void;
  setDrawerWidth: (width: number) => void;
};

export const usePrdCitationPreviewStore = create<PrdCitationPreviewState>()(
  persist(
    (set) => ({
      isOpen: false,
      documentId: null,
      groupId: null,
      targetHeadingId: null,
      targetHeadingTitle: null,
      citations: [],
      activeCitationIndex: 0,
      drawerWidth: 420,

      open: ({ documentId, groupId, targetHeadingId, targetHeadingTitle, citations, activeCitationIndex }) => set(() => ({
        isOpen: true,
        documentId: String(documentId).trim(),
        groupId: String(groupId).trim(),
        targetHeadingId: targetHeadingId ? String(targetHeadingId).trim() : null,
        targetHeadingTitle: targetHeadingTitle ? String(targetHeadingTitle).trim() : null,
        citations: Array.isArray(citations) ? citations : [],
        activeCitationIndex: typeof activeCitationIndex === 'number' && Number.isFinite(activeCitationIndex) ? Math.max(0, activeCitationIndex) : 0,
      })),

      close: () => set((s) => ({ ...s, isOpen: false })),

      clear: () => set(() => ({
        isOpen: false,
        documentId: null,
        groupId: null,
        targetHeadingId: null,
        targetHeadingTitle: null,
        citations: [],
        activeCitationIndex: 0,
      })),

      setDrawerWidth: (width) => set((state) => {
        const w = Number(width);
        if (!Number.isFinite(w)) return state;
        const next = Math.max(320, Math.min(900, Math.round(w)));
        if (state.drawerWidth === next) return state;
        return { drawerWidth: next };
      }),
    }),
    {
      name: 'prd-citation-preview-storage',
      version: 1,
      partialize: (s) => ({
        drawerWidth: s.drawerWidth,
      }),
    }
  )
);


