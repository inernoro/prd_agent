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
// 列表数据形状与现有 /api/logs/llm 对齐，对接时只需把 BASE 指过去即可。

import type {
  ApiResponse,
  ChangePasswordRequest,
  ChangePasswordResult,
  LoginRequest,
  LoginResult,
  LogsListData,
  LogsListParams,
  LogsMeta,
  TimeseriesData,
  SessionsData,
  LlmLogDetail,
  PoolsData,
  PlatformsData,
  ModelsData,
  ShadowData,
  ModelPool,
  PlatformItem,
  ModelItem,
} from './types';

const TOKEN_KEY = 'llmgw.token';
const USER_KEY = 'llmgw.user';
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

export function setSession(result: LoginResult) {
  sessionStorage.setItem(TOKEN_KEY, result.token);
  sessionStorage.setItem(
    USER_KEY,
    JSON.stringify({ username: result.username ?? undefined, displayName: result.displayName ?? undefined }),
  );
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
  sessionStorage.removeItem(MCP_KEY);
}

export function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
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

export function getLogsMeta(): Promise<ApiResponse<LogsMeta>> {
  return apiRequest<LogsMeta>('/logs/meta');
}

export function getLogsTimeseries(params: {
  from: string;
  to: string;
  model?: string;
  status?: string;
}): Promise<ApiResponse<TimeseriesData>> {
  return apiRequest<TimeseriesData>('/logs/timeseries', { query: { ...params } });
}

export function getLogsSessions(params: {
  from: string;
  to: string;
  page?: number;
  pageSize?: number;
}): Promise<ApiResponse<SessionsData>> {
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
export function getShadowComparisons(params?: { limit?: number; appCallerCode?: string }): Promise<ApiResponse<ShadowData>> {
  return apiRequest<ShadowData>('/shadow-comparisons', { query: { limit: params?.limit, appCallerCode: params?.appCallerCode } });
}

// ── 配置面（可写）——布尔开关，写入共享 Mongo 后 MAP 立即生效 ──
export function setPlatformEnabled(id: string, enabled: boolean): Promise<ApiResponse<PlatformItem>> {
  return apiRequest<PlatformItem>(`/platforms/${encodeURIComponent(id)}/enabled`, { method: 'PUT', body: { enabled } });
}
export function setModelEnabled(id: string, enabled: boolean): Promise<ApiResponse<ModelItem>> {
  return apiRequest<ModelItem>(`/models/${encodeURIComponent(id)}/enabled`, { method: 'PUT', body: { enabled } });
}
export function setPoolDefault(id: string, isDefault: boolean): Promise<ApiResponse<ModelPool>> {
  return apiRequest<ModelPool>(`/pools/${encodeURIComponent(id)}/default`, { method: 'PUT', body: { isDefault } });
}
