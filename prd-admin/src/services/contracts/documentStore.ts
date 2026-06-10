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
  /** 分享到的团队 ID 列表（仅知识库消费） */
  sharedTeamIds?: string[];
  /** 知识库模板键（如 acceptance-report-v2）。非空时写入条目按模板校验。 */
  templateKey?: string;
  /** 用户自定义 tag 颜色映射（tagName → 调色板 key：red/orange/yellow/green/teal/blue/purple/gray） */
  tagColors?: Record<string, string>;
  /** 可管理的分类清单（知识库一等维度；空=未启用分类） */
  categories?: string[];
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
  /** 非空 = 单篇文档分享；空 = 整库分享 */
  entryId?: string;
  entryTitle?: string;
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

/** 公开分享视图（/s/lib/:token 拉取，匿名可访问） */
export type DocStoreShareView = {
  token: string;
  title?: string;
  description?: string;
  createdByName?: string;
  /** 非空 = 单篇文档分享 */
  entryId?: string;
  entryTitle?: string;
  store: {
    id: string;
    name: string;
    description?: string;
    primaryEntryId?: string;
    pinnedEntryIds?: string[];
    documentCount: number;
    likeCount: number;
    viewCount: number;
  };
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
  /** 分类（取自所属知识库 categories；未分类为空） */
  category?: string;
  /** 关联的产品版本 ID 列表（产品知识库专用；空=未关联） */
  versionIds?: string[];
  metadata: Record<string, string>;
  createdBy: string;
  updatedBy?: string;
  updatedByName?: string;
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
  /** 多轮对话历史（仅 reprocess 模式有内容） */
  messages?: ReprocessChatMessage[];
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
};

/** 文档再加工对话历史中的单条消息 */
export type ReprocessChatMessage = {
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  templateKey?: string;
  createdAt: string;
};

/**
 * 智能体抽屉 direct-chat 对话的后端持久化（关浏览器标签页/换设备都不丢）。
 * messagesJson / pendingImagesJson / activeRefJson 为前端拥有形状的 JSON 字符串，后端不解析。
 */
export type DocumentStoreConversation = {
  id: string;
  userId: string;
  sourceEntryId: string;
  storeId: string;
  messagesJson: string;
  pendingImagesJson: string;
  activeRefJson?: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 再加工模板定义 */
export type ReprocessTemplate = {
  key: string;
  label: string;
  description: string;
};

/** 再加工·可调用智能体（system 内置 + personal 用户自建） */
export type ReprocessAgent = {
  id: string;
  key: string;
  label: string;
  description: string;
  /** 调用时叠加到百宝箱通用 chat 链路里的 system prompt */
  systemPrompt: string;
  visibility: 'system' | 'personal';
  /** 当前登录用户是否为创建者（用于显示删除按钮） */
  isOwn: boolean;
  createdAt: string;
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
  recentEntries: { id: string; title: string; updatedAt: string; contentType: string; tags?: string[] }[];
  /** 是否存在「整库级」有效分享（用于卡片标黄） */
  hasActiveShare?: boolean;
  /** 团队作用域下后端附带的创建者昵称（卡片顶部成员归属展示） */
  ownerName?: string;
  /** 团队作用域下后端附带的创建者头像文件名 */
  ownerAvatarFileName?: string;
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
  templateKey?: string;
};

export type UpdateDocumentStoreInput = {
  name?: string;
  description?: string;
  tags?: string[];
  isPublic?: boolean;
  templateKey?: string;
  /** 用户自定义 tag 颜色映射（tagName → 调色板 key） */
  tagColors?: Record<string, string>;
  /** 可管理的分类清单（null/不传=不变） */
  categories?: string[];
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
  category?: string;
  metadata?: Record<string, string>;
};

export type UpdateDocumentEntryInput = {
  title?: string;
  summary?: string;
  tags?: string[];
  /** 分类（空字符串=清除；不传=不变） */
  category?: string;
  metadata?: Record<string, string>;
  /** 关联的产品版本 ID 列表（传空数组=清空；不传=不变） */
  versionIds?: string[];
  /** 内容 MIME 类型（格式纠错：text/markdown 与 text/html 互转；不传=不变） */
  contentType?: string;
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
) => Promise<ApiResponse<{ items: DocumentEntry[]; total: number; page: number; pageSize: number; sharedEntryIds?: string[] }>>;

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
  storeId?: string;
  entryTitle?: string | null;
  viewerUserId?: string;
  viewerName: string;
  viewerAvatar?: string;
  enteredAt: string;
  leftAt?: string;
  durationMs?: number;
  /** 去重窗口内最后一次访问时间 */
  lastSeenAt?: string;
  /** 去重窗口内的重复访问次数（0 表示仅访问一次） */
  revisitCount?: number;
  userAgent?: string;
  referer?: string;
};

export type DocumentStoreViewStats = {
  totalViews: number;
  uniqueVisitors: number;
  totalDurationMs: number;
};

// ── 波次一：访客聚合报表 ──

export type DocumentStoreAnalytics = {
  rangeDays: number;
  kpi: {
    totalViews: number;
    uniqueVisitors: number;
    totalDurationMs: number;
    avgDurationMs: number;
    /** 0..1：有回访的访客 / 独立访客 */
    returningRate: number;
    /** 0..1：停留 <5s 的事件 / 已测得停留的事件 */
    bounceRate: number;
  };
  /** 按本地时区连续补零的每日访问量 */
  trend: { date: string; views: number }[];
  /** 0-23 时段访问量（已补零） */
  hourly: { hour: number; views: number }[];
  topEntries: { entryId?: string | null; storeId?: string | null; title?: string | null; views: number; totalDurationMs: number }[];
  /** 知识库访问排行（账号级聚合下多个库；单库场景前端隐藏） */
  topStores: { storeId?: string | null; storeName?: string | null; views: number; totalDurationMs: number }[];
  /** 标签访问统计 Top 12 */
  tagStats: { tag: string; views: number }[];
  /** 停留时长分桶（仅统计已测得停留的事件，measured 为分母） */
  dwellBuckets: { lt5s: number; s5_30: number; s30_2m: number; gt2m: number; measured: number };
};

/** 账号级访客总计（我名下所有知识库聚合） */
export type DocumentStoreAccountSummary = {
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
  /** 全文评论：无选区，对整篇文档发表，不参与定位/高亮 */
  isWholeDocument?: boolean;
  content: string;
  authorUserId: string;
  authorDisplayName: string;
  authorAvatar?: string;
  /** active = 在当前正文里能找到并高亮；orphaned = 文档更新后失锚 */
  status: 'active' | 'orphaned';
  createdAt: string;
  updatedAt?: string;
};
