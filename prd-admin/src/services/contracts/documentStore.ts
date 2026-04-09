import type { ApiResponse } from '@/types/api';

// ── 数据类型 ──

export type DocumentStore = {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  appKey?: string;
  tags: string[];
  isPublic: boolean;
  primaryEntryId?: string;
  pinnedEntryIds: string[];
  documentCount: number;
  likeCount: number;
  viewCount: number;
  favoriteCount: number;
  coverImageUrl?: string;
  createdAt: string;
  updatedAt: string;
};

/** 公开知识库（首页/library 页展示用） */
export type PublicDocumentStore = {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  documentCount: number;
  likeCount: number;
  viewCount: number;
  favoriteCount: number;
  coverImageUrl?: string;
  ownerName: string;
  ownerAvatar?: string;
  createdAt: string;
  updatedAt: string;
};

/** 公开知识库详情（含点赞/收藏状态） */
export type PublicStoreDetail = PublicDocumentStore & {
  primaryEntryId?: string;
  pinnedEntryIds: string[];
  likedByMe: boolean;
  favoritedByMe: boolean;
};

/** 知识库分享链接 */
export type DocumentStoreShareLink = {
  id: string;
  token: string;
  storeId: string;
  storeName: string;
  title?: string;
  description?: string;
  viewCount: number;
  lastViewedAt?: string;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  expiresAt?: string;
  isRevoked: boolean;
};

export type DocumentEntry = {
  id: string;
  storeId: string;
  parentId?: string;
  isFolder: boolean;
  documentId?: string;
  attachmentId?: string;
  title: string;
  summary?: string;
  sourceType: string;
  contentType: string;
  fileSize: number;
  tags: string[];
  metadata: Record<string, string>;
  createdBy: string;
  // 同步字段
  sourceUrl?: string;
  syncIntervalMinutes?: number;
  lastSyncAt?: string;
  syncStatus?: string;
  syncError?: string;
  contentIndex?: string;
  createdAt: string;
  updatedAt: string;
};

export type DocumentStoreWithPreview = DocumentStore & {
  recentEntries: { id: string; title: string; updatedAt: string; contentType: string }[];
};

/** 我收藏/点赞的知识库（用于 DocumentStorePage 的"我的收藏"/"我的点赞"标签） */
export type InteractionStoreCard = DocumentStoreWithPreview & {
  ownerName: string;
  ownerAvatar?: string;
  isOwner: boolean;
};

// ── 请求类型 ──

export type CreateDocumentStoreInput = {
  name: string;
  description?: string;
  appKey?: string;
  tags?: string[];
  isPublic?: boolean;
};

export type UpdateDocumentStoreInput = {
  name?: string;
  description?: string;
  tags?: string[];
  isPublic?: boolean;
};

export type AddDocumentEntryInput = {
  documentId?: string;
  attachmentId?: string;
  title: string;
  summary?: string;
  sourceType?: string;
  contentType?: string;
  fileSize?: number;
  tags?: string[];
  metadata?: Record<string, string>;
};

export type UpdateDocumentEntryInput = {
  title?: string;
  summary?: string;
  tags?: string[];
  metadata?: Record<string, string>;
};

// ── Contract 签名 ──

export type CreateDocumentStoreContract = (
  input: CreateDocumentStoreInput,
) => Promise<ApiResponse<DocumentStore>>;

export type ListDocumentStoresContract = (
  page?: number,
  pageSize?: number,
) => Promise<ApiResponse<{ items: DocumentStore[]; total: number; page: number; pageSize: number }>>;

export type GetDocumentStoreContract = (
  storeId: string,
) => Promise<ApiResponse<DocumentStore>>;

export type UpdateDocumentStoreContract = (
  storeId: string,
  input: UpdateDocumentStoreInput,
) => Promise<ApiResponse<DocumentStore>>;

export type DeleteDocumentStoreContract = (
  storeId: string,
) => Promise<ApiResponse<{ deletedEntries: number }>>;

export type AddDocumentEntryContract = (
  storeId: string,
  input: AddDocumentEntryInput,
) => Promise<ApiResponse<DocumentEntry>>;

export type ListDocumentEntriesContract = (
  storeId: string,
  page?: number,
  pageSize?: number,
  keyword?: string,
) => Promise<ApiResponse<{ items: DocumentEntry[]; total: number; page: number; pageSize: number }>>;

export type UpdateDocumentEntryContract = (
  entryId: string,
  input: UpdateDocumentEntryInput,
) => Promise<ApiResponse<DocumentEntry>>;

export type DeleteDocumentEntryContract = (
  entryId: string,
) => Promise<ApiResponse<{ deleted: boolean }>>;
