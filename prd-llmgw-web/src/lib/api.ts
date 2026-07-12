// 独立 API 客户端：JWT 存 sessionStorage（no-localStorage 规则：认证态禁止进 localStorage）。
// base 走 import.meta.env.VITE_LLMGW_API_BASE，默认 /gw（dev 由 vite proxy 反代）。
//
// 后端端点约定（后端另做，stub 即可）：
//   POST  {BASE}/auth/login        body { username, password } → { success, data: { token, ... } }
//   GET   {BASE}/logs              query 见 LogsListParams       → { success, data: LogsListData }
//   GET   {BASE}/logs/meta                                       → { success, data: LogsMeta }
//   GET   {BASE}/logs/timeseries   query { from, to, model?, status? } → { success, data: TimeseriesData }
//   GET   {BASE}/logs/sessions     query { from, to, page, pageSize }  → { success, data: SessionsData }
//   GET   {BASE}/logs/:id                                        → { success, data: LlmLogDetail }
//
// 列表数据形状与 /gw 控制台 API 对齐；密钥字段只返回 hasKey，不返回明文或密文。

import type {
  ApiResponse,
  ChangePasswordRequest,
  ChangePasswordResult,
  LoginRequest,
  LoginResult,
  LogsListData,
  LogsListParams,
  LogsMeta,
  LogsSummaryData,
  TenantOverviewData,
  ProtocolCoverageData,
  TimeseriesData,
  SessionsData,
  LlmLogDetail,
  PoolsData,
  PlatformsData,
  ModelsData,
  GatewayAppCallersData,
  GatewayAppCaller,
  UpdateGatewayAppCallerRequest,
  BulkUpdateGatewayAppCallersRequest,
  BulkUpdateGatewayAppCallersResult,
  OperationAuditsData,
  ShadowData,
  ModelPool,
  PlatformItem,
  ModelItem,
  ParameterCapabilitiesMetaData,
  ExchangesData,
  ExchangeItem,
  UpsertPoolModelRequest,
  KeyHealthData,
  CreatePoolRequest,
  UpdatePoolRequest,
  BulkClaimPoolsRequest,
  BulkClaimPoolsResult,
  BulkCalibratePoolPriceCurrencyRequest,
  BulkCalibratePoolPriceCurrencyResult,
  BulkImportPoolModelsRequest,
  BulkImportPoolModelsResult,
  BulkRotateApiKeysRequest,
  BulkRotateApiKeysResult,
  BulkUpdateModelCapabilitiesRequest,
  BulkUpdateModelCapabilitiesResult,
  ConfigAuthorityReportData,
  BulkClaimConfigAuthorityRequest,
  BulkClaimConfigAuthorityResult,
  BindActiveAppCallerPoolsResult,
  RuntimeGatesData,
  ServiceKeyItem,
  CreateServiceKeyRequest,
  CreatedServiceKey,
  OrganizationData,
  CreatedTenant,
  CreatedTeam,
  PromptPolicyData,
  PromptPolicyDraft,
  PromptPolicyPreview,
  PromptPolicyVersion,
  AvailableTenant,
} from './types';

const TOKEN_KEY = 'llmgw.token';
const USER_KEY = 'llmgw.user';
const TENANT_KEY = 'llmgw.tenant';
// 首登强制改密标记（认证态，遵守 no-localStorage 规则走 sessionStorage）。
const MCP_KEY = 'llmgw.mustChangePwd';

export const API_BASE = (import.meta.env.VITE_LLMGW_API_BASE || '/gw').replace(/\/$/, '');

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): { username?: string; displayName?: string } | null {
  const raw = sessionStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getStoredTenant(): import('./types').TenantSession | null {
  const raw = sessionStorage.getItem(TENANT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setSession(result: LoginResult) {
  sessionStorage.setItem(TOKEN_KEY, result.token);
  sessionStorage.setItem(
    USER_KEY,
    JSON.stringify({ username: result.username ?? undefined, displayName: result.displayName ?? undefined }),
  );
  if (result.tenant) sessionStorage.setItem(TENANT_KEY, JSON.stringify(result.tenant));
  else sessionStorage.removeItem(TENANT_KEY);
  if (result.mustChangePassword) sessionStorage.setItem(MCP_KEY, '1');
  else sessionStorage.removeItem(MCP_KEY);
}

// 改密成功后，用重新签发的 token 替换会话并清除强制改密标记。
export function applyChangePasswordResult(result: ChangePasswordResult) {
  sessionStorage.setItem(TOKEN_KEY, result.token);
  sessionStorage.setItem(
    USER_KEY,
    JSON.stringify({ username: result.username ?? undefined, displayName: result.displayName ?? undefined }),
  );
  if (result.tenant) sessionStorage.setItem(TENANT_KEY, JSON.stringify(result.tenant));
  sessionStorage.removeItem(MCP_KEY);
}

export function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
  sessionStorage.removeItem(TENANT_KEY);
  sessionStorage.removeItem(MCP_KEY);
}

export function isAuthed(): boolean {
  return !!getToken();
}

export function mustChangePassword(): boolean {
  return sessionStorage.getItem(MCP_KEY) === '1';
}

type RequestOptions = {
  method?: string;
  /** 原始对象（本函数内部会 JSON.stringify，调用方禁止再序列化）。 */
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
};

function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
  const url = `${API_BASE}${path}${buildQuery(options.query)}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (e) {
    return {
      success: false,
      data: null,
      error: { code: 'NETWORK_ERROR', message: e instanceof Error ? e.message : '网络请求失败' },
    };
  }

  if (res.status === 401) {
    clearSession();
    return { success: false, data: null, error: { code: 'UNAUTHORIZED', message: '登录已失效，请重新登录' } };
  }

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  // 优先认后端的 { success, data, error } 信封；否则按 HTTP 状态包装。
  if (payload && typeof payload === 'object' && 'success' in (payload as Record<string, unknown>)) {
    return payload as ApiResponse<T>;
  }

  if (!res.ok) {
    return {
      success: false,
      data: null,
      error: { code: `HTTP_${res.status}`, message: `请求失败（${res.status}）` },
    };
  }

  return { success: true, data: payload as T, error: null };
}

// ── 鉴权 ──
export function login(req: LoginRequest): Promise<ApiResponse<LoginResult>> {
  return apiRequest<LoginResult>('/auth/login', { method: 'POST', body: req });
}

export function changePassword(req: ChangePasswordRequest): Promise<ApiResponse<ChangePasswordResult>> {
  return apiRequest<ChangePasswordResult>('/auth/change-password', { method: 'POST', body: req });
}

// ── 日志 ──
export function getLogs(params: LogsListParams): Promise<ApiResponse<LogsListData>> {
  return apiRequest<LogsListData>('/logs', { query: { ...params } });
}

export function getHealth(): Promise<ApiResponse<{ status: string; commit?: string | null; time?: string | null }>> {
  return apiRequest<{ status: string; commit?: string | null; time?: string | null }>('/healthz');
}

export function getLogsMeta(): Promise<ApiResponse<LogsMeta>> {
  return apiRequest<LogsMeta>('/logs/meta');
}

export function getLogsSummary(params: LogsListParams): Promise<ApiResponse<LogsSummaryData>> {
  return apiRequest<LogsSummaryData>('/logs/summary', { query: { ...params } });
}

export function getTenantOverview(params: { from: string; to: string }): Promise<ApiResponse<TenantOverviewData>> {
  return apiRequest<TenantOverviewData>('/overview', { query: params });
}

export function getProtocolCoverage(params?: { releaseCommit?: string; sinceHours?: number }): Promise<ApiResponse<ProtocolCoverageData>> {
  return apiRequest<ProtocolCoverageData>('/protocol-coverage', {
    query: { releaseCommit: params?.releaseCommit, sinceHours: params?.sinceHours },
  });
}

export function getLogsTimeseries(params: LogsListParams): Promise<ApiResponse<TimeseriesData>> {
  return apiRequest<TimeseriesData>('/logs/timeseries', { query: { ...params } });
}

export function getLogsSessions(params: LogsListParams): Promise<ApiResponse<SessionsData>> {
  return apiRequest<SessionsData>('/logs/sessions', { query: { ...params } });
}

export function getLogDetail(id: string): Promise<ApiResponse<LlmLogDetail>> {
  return apiRequest<LlmLogDetail>(`/logs/${encodeURIComponent(id)}`);
}

// ── 配置面（只读）──
export function getPools(modelType?: string): Promise<ApiResponse<PoolsData>> {
  return apiRequest<PoolsData>('/pools', { query: { modelType } });
}
export function getPlatforms(): Promise<ApiResponse<PlatformsData>> {
  return apiRequest<PlatformsData>('/platforms');
}
export function getModels(params?: { platformId?: string; enabled?: boolean }): Promise<ApiResponse<ModelsData>> {
  return apiRequest<ModelsData>('/models', {
    query: { platformId: params?.platformId, enabled: params?.enabled === undefined ? undefined : String(params.enabled) },
  });
}
export function getParameterCapabilitiesMeta(): Promise<ApiResponse<ParameterCapabilitiesMetaData>> {
  return apiRequest<ParameterCapabilitiesMetaData>('/parameter-capabilities/meta');
}
export function getExchanges(params?: { enabled?: boolean }): Promise<ApiResponse<ExchangesData>> {
  return apiRequest<ExchangesData>('/exchanges', {
    query: { enabled: params?.enabled === undefined ? undefined : String(params.enabled) },
  });
}
export function getKeyHealth(): Promise<ApiResponse<KeyHealthData>> {
  return apiRequest<KeyHealthData>('/key-health');
}
export function getConfigAuthorityReport(): Promise<ApiResponse<ConfigAuthorityReportData>> {
  return apiRequest<ConfigAuthorityReportData>('/config-authority/report');
}
export function getRuntimeGates(): Promise<ApiResponse<RuntimeGatesData>> {
  return apiRequest<RuntimeGatesData>('/runtime-gates');
}
export function bulkClaimConfigAuthority(req: BulkClaimConfigAuthorityRequest): Promise<ApiResponse<BulkClaimConfigAuthorityResult>> {
  return apiRequest<BulkClaimConfigAuthorityResult>('/config-authority/bulk-claim', { method: 'POST', body: req });
}
export function bindActiveAppCallerPools(): Promise<ApiResponse<BindActiveAppCallerPoolsResult>> {
  return apiRequest<BindActiveAppCallerPoolsResult>('/config-authority/bind-active-app-callers', { method: 'POST' });
}
export function getGatewayAppCallers(params?: {
  page?: number;
  pageSize?: number;
  status?: string;
  sourceSystem?: string;
  ingressProtocol?: string;
  requestType?: string;
  drift?: string;
  search?: string;
}): Promise<ApiResponse<GatewayAppCallersData>> {
  return apiRequest<GatewayAppCallersData>('/app-callers', {
    query: {
      page: params?.page,
      pageSize: params?.pageSize,
      status: params?.status,
      sourceSystem: params?.sourceSystem,
      ingressProtocol: params?.ingressProtocol,
      requestType: params?.requestType,
      drift: params?.drift,
      search: params?.search,
    },
  });
}
export function updateGatewayAppCaller(id: string, req: UpdateGatewayAppCallerRequest): Promise<ApiResponse<GatewayAppCaller>> {
  return apiRequest<GatewayAppCaller>(`/app-callers/${encodeURIComponent(id)}`, { method: 'PUT', body: req });
}
export function bulkUpdateGatewayAppCallers(req: BulkUpdateGatewayAppCallersRequest): Promise<ApiResponse<BulkUpdateGatewayAppCallersResult>> {
  return apiRequest<BulkUpdateGatewayAppCallersResult>('/app-callers/bulk-governance', { method: 'POST', body: req });
}
export function getServiceKeys(): Promise<ApiResponse<ServiceKeyItem[]>> {
  return apiRequest<ServiceKeyItem[]>('/service-keys');
}
export function createServiceKey(req: CreateServiceKeyRequest): Promise<ApiResponse<CreatedServiceKey>> {
  return apiRequest<CreatedServiceKey>('/service-keys', { method: 'POST', body: req });
}
export function revokeServiceKey(id: string): Promise<ApiResponse<{ id: string; revoked: boolean }>> {
  return apiRequest<{ id: string; revoked: boolean }>(`/service-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
export function getOrganization(): Promise<ApiResponse<OrganizationData>> {
  return apiRequest<OrganizationData>('/organization');
}
export function createTenant(req: { name: string; slug: string }): Promise<ApiResponse<CreatedTenant>> {
  return apiRequest<CreatedTenant>('/tenants', { method: 'POST', body: req });
}
export function createTeam(req: { name: string }): Promise<ApiResponse<CreatedTeam>> {
  return apiRequest<CreatedTeam>('/teams', { method: 'POST', body: req });
}
export function switchTenant(tenantId: string): Promise<ApiResponse<LoginResult>> {
  return apiRequest<LoginResult>('/auth/switch-tenant', { method: 'POST', body: { tenantId } });
}
export function getAvailableTenants(): Promise<ApiResponse<AvailableTenant[]>> {
  return apiRequest<AvailableTenant[]>('/auth/tenants');
}
export function getOperationAudits(params?: {
  page?: number;
  pageSize?: number;
  action?: string;
  targetType?: string;
  actor?: string;
  success?: boolean;
  search?: string;
  sinceHours?: number;
}): Promise<ApiResponse<OperationAuditsData>> {
  return apiRequest<OperationAuditsData>('/audits', {
    query: {
      page: params?.page,
      pageSize: params?.pageSize,
      action: params?.action,
      targetType: params?.targetType,
      actor: params?.actor,
      success: params?.success === undefined ? undefined : String(params.success),
      search: params?.search,
      sinceHours: params?.sinceHours,
    },
  });
}
export function getShadowComparisons(params?: { limit?: number; appCallerCode?: string; kind?: string; releaseCommit?: string; sinceHours?: number }): Promise<ApiResponse<ShadowData>> {
  return apiRequest<ShadowData>('/shadow-comparisons', { query: { limit: params?.limit, appCallerCode: params?.appCallerCode, kind: params?.kind, releaseCommit: params?.releaseCommit, sinceHours: params?.sinceHours } });
}

export function getPromptPolicy(appCallerId: string): Promise<ApiResponse<PromptPolicyData>> {
  return apiRequest<PromptPolicyData>(`/app-callers/${encodeURIComponent(appCallerId)}/prompt-policy`);
}
export function previewPromptPolicy(appCallerId: string, body: PromptPolicyDraft & { sampleSystemPrompt: string }): Promise<ApiResponse<PromptPolicyPreview>> {
  return apiRequest<PromptPolicyPreview>(`/app-callers/${encodeURIComponent(appCallerId)}/prompt-policy/preview`, { method: 'POST', body });
}
export function savePromptPolicy(appCallerId: string, body: PromptPolicyDraft): Promise<ApiResponse<PromptPolicyVersion>> {
  return apiRequest<PromptPolicyVersion>(`/app-callers/${encodeURIComponent(appCallerId)}/prompt-policy`, { method: 'PUT', body });
}
export function rollbackPromptPolicy(appCallerId: string, expectedVersion: number, targetVersion: number): Promise<ApiResponse<PromptPolicyVersion>> {
  return apiRequest<PromptPolicyVersion>(`/app-callers/${encodeURIComponent(appCallerId)}/prompt-policy/rollback`, { method: 'POST', body: { expectedVersion, targetVersion } });
}

// ── 配置面（可写）——布尔开关，写入共享 Mongo 后 MAP 立即生效 ──
export function setPlatformEnabled(id: string, enabled: boolean): Promise<ApiResponse<PlatformItem>> {
  return apiRequest<PlatformItem>(`/platforms/${encodeURIComponent(id)}/enabled`, { method: 'PUT', body: { enabled } });
}
export function claimPlatformToGateway(id: string): Promise<ApiResponse<PlatformItem>> {
  return apiRequest<PlatformItem>(`/platforms/${encodeURIComponent(id)}/claim`, { method: 'PUT' });
}
export function rotatePlatformApiKey(id: string, apiKey: string): Promise<ApiResponse<PlatformItem>> {
  return apiRequest<PlatformItem>(`/platforms/${encodeURIComponent(id)}/api-key`, { method: 'PUT', body: { apiKey } });
}
export function deletePlatformApiKey(id: string): Promise<ApiResponse<PlatformItem>> {
  return apiRequest<PlatformItem>(`/platforms/${encodeURIComponent(id)}/api-key`, { method: 'DELETE' });
}
export function setModelEnabled(id: string, enabled: boolean): Promise<ApiResponse<ModelItem>> {
  return apiRequest<ModelItem>(`/models/${encodeURIComponent(id)}/enabled`, { method: 'PUT', body: { enabled } });
}
export function claimModelToGateway(id: string): Promise<ApiResponse<ModelItem>> {
  return apiRequest<ModelItem>(`/models/${encodeURIComponent(id)}/claim`, { method: 'PUT' });
}
export function rotateModelApiKey(id: string, apiKey: string): Promise<ApiResponse<ModelItem>> {
  return apiRequest<ModelItem>(`/models/${encodeURIComponent(id)}/api-key`, { method: 'PUT', body: { apiKey } });
}
export function deleteModelApiKey(id: string): Promise<ApiResponse<ModelItem>> {
  return apiRequest<ModelItem>(`/models/${encodeURIComponent(id)}/api-key`, { method: 'DELETE' });
}
export function bulkUpdateModelCapabilities(req: BulkUpdateModelCapabilitiesRequest): Promise<ApiResponse<BulkUpdateModelCapabilitiesResult>> {
  return apiRequest<BulkUpdateModelCapabilitiesResult>('/models/capabilities/bulk-update', { method: 'POST', body: req });
}
export function claimExchangeToGateway(id: string): Promise<ApiResponse<ExchangeItem>> {
  return apiRequest<ExchangeItem>(`/exchanges/${encodeURIComponent(id)}/claim`, { method: 'PUT' });
}
export function rotateExchangeApiKey(id: string, apiKey: string): Promise<ApiResponse<ExchangeItem>> {
  return apiRequest<ExchangeItem>(`/exchanges/${encodeURIComponent(id)}/api-key`, { method: 'PUT', body: { apiKey } });
}
export function deleteExchangeApiKey(id: string): Promise<ApiResponse<ExchangeItem>> {
  return apiRequest<ExchangeItem>(`/exchanges/${encodeURIComponent(id)}/api-key`, { method: 'DELETE' });
}
export function bulkRotateApiKeys(req: BulkRotateApiKeysRequest): Promise<ApiResponse<BulkRotateApiKeysResult>> {
  return apiRequest<BulkRotateApiKeysResult>('/api-keys/bulk-rotate', { method: 'POST', body: req });
}
export function setPoolDefault(id: string, isDefault: boolean): Promise<ApiResponse<ModelPool>> {
  return apiRequest<ModelPool>(`/pools/${encodeURIComponent(id)}/default`, { method: 'PUT', body: { isDefault } });
}
export function claimPoolToGateway(id: string): Promise<ApiResponse<ModelPool>> {
  return apiRequest<ModelPool>(`/pools/${encodeURIComponent(id)}/claim`, { method: 'PUT' });
}
export function createPool(req: CreatePoolRequest): Promise<ApiResponse<ModelPool>> {
  return apiRequest<ModelPool>('/pools', { method: 'POST', body: req });
}
export function updatePool(id: string, req: UpdatePoolRequest): Promise<ApiResponse<ModelPool>> {
  return apiRequest<ModelPool>(`/pools/${encodeURIComponent(id)}`, { method: 'PUT', body: req });
}
export function bulkClaimPools(req: BulkClaimPoolsRequest): Promise<ApiResponse<BulkClaimPoolsResult>> {
  return apiRequest<BulkClaimPoolsResult>('/pools/bulk-claim', { method: 'POST', body: req });
}
export function bulkCalibratePoolPriceCurrency(req: BulkCalibratePoolPriceCurrencyRequest): Promise<ApiResponse<BulkCalibratePoolPriceCurrencyResult>> {
  return apiRequest<BulkCalibratePoolPriceCurrencyResult>('/pools/price-currency/bulk-calibrate', { method: 'POST', body: req });
}
export function bulkImportPoolModels(id: string, req: BulkImportPoolModelsRequest): Promise<ApiResponse<BulkImportPoolModelsResult>> {
  return apiRequest<BulkImportPoolModelsResult>(`/pools/${encodeURIComponent(id)}/models/bulk-import`, { method: 'POST', body: req });
}
export function upsertPoolModel(id: string, req: UpsertPoolModelRequest): Promise<ApiResponse<ModelPool>> {
  return apiRequest<ModelPool>(`/pools/${encodeURIComponent(id)}/models`, { method: 'PUT', body: req });
}
export function removePoolModel(id: string, modelId: string, platformId?: string): Promise<ApiResponse<ModelPool>> {
  return apiRequest<ModelPool>(`/pools/${encodeURIComponent(id)}/models`, {
    method: 'DELETE',
    query: { modelId, platformId },
  });
}
