import type { ApiResponse } from '@/types/api';

// ── 数据模型 ──

export type DataTransferItem = {
  sourceType: 'workspace' | 'literary-prompt' | 'ref-image-config';
  sourceId: string;
  displayName: string;
  appKey?: string | null;
  appKeyDisplayName?: string | null;
  previewInfo?: string | null;
  clonedId?: string | null;
  cloneStatus: 'pending' | 'success' | 'failed' | 'source_missing';
  cloneError?: string | null;
};

export type DataTransferResult = {
  totalItems: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  totalAssetsCopied: number;
  totalMessagesCopied: number;
};

export type AccountDataTransfer = {
  id: string;
  senderUserId: string;
  senderUserName: string;
  senderUserAvatar?: string | null;
  receiverUserId: string;
  receiverUserName?: string | null;
  items: DataTransferItem[];
  status: 'pending' | 'processing' | 'completed' | 'rejected' | 'expired' | 'cancelled' | 'partial' | 'failed';
  message?: string | null;
  result?: DataTransferResult | null;
  createdAt: string;
  updatedAt: string;
  handledAt?: string | null;
  expiresAt: string;
};

// ── 可分享数据清单 ──

export type ShareableWorkspace = {
  id: string;
  title: string;
  scenarioType: string;
  folderName?: string | null;
  assetCount: number;
  coverAssets: Array<{ id: string; url: string; width: number; height: number }>;
  /** 文学创作工作区的文章内容预览（前 200 字） */
  contentPreview?: string | null;
  updatedAt: string;
};

export type ShareablePrompt = {
  id: string;
  title: string;
  sourceType: 'literary-prompt';
};

export type ShareableRefImage = {
  id: string;
  name: string;
  sourceType: 'ref-image-config';
  appKey?: string | null;
};

// ── 请求/响应 ──

export type CreateTransferRequest = {
  receiverUserId: string;
  message?: string;
  items: { sourceType: string; sourceId: string; appKey?: string }[];
};

export type ListTransfersContract = (direction?: 'sent' | 'received') => Promise<ApiResponse<{ items: AccountDataTransfer[] }>>;
export type GetTransferContract = (id: string) => Promise<ApiResponse<{ transfer: AccountDataTransfer }>>;
export type CreateTransferContract = (req: CreateTransferRequest) => Promise<ApiResponse<{ id: string; itemCount: number }>>;
export type AcceptTransferContract = (id: string) => Promise<ApiResponse<{ status: string; result: DataTransferResult }>>;
export type RejectTransferContract = (id: string) => Promise<ApiResponse<{ status: string }>>;
export type CancelTransferContract = (id: string) => Promise<ApiResponse<{ status: string }>>;
export type ListMyWorkspacesContract = (scenarioType?: string) => Promise<ApiResponse<{ items: ShareableWorkspace[] }>>;
export type ListMyConfigsContract = () => Promise<ApiResponse<{ prompts: ShareablePrompt[]; refImages: ShareableRefImage[] }>>;
