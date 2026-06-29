/**
 * 双链 + 反向链接 + 宇宙图 service。
 *
 * 详见后端 MentionsController + doc/design.knowledge-base.mention-network.md。
 */
import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';

export interface BacklinkCard {
  mentionId: string;
  fromEntryId: string;
  fromTitle: string;
  fromSummary?: string | null;
  fromUpdatedAt?: string;
  fromUpdatedByName?: string | null;
  anchorText: string;
  context: string;
  isAutoDetected: boolean;
  createdAt: string;
}

export interface ForwardLinkCard {
  mentionId: string;
  toEntryId: string;
  toTitle: string;
  toSummary?: string | null;
  anchorText: string;
}

export interface DocumentLinksResponse {
  entryId: string;
  backlinks: BacklinkCard[];
  forwardLinks: ForwardLinkCard[];
  backlinksCount: number;
  forwardLinksCount: number;
}

export interface GraphNode {
  id: string;
  title: string;
  summary?: string | null;
  tags?: string[];
  category?: string | null;
  updatedAt?: string;
  createdAt?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  anchorText: string;
  isAutoDetected: boolean;
}

export interface StoreGraphResponse {
  storeId: string;
  storeName: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { nodeCount: number; edgeCount: number };
}

export interface SuggestItem {
  entryId: string;
  title: string;
  summary?: string | null;
  updatedAt?: string;
}

export async function getDocumentLinks(entryId: string) {
  return await apiRequest<DocumentLinksResponse>(api.documentStore.mentions.documentLinks(entryId), {
    method: 'GET',
  });
}

export async function getStoreGraph(storeId: string) {
  return await apiRequest<StoreGraphResponse>(api.documentStore.mentions.storeGraph(storeId), {
    method: 'GET',
  });
}

export async function suggestLinks(storeId: string, q: string, limit = 10) {
  return await apiRequest<{ items: SuggestItem[]; total: number }>(
    api.documentStore.mentions.suggest(storeId, q, limit),
    { method: 'GET' },
  );
}
