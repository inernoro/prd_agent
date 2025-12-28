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
};

export type ExportConfigContract = () => Promise<ApiResponse<ExportedConfig>>;
export type ImportConfigContract = (input: DataConfigImportRequest) => Promise<ApiResponse<DataConfigImportResponse>>;
export type PreviewImportConfigContract = (input: DataConfigImportRequest) => Promise<ApiResponse<DataConfigImportPreviewResponse>>;
export type GetDataSummaryContract = () => Promise<ApiResponse<DataSummaryResponse>>;
export type PurgeDataContract = (input: DataPurgeRequest, idempotencyKey?: string) => Promise<ApiResponse<DataPurgeResponse>>;


