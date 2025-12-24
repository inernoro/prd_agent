import { create } from 'zustand';
import type { DocCitation } from '../types';

type PrdCitationPreviewState = {
  isOpen: boolean;
  documentId: string | null;
  groupId: string | null;
  targetHeadingId: string | null;
  targetHeadingTitle: string | null;
  citations: DocCitation[];
  activeCitationIndex: number;

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
};

export const usePrdCitationPreviewStore = create<PrdCitationPreviewState>((set) => ({
  isOpen: false,
  documentId: null,
  groupId: null,
  targetHeadingId: null,
  targetHeadingTitle: null,
  citations: [],
  activeCitationIndex: 0,

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
}));


