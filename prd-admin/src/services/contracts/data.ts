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

export type DataConfigImportOptions = {
  applyMain: boolean;
  applyIntent: boolean;
  applyVision: boolean;
  applyImageGen: boolean;
};

export type DataConfigImportRequest = {
  data: ExportedConfigV1;
  options: DataConfigImportOptions;
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

export type ExportConfigContract = () => Promise<ApiResponse<ExportedConfigV1>>;
export type ImportConfigContract = (input: DataConfigImportRequest) => Promise<ApiResponse<DataConfigImportResponse>>;
export type GetDataSummaryContract = () => Promise<ApiResponse<DataSummaryResponse>>;
export type PurgeDataContract = (input: DataPurgeRequest, idempotencyKey?: string) => Promise<ApiResponse<DataPurgeResponse>>;


