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
  documentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type DocumentEntry = {
  id: string;
  storeId: string;
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
  createdAt: string;
  updatedAt: string;
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
