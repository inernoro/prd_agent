import { create } from 'zustand';
import type { DocCitation } from '../types';

type PrdPreviewNavState = {
  targetHeadingId: string | null;
  targetHeadingTitle: string | null;
  citations: DocCitation[];
  activeCitationIndex: number;

  openWithCitations: (args: {
    targetHeadingId?: string | null;
    targetHeadingTitle?: string | null;
    citations: DocCitation[];
    activeCitationIndex?: number;
  }) => void;
  consumeTarget: () => void;
  setActiveCitationIndex: (idx: number) => void;
  clear: () => void;
};

export const usePrdPreviewNavStore = create<PrdPreviewNavState>((set) => ({
  targetHeadingId: null,
  targetHeadingTitle: null,
  citations: [],
  activeCitationIndex: 0,

  openWithCitations: ({ targetHeadingId, targetHeadingTitle, citations, activeCitationIndex }) => set(() => {
    const next = {
      targetHeadingId: targetHeadingId ? String(targetHeadingId).trim() : null,
      targetHeadingTitle: targetHeadingTitle ? String(targetHeadingTitle).trim() : null,
      citations: Array.isArray(citations) ? citations : [],
      activeCitationIndex: typeof activeCitationIndex === 'number' && Number.isFinite(activeCitationIndex) ? Math.max(0, activeCitationIndex) : 0,
    };
    return next;
  }),

  consumeTarget: () => set(() => ({ targetHeadingId: null, targetHeadingTitle: null })),

  setActiveCitationIndex: (idx) => set((state) => {
    return {
      activeCitationIndex: Math.max(0, Math.min((state.citations?.length ?? 0) - 1, idx)),
    };
  }),

  clear: () => set(() => ({ targetHeadingId: null, targetHeadingTitle: null, citations: [], activeCitationIndex: 0 })),
}));
