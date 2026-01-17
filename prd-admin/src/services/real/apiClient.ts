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

function resolveAdminAppName(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.location.hash ? window.location.hash.replace(/^#/, '') : window.location.pathname;
  const path = (raw || '').split('?')[0] || '';
  if (path.startsWith('/ai-chat')) return 'prd-agent-desktop';
  if (path.startsWith('/visual-agent-fullscreen') || path.startsWith('/visual-agent')) return 'visual-agent';
  if (path.startsWith('/literary-agent')) return 'literary-agent';
  if (path.startsWith('/open-platform')) return 'open-platform-agent';
  if (path.startsWith('/laboratory') || path.startsWith('/lab')) return 'lab-agent';
  if (path.startsWith('/system-logs')) return 'prd-agent-web';
  return 'prd-agent-web';
}

async function tryParseJson(text: string): Promise<unknown> {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isDisconnectedError(e: unknown): boolean {
  const msg =
    (e instanceof Error ? (e.message || e.stack || '') : String(e || ''))
      .toLowerCase()
      .trim();
  if (!msg) return false;
  const needles = [
    'failed to fetch',
    'networkerror',
    'network error',
    'load failed',
    'timeout',
    'timed out',
    'econnrefused',
    'connection refused',
    'connection reset',
    'dns',
    'enotfound',
  ];
  return needles.some((x) => msg.includes(x));
}

function classifyNonContractHttpError(args: {
  status: number;
  statusText: string;
  path: string;
  maybeHtml: boolean;
  contentType: string;
}): { code: string; message: string } {
  const status = args.status;
  const st = (args.statusText || '').trim();
  const path = args.path;
  const isHtml = args.maybeHtml || args.contentType.includes('text/html');

  // 仅当后端按契约返回 PERMISSION_DENIED 时才算“权限不足”
  // 非契约响应（尤其 HTML）上的 403 很可能是网关/反代/静态服务器拦截，属于“服务不可用/地址错误”
  if (status === 401) {
    return { code: 'UNAUTHORIZED', message: '未登录或登录已过期（HTTP 401）' };
  }

  // 经验：在“后端挂了/端口停了/反代未就绪”时，一些网关仍可能返回 403（甚至非 HTML）
  // 为避免把断线误导成“请求被拒绝”，非契约的 403 一律归类为 SERVER_UNAVAILABLE。
  if (status === 403) {
    const suffix = isHtml ? '或被网关拦截' : '或服务不可达';
    return { code: 'SERVER_UNAVAILABLE', message: `服务器不可用${suffix}（HTTP 403）（${path}）` };
  }

  if ((status === 502 || status === 503 || status === 504) && isHtml) {
    return { code: 'SERVER_UNAVAILABLE', message: `服务器暂不可用（HTTP ${status}）（${path}）` };
  }

  if (status >= 500) {
    return { code: 'SERVER_ERROR', message: `服务器错误（HTTP ${status}${st ? ` ${st}` : ''}）（${path}）` };
  }

  // 其它 4xx：默认按“请求被拒绝/不被接受”，但不冒充权限不足
  return { code: 'REQUEST_REJECTED', message: `请求被拒绝（HTTP ${status}${st ? ` ${st}` : ''}）（${path}）` };
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
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
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
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
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
    'X-Client': 'admin',
  };
  const appName = resolveAdminAppName();
  if (appName) headers['X-App-Name'] = appName;
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
    if (isDisconnectedError(e)) {
      return fail('DISCONNECTED', '已断开连接或服务器不可达') as unknown as ApiResponse<T>;
    }
    return fail('NETWORK_ERROR', e instanceof Error ? e.message : '网络错误') as unknown as ApiResponse<T>;
  }

  if (res.status === 204) {
    const data = (options?.emptyResponseData ?? (true as unknown)) as T;
    return ok(data);
  }

  const text = await res.text();
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  const maybeHtml = contentType.includes('text/html') || /^\s*</.test(text) || /<html/i.test(text);
  const json = await tryParseJson(text);

  // Nginx/代理层 413：避免把整段 HTML 错误页塞进 UI（会卡顿/难读）
  if (res.status === 413) {
    return fail('DOCUMENT_TOO_LARGE', '请求体过大（HTTP 413）。请减小图片/内容大小，或调整 Nginx 的 client_max_body_size。') as unknown as ApiResponse<T>;
  }

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
    // 有明确业务错误码：尊重后端契约（权限拒绝/限流/会话过期等）
    if (err?.code) {
      let message =
        err?.message ||
        (typeof jsonObj?.message === 'string' ? jsonObj.message : null) ||
        text ||
        `HTTP ${res.status} ${res.statusText}`;
      if (maybeHtml) {
        message = `HTTP ${res.status} ${res.statusText || 'Request Failed'} (${path})`;
      } else if (typeof message === 'string' && message.length > 1600) {
        message = `${message.slice(0, 1600)}…`;
      }
      return fail(err.code, String(message || '请求失败')) as unknown as ApiResponse<T>;
    }

    // 非契约错误：按“断连/服务不可用/服务器错误/请求被拒绝”分类
    const classified = classifyNonContractHttpError({
      status: res.status,
      statusText: res.statusText,
      path,
      maybeHtml,
      contentType,
    });
    return fail(classified.code, classified.message) as unknown as ApiResponse<T>;
  }

  // 兼容非 ApiResponse 结构（如直接返回 data）
  return ok(json as T);
}
