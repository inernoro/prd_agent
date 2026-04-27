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
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiRequest<T = unknown>(
  path: string,
  options: ApiOptions = {}
): Promise<T> {
  const { method = 'GET', body, signal } = options;
  const url = path.startsWith('/') ? path : `/${path}`;

  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: { Accept: 'application/json' },
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
    const message =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `${method} ${url} → ${res.status}`;
    throw new ApiError(res.status, parsed, message);
  }
  return parsed as T;
}
