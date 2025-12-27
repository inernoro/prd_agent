import { useAuthStore } from '@/stores/authStore';
import { fail, ok, type ApiResponse } from '@/types/api';

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

function getApiBaseUrl() {
  // 默认使用相对路径（同源 /api），配合 Vite dev server proxy 与生产环境 Nginx /api 反代
  // 如需直连后端（跨域），可通过 VITE_API_BASE_URL 显式配置完整地址
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  return raw.trim().replace(/\/+$/, '');
}

async function tryParseJson(text: string): Promise<unknown> {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isApiResponseLike(x: unknown): x is { success: boolean; data: unknown; error: unknown } {
  if (!x || typeof x !== 'object') return false;
  const obj = x as Record<string, unknown>;
  return typeof obj.success === 'boolean' && 'data' in obj && 'error' in obj;
}

type RefreshOkData = { accessToken: string; refreshToken: string; sessionKey: string };

function isRefreshOkData(x: unknown): x is RefreshOkData {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.accessToken === 'string' && typeof o.refreshToken === 'string' && typeof o.sessionKey === 'string';
}

type ApiErrorLike = { code?: unknown; message?: unknown };

function getApiErrorLike(x: unknown): { code?: string; message?: string } | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as ApiErrorLike;
  const code = typeof o.code === 'string' ? o.code : undefined;
  const message = typeof o.message === 'string' ? o.message : undefined;
  return code || message ? { code, message } : null;
}

async function tryRefreshAdminToken(): Promise<boolean> {
  const authStore = useAuthStore.getState();
  const token = authStore.token;
  const refreshToken = authStore.refreshToken;
  const sessionKey = authStore.sessionKey;
  const userId = authStore.user?.userId;

  if (!authStore.isAuthenticated || !token || !refreshToken || !sessionKey || !userId) return false;

  const url = joinUrl(getApiBaseUrl(), '/api/v1/auth/refresh');
  const body = JSON.stringify({
    refreshToken,
    userId,
    clientType: 'admin',
    sessionKey,
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body,
    });
    const text = await res.text();
    const json = await tryParseJson(text);
    if (!res.ok || !isApiResponseLike(json) || json.success !== true) return false;
    const data = (json as { data: unknown }).data;
    if (!isRefreshOkData(data)) return false;

    authStore.setTokens(data.accessToken, data.refreshToken, data.sessionKey);
    return true;
  } catch {
    return false;
  }
}

export async function apiRequest<T>(
  path: string,
  options?: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    auth?: boolean;
    emptyResponseData?: T;
    headers?: Record<string, string>;
  }
): Promise<ApiResponse<T>> {
  return await apiRequestInner<T>(path, options, false);
}

async function apiRequestInner<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    auth?: boolean;
    emptyResponseData?: T;
    headers?: Record<string, string>;
  } | undefined,
  didRefresh: boolean
): Promise<ApiResponse<T>> {
  const method = options?.method ?? 'GET';
  const url = joinUrl(getApiBaseUrl(), path);

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options?.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }
  }

  const auth = options?.auth ?? true;
  if (auth) {
    const token = useAuthStore.getState().token;
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let body: string | undefined;
  if (options && 'body' in options) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body ?? {});
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (e) {
    return fail('NETWORK_ERROR', e instanceof Error ? e.message : '网络错误') as unknown as ApiResponse<T>;
  }

  if (res.status === 204) {
    const data = (options?.emptyResponseData ?? (true as unknown)) as T;
    return ok(data);
  }

  const text = await res.text();
  const json = await tryParseJson(text);

  // 处理 401 未授权：清除认证状态并跳转登录页
  if (res.status === 401) {
    // 先尝试 refresh 一次（仅 admin 端），成功则重试本次请求
    if (!didRefresh && (options?.auth ?? true)) {
      const okRefresh = await tryRefreshAdminToken();
      if (okRefresh) {
        return await apiRequestInner<T>(path, options, true);
      }
    }

    const authStore = useAuthStore.getState();
    if (authStore.isAuthenticated) {
      authStore.logout();
      window.location.href = '/login';
    }
  }

  if (isApiResponseLike(json)) {
    // 处理业务层面的 UNAUTHORIZED 错误（如 token 过期）
    const err = getApiErrorLike((json as { error: unknown }).error);
    if (!json.success && err?.code === 'UNAUTHORIZED') {
      if (!didRefresh && (options?.auth ?? true)) {
        const okRefresh = await tryRefreshAdminToken();
        if (okRefresh) {
          return await apiRequestInner<T>(path, options, true);
        }
      }

      const authStore = useAuthStore.getState();
      if (authStore.isAuthenticated) {
        authStore.logout();
        window.location.href = '/login';
      }
    }
    return json as ApiResponse<T>;
  }

  if (!res.ok) {
    const jsonObj = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
    const err = getApiErrorLike(jsonObj?.error);
    const message =
      err?.message ||
      (typeof jsonObj?.message === 'string' ? jsonObj.message : null) ||
      text ||
      `HTTP ${res.status} ${res.statusText}`;
    const code = err?.code || (res.status === 401 ? 'UNAUTHORIZED' : 'UNKNOWN');
    return fail(code, message) as unknown as ApiResponse<T>;
  }

  // 兼容非 ApiResponse 结构（如直接返回 data）
  return ok(json as T);
}


