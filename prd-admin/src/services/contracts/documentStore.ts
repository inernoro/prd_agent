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
  isPaused?: boolean;
  /** 最近一次"内容真正发生变化"的时间，用于在文件树上展示 (new) 徽标 */
  lastChangedAt?: string;
  contentHash?: string;
  contentIndex?: string;
  createdAt: string;
  updatedAt: string;
};

/** 知识库 Agent Run（字幕生成 + 文档再加工共用） */
export type DocumentStoreAgentRun = {
  id: string;
  kind: 'subtitle' | 'reprocess';
  sourceEntryId: string;
  storeId: string;
  userId: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  phase: string;
  progress: number;
  errorMessage?: string;
  outputEntryId?: string;
  templateKey?: string;
  customPrompt?: string;
  generatedText?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
};

/** 再加工模板定义 */
export type ReprocessTemplate = {
  key: string;
  label: string;
  description: string;
};

/** 订阅同步日志中的单条事件（只包含 change/error，不包含无变化的心跳） */
export type DocumentSyncLogEntry = {
  id: string;
  syncedAt: string;
  /** "change" 表示内容变化；"error" 表示同步出错 */
  kind: 'change' | 'error';
  /** 一句话描述本次变化（如 "正文 +120 字节"、"+3 ~2 -1 文件"） */
  changeSummary?: string;
  /** GitHub 目录同步时的逐文件变化（其他类型为空） */
  fileChanges?: { path: string; action: 'added' | 'updated' | 'deleted' }[];
  previousLength?: number;
  currentLength?: number;
  errorMessage?: string;
  durationMs: number;
};

/** 订阅详情接口的响应：当前订阅状态 + 最近变化日志列表 */
export type SubscriptionDetail = {
  entry: {
    id: string;
    title: string;
    sourceType: string;
    sourceUrl?: string;
    syncIntervalMinutes?: number;
    syncStatus?: string;
    syncError?: string;
    lastSyncAt?: string;
    lastChangedAt?: string;
    isPaused: boolean;
    contentHash?: string;
    metadata: Record<string, string>;
    nextSyncAt?: string;
  };
  logs: DocumentSyncLogEntry[];
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

// ── 批次 C：浏览事件 ──

export type DocumentStoreViewEvent = {
  id: string;
  entryId?: string;
  entryTitle?: string | null;
  viewerUserId?: string;
  viewerName: string;
  viewerAvatar?: string;
  enteredAt: string;
  leftAt?: string;
  durationMs?: number;
  userAgent?: string;
  referer?: string;
};

export type DocumentStoreViewStats = {
  totalViews: number;
  uniqueVisitors: number;
  totalDurationMs: number;
};

// ── 批次 D：划词评论 ──

export type DocumentInlineComment = {
  id: string;
  storeId: string;
  entryId: string;
  documentId: string;
  contentHash?: string;
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
  startOffset: number;
  endOffset: number;
  content: string;
  authorUserId: string;
  authorDisplayName: string;
  authorAvatar?: string;
  /** active = 在当前正文里能找到并高亮；orphaned = 文档更新后失锚 */
  status: 'active' | 'orphaned';
  createdAt: string;
  updatedAt?: string;
};
