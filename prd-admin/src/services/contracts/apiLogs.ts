import type { ApiResponse } from '@/types/api';

export type ApiLogsListParams = {
  page?: number;
  pageSize?: number;
  from?: string;
  to?: string;
  userId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  requestId?: string;
  clientType?: string;
  clientId?: string;
  groupId?: string;
  sessionId?: string;
  appName?: string;
  direction?: string;
  status?: string;
  /** 过滤噪声日志（如 auth/refresh 等高频无意义请求） */
  excludeNoise?: boolean;
  /** 排除进行中的请求（用于下栏列表） */
  excludeRunning?: boolean;
};

export type ApiLogsListItem = {
  id: string;
  requestId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  userId: string;
  groupId: string | null;
  sessionId: string | null;
  method: string;
  path: string;
  query: string | null;
  absoluteUrl: string | null;
  statusCode: number;
  requestContentType: string | null;
  responseContentType: string | null;
  apiSummary: string | null;
  errorCode: string | null;
  clientType: string | null;
  clientId: string | null;
  appId: string | null;
  appName: string | null;
  clientIp: string | null;
  userAgentPreview: string | null;
  isEventStream: boolean;
  requestBodyPreview: string | null;
  curlPreview: string | null;
  requestBodyTruncated: boolean;
  direction: string | null;
  status: string | null;
  // 注意：responseBody 只在详情接口返回，避免列表循环增长
};

export type ApiLogsListData = {
  items: ApiLogsListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type ApiLogsMetaData = {
  clientTypes: string[];
  methods: string[];
  userIds: string[];
  appNames: string[];
  directions: string[];
  statuses: string[];
};

export type ApiRequestLog = {
  id: string;
  requestId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  method: string;
  path: string;
  query: string | null;
  absoluteUrl: string | null;
  protocol: string | null;
  requestContentType: string | null;
  responseContentType: string | null;
  statusCode: number;
  apiSummary: string | null;
  errorCode: string | null;
  userId: string;
  groupId: string | null;
  sessionId: string | null;
  clientIp: string | null;
  userAgent: string | null;
  clientType: string | null;
  clientId: string | null;
  appId: string | null;
  appName: string | null;
  requestBody: string | null;
  requestBodyTruncated: boolean;
  curl: string | null;
  isEventStream: boolean;
  direction: string | null;
  status: string | null;
  responseBody: string | null;
  responseBodyTruncated: boolean;
  responseBodyBytes: number | null;
  targetHost: string | null;
};

export type GetApiLogsContract = (params?: ApiLogsListParams) => Promise<ApiResponse<ApiLogsListData>>;

export type GetApiLogDetailContract = (id: string) => Promise<ApiResponse<ApiRequestLog>>;

export type GetApiLogsMetaContract = () => Promise<ApiResponse<ApiLogsMetaData>>;

