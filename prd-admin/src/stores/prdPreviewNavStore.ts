import { create } from 'zustand';

export type DocCitation = {
  headingTitle: string;
  headingId: string;
  excerpt: string;
  score?: number | null;
  rank?: number | null;
  documentId?: string | null;
  documentLabel?: string | null;
  verified?: boolean;
};

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

  openWithCitations: ({ targetHeadingId, targetHeadingTitle, citations, activeCitationIndex }) => set(() => ({
    targetHeadingId: targetHeadingId ? String(targetHeadingId).trim() : null,
    targetHeadingTitle: targetHeadingTitle ? String(targetHeadingTitle).trim() : null,
    citations: Array.isArray(citations) ? citations : [],
    activeCitationIndex: typeof activeCitationIndex === 'number' && Number.isFinite(activeCitationIndex) ? Math.max(0, activeCitationIndex) : 0,
  })),

  consumeTarget: () => set(() => ({ targetHeadingId: null, targetHeadingTitle: null })),

  setActiveCitationIndex: (idx) => set((state) => ({
    activeCitationIndex: Math.max(0, Math.min((state.citations?.length ?? 0) - 1, idx)),
  })),

  clear: () => set(() => ({ targetHeadingId: null, targetHeadingTitle: null, citations: [], activeCitationIndex: 0 })),
}));
