import { useAuthStore } from '@/stores/authStore';
import { fail, ok, type ApiResponse } from '@/types/api';

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

function getApiBaseUrl() {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:5000';
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
  const obj = x as any;
  return typeof obj.success === 'boolean' && 'data' in obj && 'error' in obj;
}

export async function apiRequest<T>(
  path: string,
  options?: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    auth?: boolean;
    emptyResponseData?: T;
  }
): Promise<ApiResponse<T>> {
  const method = options?.method ?? 'GET';
  const url = joinUrl(getApiBaseUrl(), path);

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

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
    return ok((options?.emptyResponseData ?? (true as any)) as T);
  }

  const text = await res.text();
  const json = await tryParseJson(text);

  if (isApiResponseLike(json)) {
    return json as ApiResponse<T>;
  }

  if (!res.ok) {
    const message =
      (json as any)?.error?.message ||
      (json as any)?.message ||
      text ||
      `HTTP ${res.status} ${res.statusText}`;
    const code = (json as any)?.error?.code || (res.status === 401 ? 'UNAUTHORIZED' : 'UNKNOWN');
    return fail(code, message) as unknown as ApiResponse<T>;
  }

  // 兼容非 ApiResponse 结构（如直接返回 data）
  return ok(json as T);
}


