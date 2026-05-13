/*
 * Thin fetch wrapper for the CDS REST API.
 *
 * - Always uses relative `/api/...` URLs so dev (vite proxy) and prod
 *   (Express on same origin) both work.
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

export async function apiRequest<T = unknown>(
  path: string,
  options: ApiOptions = {}
): Promise<T> {
  const { method = 'GET', body, signal, headers } = options;
  const url = path.startsWith('/') ? path : `/${path}`;

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

  if (!res.ok) {
    const requestId = res.headers.get('x-cds-request-id') || undefined;
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
  return parsed as T;
}
