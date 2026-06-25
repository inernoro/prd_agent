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
  /**
   * 2026-05-28 增:transient 标志。
   *
   * 当后端 / CDN 临时返非 2xx 但响应**没有可读错误体**(典型 Cloudflare 边缘
   * 偶发 400/502/503,无 `error/message` 字段、无 x-cds-request-id)时打 true。
   * 调用方可以据此选择"静默吞掉 + 保留 lastKnownGood"而非弹错。
   *
   * 注意:有 body 或有 request-id 的失败不算 transient(那是真实的业务/服务端错)。
   */
  transient: boolean;

  constructor(
    public status: number,
    public body: unknown,
    message: string,
    public requestId?: string,
    transient = false,
  ) {
    super(message);
    this.name = 'ApiError';
    this.transient = transient;
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

/**
 * 2026-05-28: 静默 transient retry — Cloudflare 边缘 400/5xx 抖动专治。
 *
 * 如果第一次 fetch 收到的是 transient 形态(4xx/5xx + 空 body + 无 requestId),
 * 等 500ms 自动重试一次。99%+ 边缘抖动是单点的,第二次就成功了,调用方完全
 * 无感。两次都失败再抛 ApiError(此时 transient=true,调用方可选择静默)。
 *
 * GET 是天然幂等;POST/PUT 默认**不**自动重试(可能产生重复副作用),
 * 调用方需要时通过 `options.retryTransient: true` 显式开启。
 */
const TRANSIENT_STATUS = new Set([400, 502, 503, 504]);

function looksTransient(res: Response, parsed: unknown, requestId?: string): boolean {
  if (!TRANSIENT_STATUS.has(res.status)) return false;
  if (requestId) return false; // 真后端返的 4xx/5xx,不抖动
  return hasNoReadableError(parsed);
}

export async function apiRequest<T = unknown>(
  path: string,
  options: ApiOptions = {}
): Promise<T> {
  const { method = 'GET', body, signal, headers } = options;
  const rawUrl = path.startsWith('/') ? path : `/${path}`;
  const url = apiUrl(rawUrl);
  const init: RequestInit = buildRequestInit(method, body, signal, headers);
  const allowRetry = method === 'GET' || (options as ApiOptions & { retryTransient?: boolean }).retryTransient === true;

  const first = await fetchAndParse(url, init);
  if (first.res.ok) return first.parsed as T;

  // ── transient 自动静默重试 ──
  if (allowRetry && looksTransient(first.res, first.parsed, first.requestId)) {
    // eslint-disable-next-line no-console
    console.warn('[apiRequest transient retry]', method, url, `HTTP ${first.res.status}`);
    await new Promise((r) => setTimeout(r, 500));
    const retried = await fetchAndParse(url, init);
    if (retried.res.ok) return retried.parsed as T;
    // 两次都炸 → 真错(或者持续 transient)。继续走 alternate 路径,最终若仍 transient
    // 抛出会标 transient=true,UI 端可选择静默。
  }

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

// ── Acceptance reports (CDS self-hosted, 2026-06-20) ──

export type ReportFormat = 'html' | 'md';

export type ReportVerdict = 'pass' | 'conditional' | 'fail';

export interface AcceptanceReport {
  id: string;
  title: string;
  format: ReportFormat;
  projectId?: string | null;
  /** 列表接口附带：项目 slug，便于跨系统按项目归类展示。 */
  projectSlug?: string | null;
  branchId?: string | null;
  folderId?: string | null;
  sizeBytes: number;
  /** 验收结论（看板分组）。 */
  verdict?: ReportVerdict | null;
  /** 验收档位（自由文本）。 */
  tier?: string | null;
  /** 缺陷计数（按严重度）。 */
  defectCounts?: Record<string, number> | null;
  /** E1 部署上下文：commit SHA。 */
  commitSha?: string | null;
  /** E1 部署上下文：分支名。 */
  branch?: string | null;
  /** E1 部署上下文：PR 编号。 */
  prNumber?: number | null;
  /** E1 部署上下文：部署模式。 */
  deployMode?: string | null;
  /** E6 匿名分享 token（/r/<token> 只读公开链接）；null=未分享。 */
  shareToken?: string | null;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReportFolder {
  id: string;
  name: string;
  projectId?: string | null;
  sortOrder: number;
  createdAt: string;
}

/**
 * List report metadata, newest first. `projectId` filters by project;
 * `folderId` filters by folder ('none' = 仅未归类的报告).
 */
export async function listReports(projectId?: string, folderId?: string): Promise<AcceptanceReport[]> {
  const params = new URLSearchParams();
  if (projectId) params.set('projectId', projectId);
  if (folderId) params.set('folderId', folderId);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await apiRequest<{ reports: AcceptanceReport[] }>(`/api/reports${qs}`);
  return res.reports;
}

/** List report folders for a project scope (omit projectId for global/CDS-self). */
export async function listReportFolders(projectId?: string): Promise<ReportFolder[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const res = await apiRequest<{ folders: ReportFolder[] }>(`/api/report-folders${qs}`);
  return res.folders;
}

export async function createReportFolder(name: string, projectId?: string | null): Promise<ReportFolder> {
  const res = await apiRequest<{ folder: ReportFolder }>('/api/report-folders', {
    method: 'POST',
    body: { name, projectId: projectId ?? null },
  });
  return res.folder;
}

export async function renameReportFolder(id: string, name: string): Promise<ReportFolder> {
  const res = await apiRequest<{ folder: ReportFolder }>(`/api/report-folders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { name },
  });
  return res.folder;
}

export async function deleteReportFolder(id: string): Promise<void> {
  await apiRequest(`/api/report-folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Move a report into a folder (folderId=null detaches it). */
export async function moveReportToFolder(id: string, folderId: string | null): Promise<AcceptanceReport> {
  const res = await apiRequest<{ report: AcceptanceReport }>(`/api/reports/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { folderId },
  });
  return res.report;
}

export async function getReport(id: string): Promise<AcceptanceReport> {
  const res = await apiRequest<{ report: AcceptanceReport }>(`/api/reports/${encodeURIComponent(id)}`);
  return res.report;
}

/** E6: 生成（幂等返回已有）报告匿名只读分享链接 /r/<token>。 */
export async function enableReportShare(id: string): Promise<{ report: AcceptanceReport; shareUrl: string }> {
  return apiRequest<{ report: AcceptanceReport; shareUrl: string }>(`/api/reports/${encodeURIComponent(id)}/share`, {
    method: 'POST',
  });
}

/** E6: 撤销报告分享链接（立即失效）。 */
export async function disableReportShare(id: string): Promise<AcceptanceReport> {
  const res = await apiRequest<{ report: AcceptanceReport }>(`/api/reports/${encodeURIComponent(id)}/share`, {
    method: 'DELETE',
  });
  return res.report;
}

export interface PushToPrResult {
  ok: boolean;
  prNumber: number;
  repo: string;
  commentUrl?: string;
  checkRun?: { id: number; htmlUrl: string };
  warnings: string[];
}

/** E4: 把验收结论作为 PR 评论 + check-run 回写到关联 PR。 */
export async function pushReportToPr(id: string): Promise<PushToPrResult> {
  return apiRequest<PushToPrResult>(`/api/reports/${encodeURIComponent(id)}/push-to-pr`, { method: 'POST' });
}

/** Create a report via the JSON paste path. */
export async function createReportFromText(input: {
  title: string;
  format: ReportFormat;
  content: string;
  projectId?: string | null;
  branchId?: string | null;
  folderId?: string | null;
}): Promise<AcceptanceReport> {
  const res = await apiRequest<{ report: AcceptanceReport }>('/api/reports', {
    method: 'POST',
    body: input,
  });
  return res.report;
}

/**
 * Create a report via the multipart file-upload path. Multipart must fetch
 * directly (the apiRequest wrapper is JSON-only). Mirrors apiUrl()'s
 * passthrough handling so dashboard calls reach the CDS master.
 */
export async function createReportFromFile(input: {
  title: string;
  format?: ReportFormat;
  file: File;
  projectId?: string | null;
  branchId?: string | null;
  folderId?: string | null;
}): Promise<AcceptanceReport> {
  const form = new FormData();
  form.append('title', input.title);
  if (input.format) form.append('format', input.format);
  if (input.projectId) form.append('projectId', input.projectId);
  if (input.branchId) form.append('branchId', input.branchId);
  if (input.folderId) form.append('folderId', input.folderId);
  form.append('file', input.file, input.file.name);

  const url = apiUrl('/api/reports');
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    body: form,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { /* keep text */ }
  if (!res.ok) {
    throwApiError('POST', url, res, parsed, res.headers.get('x-cds-request-id') || undefined);
  }
  return (parsed as { report: AcceptanceReport }).report;
}

export async function deleteReport(id: string): Promise<void> {
  await apiRequest(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Fetch raw report content as text (for Markdown conversion or inspection). */
export async function fetchReportRaw(id: string): Promise<string> {
  const url = apiUrl(`/api/reports/${encodeURIComponent(id)}/raw`);
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    throwApiError('GET', url, res, undefined, res.headers.get('x-cds-request-id') || undefined);
  }
  return res.text();
}

/** Absolute URL for the raw report endpoint (used as iframe src for HTML). */
export function reportRawUrl(id: string): string {
  return apiUrl(`/api/reports/${encodeURIComponent(id)}/raw`);
}

// ── Local users + activity (auth-local, 2026-06-20) ──

export type CdsAuthProvider = 'github' | 'local';

export interface CdsPublicUser {
  id: string;
  username: string | null;
  githubLogin: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  authProvider: CdsAuthProvider;
  isSystemOwner: boolean;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
}

export interface CdsUserActivity {
  id: string;
  userId: string;
  userLogin: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  summary: string;
  ip?: string | null;
  at: string;
}

/** Whether the system needs first-run bootstrap (zero users). Public. */
export async function fetchBootstrapStatus(): Promise<{ needsBootstrap: boolean }> {
  return apiRequest<{ needsBootstrap: boolean }>('/api/auth/bootstrap-status');
}

/**
 * Probe whether the current same-origin session cookie is still valid.
 *
 * `GET /api/me` 是唯一能判断「当前 HttpOnly 会话 cookie 是否还有效」的途径
 * （cookie 设了 HttpOnly,前端 JS 读不到）。200 = 已登录;401 = 未登录。
 * 网络/瞬时错误一律按「未登录」处理,宁可多弹一次登录框也不要把匿名用户
 * 误判成已登录后丢进控制台再吃 401。
 */
export async function fetchSessionAuthed(): Promise<boolean> {
  try {
    await apiRequest('/api/me');
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return false;
    return false;
  }
}

/** Create the first local system-owner account (only valid when zero users). */
export async function bootstrapFirstUser(input: {
  username: string;
  password: string;
  name?: string;
}): Promise<{ user: CdsPublicUser }> {
  return apiRequest('/api/auth/bootstrap', { method: 'POST', body: input });
}

/** Local username + password login. Sets the shared session cookie on success. */
export async function localLogin(input: {
  username: string;
  password: string;
}): Promise<{ user: CdsPublicUser }> {
  return apiRequest('/api/auth/login', { method: 'POST', body: input });
}

/** Change the current user's own password. */
export async function changeMyPassword(input: {
  oldPassword: string;
  newPassword: string;
}): Promise<void> {
  await apiRequest('/api/auth/change-password', { method: 'POST', body: input });
}

/** List all users (system-owner only). */
export async function listUsers(): Promise<CdsPublicUser[]> {
  const res = await apiRequest<{ users: CdsPublicUser[] }>('/api/auth/users');
  return res.users;
}

/** Create a local user (system-owner only). */
export async function createLocalUser(input: {
  username: string;
  password: string;
  name?: string;
}): Promise<CdsPublicUser> {
  const res = await apiRequest<{ user: CdsPublicUser }>('/api/auth/users', { method: 'POST', body: input });
  return res.user;
}

/** Enable/disable or admin-reset a user (system-owner only). */
export async function updateUser(
  id: string,
  input: { status?: 'active' | 'disabled'; newPassword?: string },
): Promise<CdsPublicUser | null> {
  const res = await apiRequest<{ user: CdsPublicUser | null }>(
    `/api/auth/users/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: input },
  );
  return res.user;
}

/** Query user activity, newest-first. Owner may pass userId; others see only their own. */
export async function listUserActivity(opts: { userId?: string; limit?: number } = {}): Promise<CdsUserActivity[]> {
  const qs = new URLSearchParams();
  if (opts.userId) qs.set('userId', opts.userId);
  if (opts.limit) qs.set('limit', String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await apiRequest<{ activity: CdsUserActivity[] }>(`/api/auth/activity${suffix}`);
  return res.activity;
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

  // 2026-05-28 用户反馈"GET /_cds/api/branches?...失败 (HTTP 400)"太吓人:
  // 当后端 / CDN 临时拒绝且**没给可读错误体也没 requestId**,几乎肯定是
  // Cloudflare 边缘抖动 / 临时连接重置。这种情况标 transient,UI 端用一句
  // 友好文案("网络抖动,已保留缓存"),完整诊断只去 console。
  const isTransient = !details.length && !requestId && (
    res.status === 400 || res.status === 502 || res.status === 503 || res.status === 504
  );

  let message: string;
  if (isTransient) {
    // 用户可见文案:短 + 友好,不带 URL / status / requestId
    message = '网络抖动,稍后会自动恢复';
    // 完整诊断到 console,方便 F12 复盘
    // eslint-disable-next-line no-console
    console.warn('[cds-api transient]', method, url, `HTTP ${res.status}`, parsed);
  } else {
    const reason = details.length
      ? details.join(' · ')
      : '服务拒绝了请求，但没有返回可读错误原因';
    const requestSuffix = requestId ? ` · requestId=${requestId}` : '';
    message = `${method} ${url} 失败：${reason} (HTTP ${res.status})${requestSuffix}`;
  }
  throw new ApiError(res.status, parsed, message, requestId, isTransient);
}
