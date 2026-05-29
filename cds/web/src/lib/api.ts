/*
 * Thin fetch wrapper for the CDS REST API.
 *
 * - In production, prefer `/_cds/api/...` so dashboard/control-plane calls
 *   bypass preview branch routing and always reach the CDS master.
 * - In local dev, keep `/api/...` so the Vite proxy continues to work.
 * - Throws ApiError with status + body on non-2xx responses, so callers can
 *   distinguish 401 (login required) from 500 (server bug).
 * - JSON only. Multipart uploads should fetch directly.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
    public requestId?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export function apiUrl(path: string, hostname = currentHostname()): string {
  const url = path.startsWith('/') ? path : `/${path}`;
  if (url.startsWith('/_cds/') || !url.startsWith('/api/')) return url;
  return shouldPreferCdsPassthrough(hostname) ? `/_cds${url}` : url;
}

export function shouldPreferCdsPassthrough(hostname = currentHostname()): boolean {
  if (!hostname) return false;
  const normalized = hostname.toLowerCase();
  return !['localhost', '127.0.0.1', '::1'].includes(normalized);
}

export async function apiRequest<T = unknown>(
  path: string,
  options: ApiOptions = {}
): Promise<T> {
  const { method = 'GET', body, signal, headers } = options;
  const rawUrl = path.startsWith('/') ? path : `/${path}`;
  const url = apiUrl(rawUrl);
  const init: RequestInit = buildRequestInit(method, body, signal, headers);

  const first = await fetchAndParse(url, init);
  if (first.res.ok) return first.parsed as T;

  const retryUrl = alternateApiUrl(rawUrl, url);
  const shouldRetryAlternate =
    method === 'GET' &&
    Boolean(retryUrl) &&
    !first.requestId &&
    hasNoReadableError(first.parsed);

  if (shouldRetryAlternate && retryUrl) {
    const retry = await fetchAndParse(retryUrl, init);
    if (retry.res.ok) return retry.parsed as T;
    throwApiError(method, retryUrl, retry.res, retry.parsed, retry.requestId);
  }

  throwApiError(method, url, first.res, first.parsed, first.requestId);
}

function alternateApiUrl(rawUrl: string, primaryUrl: string): string | null {
  if (!rawUrl.startsWith('/api/')) return null;
  if (shouldPreferCdsPassthrough() && primaryUrl.startsWith('/_cds/api/')) return null;
  if (primaryUrl.startsWith('/_cds/api/')) return rawUrl;
  if (primaryUrl.startsWith('/api/')) return `/_cds${primaryUrl}`;
  return null;
}

function currentHostname(): string {
  if (typeof window === 'undefined') return '';
  return window.location.hostname;
}

function buildRequestInit(
  method: NonNullable<ApiOptions['method']>,
  body: unknown,
  signal: AbortSignal | undefined,
  headers: Record<string, string> | undefined
): RequestInit {
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: { Accept: 'application/json', ...(headers || {}) },
    signal,
  };

  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return init;
}

async function fetchAndParse(
  url: string,
  init: RequestInit
): Promise<{ res: Response; parsed: unknown; requestId?: string }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
  }
  const requestId = res.headers.get('x-cds-request-id') || undefined;
  return { res, parsed, requestId };
}

function hasNoReadableError(parsed: unknown): boolean {
  if (typeof parsed === 'string') return parsed.trim().length === 0;
  if (!parsed || typeof parsed !== 'object') return true;
  const body = parsed as Record<string, unknown>;
  return !['message', 'detail', 'hint', 'error'].some((key) => {
    const value = body[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function throwApiError(
  method: string,
  url: string,
  res: Response,
  parsed: unknown,
  requestId: string | undefined
): never {
  const details: string[] = [];
  if (typeof parsed === 'object' && parsed !== null) {
    const body = parsed as Record<string, unknown>;
    for (const key of ['message', 'detail', 'hint', 'error']) {
      const value = body[key];
      if (typeof value === 'string' && value.trim() && !details.includes(value.trim())) {
        details.push(value.trim());
      }
    }
  } else if (typeof parsed === 'string' && parsed.trim()) {
    details.push(parsed.trim().slice(0, 240));
  }
  const reason = details.length
    ? details.join(' · ')
    : '服务拒绝了请求，但没有返回可读错误原因；请在 HTTP 活动详情里用 requestId 追踪。';
  const requestSuffix = requestId ? ` · requestId=${requestId}` : '';
  const message = `${method} ${url} 失败：${reason} (HTTP ${res.status})${requestSuffix}`;
  throw new ApiError(res.status, parsed, message, requestId);
}
