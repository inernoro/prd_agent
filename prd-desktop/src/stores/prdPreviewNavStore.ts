import { create } from 'zustand';
import type { DocCitation } from '../types';

type PrdPreviewNavState = {
  targetHeadingId: string | null;
  citations: DocCitation[];
  activeCitationIndex: number;

  openWithCitations: (args: { targetHeadingId: string; citations: DocCitation[]; activeCitationIndex?: number }) => void;
  setActiveCitationIndex: (idx: number) => void;
  clear: () => void;
};

export const usePrdPreviewNavStore = create<PrdPreviewNavState>((set) => ({
  targetHeadingId: null,
  citations: [],
  activeCitationIndex: 0,

  openWithCitations: ({ targetHeadingId, citations, activeCitationIndex }) => set({
    targetHeadingId,
    citations: Array.isArray(citations) ? citations : [],
    activeCitationIndex: typeof activeCitationIndex === 'number' && Number.isFinite(activeCitationIndex) ? Math.max(0, activeCitationIndex) : 0,
  }),

  setActiveCitationIndex: (idx) => set((state) => ({
    activeCitationIndex: Math.max(0, Math.min((state.citations?.length ?? 0) - 1, idx)),
  })),

  clear: () => set({ targetHeadingId: null, citations: [], activeCitationIndex: 0 }),
}));
