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
  clientIp: string | null;
  userAgentPreview: string | null;
  isEventStream: boolean;
  requestBodyPreview: string | null;
  curlPreview: string | null;
  requestBodyTruncated: boolean;
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
  requestBody: string | null;
  requestBodyTruncated: boolean;
  curl: string | null;
  isEventStream: boolean;
};

export type GetApiLogsContract = (params?: ApiLogsListParams) => Promise<{
  success: boolean;
  data: ApiLogsListData;
  error: { code: string; message: string } | null;
}>;

export type GetApiLogDetailContract = (id: string) => Promise<{
  success: boolean;
  data: ApiRequestLog;
  error: { code: string; message: string } | null;
}>;

export type GetApiLogsMetaContract = () => Promise<{
  success: boolean;
  data: ApiLogsMetaData;
  error: { code: string; message: string } | null;
}>;


