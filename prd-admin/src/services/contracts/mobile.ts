import type { ApiResponse } from '@/types/api';

// ─── Feed ───

export interface FeedItem {
  id: string;
  type: 'prd-session' | 'visual-workspace' | 'defect';
  title: string;
  subtitle: string;
  updatedAt: string;
  navigateTo: string;
  coverAssetId?: string;
}

export type GetMobileFeedContract = (args?: {
  limit?: number;
}) => Promise<ApiResponse<{ items: FeedItem[] }>>;

// ─── Stats ───

export interface MobileStats {
  days: number;
  sessions: number;
  messages: number;
  imageGenerations: number;
  totalTokens: number;
}

export type GetMobileStatsContract = (args?: {
  days?: number;
}) => Promise<ApiResponse<MobileStats>>;

// ─── Assets ───

export interface MobileAssetItem {
  id: string;
  type: 'image' | 'document' | 'attachment';
  title: string;
  url: string;
  thumbnailUrl?: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: string;
  workspaceId?: string;
}

export type GetMobileAssetsContract = (args?: {
  category?: 'image' | 'document' | 'attachment';
  limit?: number;
  skip?: number;
}) => Promise<ApiResponse<{ items: MobileAssetItem[]; total: number; hasMore: boolean }>>;
