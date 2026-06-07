import type { ApiResponse } from '@/types/api';

export type SpeechDeckMode = 'mindmap';
export type SpeechDeckSourceType = 'document' | 'upload' | 'paste';
export type SpeechDeckStatus = 'draft' | 'generating' | 'ready' | 'failed';
export type SpeechNodeStatus = 'pending' | 'generating' | 'ready' | 'failed';

export interface SpeechDeck {
  id: string;
  ownerUserId: string;
  title: string;
  mode: SpeechDeckMode;
  sourceType: SpeechDeckSourceType;
  sourceRefId?: string | null;
  sourceText: string;
  audience: string;
  style: string;
  depth: number;
  theme: string;
  illustrationStyle?: string;
  status: SpeechDeckStatus;
  errorMessage?: string | null;
  coverImageAssetId?: string | null;
  model?: string | null;
  platform?: string | null;
  nodeCount: number;
  publishedSiteId?: string | null;
  publishedShareToken?: string | null;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpeechNode {
  id: string;
  deckId: string;
  parentId?: string | null;
  order: number;
  depth: number;
  title: string;
  bulletPoints: string[];
  speakerNotes?: string | null;
  imageAssetId?: string | null;
  imageUrl?: string | null;
  status: SpeechNodeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSpeechDeckInput {
  title?: string;
  sourceType?: SpeechDeckSourceType;
  sourceRefId?: string;
  sourceText: string;
  audience?: string;
  style?: string;
  depth?: number;
}

export interface UpdateSpeechDeckInput {
  title?: string;
  audience?: string;
  style?: string;
  depth?: number;
  theme?: string;
  illustrationStyle?: string;
}

export interface UpdateSpeechNodeInput {
  title?: string;
  bulletPoints?: string[];
  speakerNotes?: string;
}

export interface SpeechAgentApi {
  listDecks: (page?: number, pageSize?: number) => Promise<ApiResponse<{ items: SpeechDeck[]; total: number; page: number; pageSize: number }>>;
  getDeck: (deckId: string) => Promise<ApiResponse<{ deck: SpeechDeck; nodes: SpeechNode[] }>>;
  createDeck: (input: CreateSpeechDeckInput) => Promise<ApiResponse<{ deck: SpeechDeck }>>;
  createFromDocument: (input: { entryId: string; title?: string; audience?: string; style?: string; depth?: number; illustrationStyle?: string }) => Promise<ApiResponse<{ deck: SpeechDeck }>>;
  updateDeck: (deckId: string, input: UpdateSpeechDeckInput) => Promise<ApiResponse<{ updated: true }>>;
  deleteDeck: (deckId: string) => Promise<ApiResponse<{ deleted: true }>>;
  updateNode: (deckId: string, nodeId: string, input: UpdateSpeechNodeInput) => Promise<ApiResponse<{ updated: true }>>;
  generateNodeImage: (deckId: string, nodeId: string) => Promise<ApiResponse<{ imageAssetId: string; url: string }>>;
  generateNodeNotes: (deckId: string, nodeId: string) => Promise<ApiResponse<{ speakerNotes: string }>>;
  generateNotesBatch: (deckId: string) => Promise<ApiResponse<{ generated: number; total: number }>>;
  rewriteNode: (deckId: string, nodeId: string, style: string) => Promise<ApiResponse<{ title: string; bulletPoints: string[] }>>;
  publishDeck: (deckId: string) => Promise<ApiResponse<{ siteId: string; shareToken: string; shareUrl: string }>>;
}
