import type { ApiResponse } from '@/types/api';

export type ExportedConfigV1 = {
  version: 1;
  platforms: Array<{
    name: string;
    platformType: string;
    providerId?: string | null;
    apiUrl: string;
    apiKey: string;
    enabledModels: string[];
  }>;
  purposes?: {
    main?: { platformName: string; modelName: string } | null;
    intent?: { platformName: string; modelName: string } | null;
    vision?: { platformName: string; modelName: string } | null;
    imageGen?: { platformName: string; modelName: string } | null;
  } | null;
};

export type ExportedConfigV2 = {
  version: 2;
  platforms: Array<{
    id: string;
    name: string;
    platformType: string;
    providerId?: string | null;
    apiUrl: string;
    apiKey: string;
    enabledModels: string[];
  }>;
  purposes?: ExportedConfigV1['purposes'];
};

export type ExportedConfig = ExportedConfigV1 | ExportedConfigV2;

export type DataConfigImportOptions = {
  applyMain: boolean;
  applyIntent: boolean;
  applyVision: boolean;
  applyImageGen: boolean;
  forceOverwriteSameName: boolean;
  deleteNotImported: boolean;
};

export type DataConfigImportRequest = {
  data: ExportedConfig;
  options: DataConfigImportOptions;
  confirmed?: boolean;
};

export type DataConfigImportPreviewResponse = {
  version: number;
  importedPlatformCount: number;
  importedEnabledModelCount: number;
  existingPlatformCount: number;
  forceOverwriteSameName: boolean;
  deleteNotImported: boolean;
  willInsertPlatforms: Array<{ id?: string | null; name: string; apiUrl: string }>;
  willUpdatePlatforms: Array<{
    id: string;
    name: string;
    currentApiUrl: string;
    importedApiUrl: string;
    apiUrlChanged: boolean;
  }>;
  urlConflicts: Array<{ id: string; name: string; currentApiUrl: string; importedApiUrl: string }>;
  willDeletePlatforms: Array<{ id: string; name: string; apiUrl?: string | null }>;
  notes: string[];
  requiresConfirmation: boolean;
};

export type DataConfigImportResponse = {
  platformUpserted: number;
  platformInserted: number;
  platformUpdated: number;
  modelUpserted: number;
  modelInserted: number;
  modelUpdated: number;
};

export type DataSummaryResponse = {
  // 核心保留数据（开发期“保留核心清库”会保留这些）
  users?: number;
  llmPlatforms?: number;
  llmModelsTotal?: number;
  llmModelsEnabled?: number;

  llmRequestLogs: number;
  messages: number;
  documents: number;
  attachments: number;
  contentGaps: number;
  prdComments: number;
  imageMasterSessions: number;
  imageMasterMessages: number;
};

export type DataPurgeRequest = {
  domains: string[];
};

export type DataPurgeResponse = {
  llmRequestLogs: number;
  messages: number;
  documents: number;
  attachments: number;
  contentGaps: number;
  prdComments: number;
  imageMasterSessions: number;
  imageMasterMessages: number;

  // devReset：额外统计
  disabledModelsDeleted?: number;
  otherDeleted?: number;
};

export type AdminUserPreviewItem = {
  userId: string;
  username: string;
  displayName: string;
  role: 'PM' | 'DEV' | 'QA' | 'ADMIN';
  userType: 'Human' | 'Bot';
  status: 'Active' | 'Locked';
  createdAt: string;
  lastLoginAt?: string | null;
};

export type AdminUsersPurgePreviewResponse = {
  totalUsers: number;
  adminUsers: number;
  willDeleteUsers: number;
  willKeepUsers: number;
  sampleWillDeleteUsers: AdminUserPreviewItem[];
  sampleWillKeepAdmins: AdminUserPreviewItem[];
  notes: string[];
};

export type AdminUsersPurgeRequest = {
  confirmed: boolean;
};

export type AdminUsersPurgeResponse = {
  usersDeleted: number;
  groupMembersDeleted: number;
};

export type ExportConfigContract = () => Promise<ApiResponse<ExportedConfig>>;
export type ImportConfigContract = (input: DataConfigImportRequest) => Promise<ApiResponse<DataConfigImportResponse>>;
export type PreviewImportConfigContract = (input: DataConfigImportRequest) => Promise<ApiResponse<DataConfigImportPreviewResponse>>;
export type GetDataSummaryContract = () => Promise<ApiResponse<DataSummaryResponse>>;
export type PurgeDataContract = (input: DataPurgeRequest, idempotencyKey?: string) => Promise<ApiResponse<DataPurgeResponse>>;
export type PreviewUsersPurgeContract = (limit?: number) => Promise<ApiResponse<AdminUsersPurgePreviewResponse>>;
export type PurgeUsersContract = (input: AdminUsersPurgeRequest, idempotencyKey?: string) => Promise<ApiResponse<AdminUsersPurgeResponse>>;


