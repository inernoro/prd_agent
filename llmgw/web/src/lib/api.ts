// 独立 API 客户端：JWT 存 localStorage（超长登录期诉求：关浏览器再打开仍保持登录；
// 撤销由服务端每请求校验 SecurityVersion / 成员版本兜底，详见 sessionStore 注释）。
// 服务端滑动续期会通过 X-Gw-Token 响应头换发新 token，本文件在每次响应里自动接住。
// base 优先走 import.meta.env.VITE_LLMGW_API_BASE；未配置时按运行路径选择 /gw 或 /llmgw/gw。
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
  MapSsoRequest,
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
  PoolTypesData,
  EnsurePoolTypesResult,
  PlatformsData,
  ModelsData,
  LogicalModelsData,
  LogicalModelItem,
  ModelOfferingItem,
  CreateLogicalModelRequest,
  UpdateLogicalModelRequest,
  CreateModelOfferingRequest,
  UpdateModelOfferingRequest,
  GatewayAppCallersData,
  GatewayAppCaller,
  CreateGatewayAppCallerRequest,
  UpdateGatewayAppCallerRequest,
  BulkUpdateGatewayAppCallersRequest,
  BulkUpdateGatewayAppCallersResult,
  OperationAuditsData,
  ShadowData,
  ModelPool,
  PlatformItem,
  ModelItem,
  CreatePlatformRequest,
  CreateModelRequest,
  CreateModelResult,
  ParameterCapabilitiesMetaData,
  ExchangesData,
  ExchangeItem,
  ExchangeMetaData,
  CreateExchangeRequest,
  UpdateExchangeRequest,
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
  CostReconciliationSummary,
  CostReconciliationImportRequest,
  CostReconciliationItem,
  TenantGovernanceData,
  UpdateTenantGovernanceRequest,
  LegacyKeyCutoverData,
  OrganizationData,
  CreatedTenant,
  CreatedTeam,
  CreateMemberRequest,
  CreatedMember,
  UpdateMemberRequest,
  PromptPolicyData,
  PromptPolicyDraft,
  PromptPolicyPreview,
  PromptPolicyVersion,
  AvailableTenant,
} from './types';
import { getDefaultApiBase } from './runtimeBase';
import { setPlatformMapHome } from './mapNavigation';

const TOKEN_KEY = 'llmgw.token';
const USER_KEY = 'llmgw.user';
const TENANT_KEY = 'llmgw.tenant';
// 首登强制改密标记。
const MCP_KEY = 'llmgw.mustChangePwd';
// 会话到期时间（后端签发的 expiresAt），用于主动过期而不是干等下一次 401。
const EXPIRES_KEY = 'llmgw.expiresAt';
const SESSION_KEYS = [TOKEN_KEY, USER_KEY, TENANT_KEY, MCP_KEY, EXPIRES_KEY];
// 滑动续期：服务端在会话被自动延长时用这两个响应头下发新 token 与新的到期时间
// （见 GwSessionHeaders）。到期时间必须跟着换，否则主动过期定时器会按旧时间把人踢下线。
const RENEWED_TOKEN_HEADER = 'X-Gw-Token';
const RENEWED_EXPIRES_HEADER = 'X-Gw-Token-Expires-At';
const mapSsoExchanges = new Map<string, Promise<ApiResponse<LoginResult>>>();

// 匿名端点：这些接口本来就允许未登录调用，它们返回 401 表示「这次凭据不对」，
// 不代表「当前会话过期」，不得据此清会话或把用户踢去登录页。
const ANONYMOUS_PATHS = ['/auth/login', '/auth/map-sso', '/healthz'];

export const SESSION_EXPIRED_MESSAGE = '登录已失效，请重新登录';

/**
 * 会话失效原因：
 *  - expired：token 过期或被服务端拒绝；
 *  - revoked：服务端返回 TENANT_SESSION_INVALID，即成员关系/角色被改动或管理员强制重新登录。
 */
export type SessionExpiredReason = 'expired' | 'revoked';

/** 服务端「会话被作废」的错误码（console-api 租户门返回，见 Program.cs 的 TenantAccess 中间件）。 */
const REVOKED_ERROR_CODES = new Set(['TENANT_SESSION_INVALID', 'TENANT_ACCESS_DENIED']);

/** 失效事件带上「失效的是哪个 token」，跨标签页广播时用来区分自己是不是同一个会话。 */
export type SessionExpiredEvent = { reason: SessionExpiredReason; token: string | null };

type SessionExpiredListener = (event: SessionExpiredEvent) => void;

type SessionRenewedListener = () => void;

const sessionRenewedListeners = new Set<SessionRenewedListener>();

/**
 * 订阅「会话被服务端滑动续期」事件。AuthProvider 借此按新的到期时间重排主动过期定时器，
 * 否则定时器还按签发时的旧时间点排着，续期等于白续。
 */
export function onSessionRenewed(listener: SessionRenewedListener): () => void {
  sessionRenewedListeners.add(listener);
  return () => {
    sessionRenewedListeners.delete(listener);
  };
}

const sessionExpiredListeners = new Set<SessionExpiredListener>();
/** 同一次失效只广播一次，避免并发请求同时 401 时把订阅者刷屏。 */
let sessionExpiredNotified = false;

/**
 * 订阅「会话已失效」事件。AuthProvider 借此把 authed 翻成 false，
 * 路由守卫随即把用户送回登录页——不再停留在「登录已失效，请重新登录」的死页面上。
 */
export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => {
    sessionExpiredListeners.delete(listener);
  };
}

/**
 * 清会话并广播失效事件（幂等：会话已空时不重复广播）。
 *
 * failedToken：本次失败请求当时用的 token。若它与当前 token 不一致，说明会话已经轮换过
 * （典型场景：改密换发新 token，而用旧 token 发出的并发请求此刻才回来报 401），
 * 这种迟到的 401 不能拿来作废已经生效的新会话。
 */
export function expireSession(reason: SessionExpiredReason = 'expired', failedToken?: string | null) {
  const token = getToken();
  // 显式传了「本次失败请求用的 token」就必须与当前会话严格一致才作废。
  // 注意 failedToken 为 null（请求发出时本标签页还没登录）同样算不一致：
  // 会话现在共享 localStorage，别的标签页刚登录成功的会话不能被这条 401 清掉。
  if (failedToken !== undefined && token !== failedToken) return;
  clearSession();
  if (!token || sessionExpiredNotified) return;
  sessionExpiredNotified = true;
  for (const listener of [...sessionExpiredListeners]) listener({ reason, token });
}

/**
 * 接管「别的标签页刚建立的会话」时必须重置失效闩。
 *
 * sessionExpiredNotified 是模块级的，只在本标签页登录 / 改密 / 导入快照时清零。
 * 若本标签页此前已经历过一次失效（闩=true），随后 A 标签页登录、本标签页靠 storage 事件
 * 变回已登录，闩仍是 true —— 等这个新会话将来撞 401，expireSession 会清掉存储却不再广播，
 * React 状态就永远停在「已登录但没有 token」，只能刷新页面才能恢复。
 */
export function adoptStoredSession(): void {
  sessionExpiredNotified = false;
}

export type SessionSnapshot = {
  token: string;
  user: { username?: string; displayName?: string; identityProvider?: string } | null;
  tenant: import('./types').TenantSession | null;
  mustChangePassword: boolean;
  expiresAt: string | null;
};

export const API_BASE = (import.meta.env.VITE_LLMGW_API_BASE || getDefaultApiBase()).replace(/\/$/, '');

/**
 * 会话存储走 localStorage：关掉浏览器再打开仍然保持登录（sessionStorage 做不到，
 * 一关标签页就得重登，正是「一下就过期」的主因之一）。
 * 安全性不靠前端存储兜底：token 有 7 天硬过期，且每个已鉴权请求都会在服务端重新校验
 * 用户 SecurityVersion / 成员版本 / 租户状态，改密、禁用、踢出成员会立即让旧 token 失效。
 */
const sessionStore: Storage = localStorage;

/**
 * 老会话（存在 sessionStorage 里）平滑迁移，避免本次升级把在线用户踢下线。
 * 搬完必须把 sessionStorage 里的原件删干净：留着的话，登出/401 清掉 localStorage 后
 * 同一个标签页一刷新又会把旧 token 迁回来，等于登出失效、还可能卡在过期 token 的登录循环里。
 */
(function migrateLegacySessionStorage() {
  try {
    const hasLegacy = sessionStorage.getItem(TOKEN_KEY) !== null;
    if (!hasLegacy) return;
    const alreadyMigrated = sessionStore.getItem(TOKEN_KEY) !== null;
    for (const key of SESSION_KEYS) {
      const value = sessionStorage.getItem(key);
      if (!alreadyMigrated && value !== null) sessionStore.setItem(key, value);
      sessionStorage.removeItem(key);
    }
  } catch {
    /* 存储不可用（隐私模式等）时忽略，走重新登录 */
  }
})();

export function getToken(): string | null {
  return sessionStore.getItem(TOKEN_KEY);
}

export function getStoredUser(): { username?: string; displayName?: string; identityProvider?: string } | null {
  const raw = sessionStore.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getStoredTenant(): import('./types').TenantSession | null {
  const raw = sessionStore.getItem(TENANT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getSessionExpiresAt(): number | null {
  const raw = sessionStore.getItem(EXPIRES_KEY);
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

/** 本地判定会话是否已过期（后端仍是权威，这里只用于主动登出与快照交接）。 */
export function isSessionExpired(now: number = Date.now()): boolean {
  const expiresAt = getSessionExpiresAt();
  return expiresAt !== null && now >= expiresAt;
}

function writeExpiresAt(expiresAt?: string | null) {
  if (expiresAt) sessionStore.setItem(EXPIRES_KEY, expiresAt);
  else sessionStore.removeItem(EXPIRES_KEY);
}

export function setSession(result: LoginResult) {
  sessionExpiredNotified = false;
  sessionStore.setItem(TOKEN_KEY, result.token);
  sessionStore.setItem(
    USER_KEY,
    JSON.stringify({
      username: result.username ?? undefined,
      displayName: result.displayName ?? undefined,
      identityProvider: result.identityProvider ?? undefined,
    }),
  );
  if (result.tenant) sessionStore.setItem(TENANT_KEY, JSON.stringify(result.tenant));
  else sessionStore.removeItem(TENANT_KEY);
  if (result.mustChangePassword) sessionStore.setItem(MCP_KEY, '1');
  else sessionStore.removeItem(MCP_KEY);
  writeExpiresAt(result.expiresAt);
}

// 改密成功后，用重新签发的 token 替换会话并清除强制改密标记。
export function applyChangePasswordResult(result: ChangePasswordResult) {
  sessionExpiredNotified = false;
  sessionStore.setItem(TOKEN_KEY, result.token);
  writeExpiresAt(result.expiresAt);
  sessionStore.setItem(
    USER_KEY,
    JSON.stringify({
      username: result.username ?? undefined,
      displayName: result.displayName ?? undefined,
      identityProvider: result.identityProvider ?? undefined,
    }),
  );
  if (result.tenant) sessionStore.setItem(TENANT_KEY, JSON.stringify(result.tenant));
  sessionStore.removeItem(MCP_KEY);
}

export function clearSession() {
  for (const key of SESSION_KEYS) {
    sessionStore.removeItem(key);
    // 双保险：迁移逻辑已删过 sessionStorage 原件，这里再清一次，
    // 保证登出后没有任何一处残留能把会话「复活」。
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* 存储不可用时忽略 */
    }
  }
}

export function exportSessionSnapshot(): SessionSnapshot | null {
  const token = getToken();
  // 已过期的会话不再交接给新标签页，否则新标签页会先「假登录」再被 401 踢出，白闪一下。
  if (!token || isSessionExpired()) return null;
  return {
    token,
    user: getStoredUser(),
    tenant: getStoredTenant(),
    mustChangePassword: mustChangePassword(),
    expiresAt: sessionStore.getItem(EXPIRES_KEY),
  };
}

/** 导入其他标签页的会话快照；快照已过期则拒绝导入，返回 false。 */
export function importSessionSnapshot(snapshot: SessionSnapshot): boolean {
  if (snapshot.expiresAt) {
    const ts = Date.parse(snapshot.expiresAt);
    if (Number.isFinite(ts) && Date.now() >= ts) return false;
  }
  sessionExpiredNotified = false;
  sessionStore.setItem(TOKEN_KEY, snapshot.token);
  writeExpiresAt(snapshot.expiresAt);
  if (snapshot.user) sessionStore.setItem(USER_KEY, JSON.stringify(snapshot.user));
  else sessionStore.removeItem(USER_KEY);
  if (snapshot.tenant) sessionStore.setItem(TENANT_KEY, JSON.stringify(snapshot.tenant));
  else sessionStore.removeItem(TENANT_KEY);
  if (snapshot.mustChangePassword) sessionStore.setItem(MCP_KEY, '1');
  else sessionStore.removeItem(MCP_KEY);
  return true;
}

export function isAuthed(): boolean {
  return !!getToken() && !isSessionExpired();
}

export function mustChangePassword(): boolean {
  return sessionStore.getItem(MCP_KEY) === '1';
}

/**
 * 接住服务端滑动续期换发的新 token。
 *
 * 只替换「发起本次请求的那一把 token」：请求在途期间用户可能已登出、或换了另一个账号登录
 * （会话现在存 localStorage，跨标签页共享，这种交叉更容易发生）。此时本地存的是新账号的
 * token，若无条件覆盖，就会让新账号的用户/租户信息配上旧账号的凭据。本地 token 已经不是
 * 请求时那把（含已登出为空）时一律跳过，最坏结果只是这次不续期。
 */
export function applyRenewedToken(res: Response, requestToken: string | null): void {
  const renewed = res.headers.get(RENEWED_TOKEN_HEADER);
  if (!renewed || !requestToken) return;
  try {
    if (sessionStore.getItem(TOKEN_KEY) !== requestToken) return;
    sessionStore.setItem(TOKEN_KEY, renewed);
    // 到期时间必须跟着新 token 走：留着旧的，主动过期定时器会在旧时间点把已经续过期的
    // 会话踢下线（新 token 明明还有效），用户看到的就是「刚用着就掉登录」。
    const renewedExpiresAt = res.headers.get(RENEWED_EXPIRES_HEADER);
    if (renewedExpiresAt) writeExpiresAt(renewedExpiresAt);
    for (const listener of [...sessionRenewedListeners]) listener();
  } catch {
    /* 存储不可用时忽略：本次请求已成功，下次再续 */
  }
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
  const anonymous = ANONYMOUS_PATHS.some((p) => path === p || path.startsWith(`${p}?`));
  if (token) headers.Authorization = `Bearer ${token}`;

  // token 已到期就不再发这一枪：直接失效并让守卫接管，省掉一次注定 401 的往返。
  if (token && !anonymous && isSessionExpired()) {
    expireSession('expired', token);
    return { success: false, data: null, error: { code: 'UNAUTHORIZED', message: SESSION_EXPIRED_MESSAGE } };
  }

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

  // 滑动续期：服务端换发了新 token 就地替换，用户无感继续用（无需重登、无需轮询）。
  // 401 的处理仍走下面 expireSession 那条唯一路径（它自带「只作废本次请求那把 token」的判断）。
  applyRenewedToken(res, token);


  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  const envelope = payload && typeof payload === 'object' && 'success' in (payload as Record<string, unknown>)
    ? (payload as ApiResponse<T>)
    : null;

  if (res.status === 401) {
    // 带着会话去调业务接口却被 401 → 会话确实失效：清会话 + 广播，路由守卫会把用户送回登录页。
    // 匿名接口（登录 / 一键登录）的 401 只是这次凭据不对，保留服务端原文，别误伤已有会话。
    if (token && !anonymous) {
      const code = envelope?.error?.code || 'UNAUTHORIZED';
      expireSession(REVOKED_ERROR_CODES.has(code) ? 'revoked' : 'expired', token);
      return {
        success: false,
        data: null,
        error: { code, message: envelope?.error?.message || SESSION_EXPIRED_MESSAGE },
      };
    }
    if (envelope) return envelope;
    return { success: false, data: null, error: { code: 'UNAUTHORIZED', message: '身份校验未通过，请重新登录' } };
  }

  // 优先认后端的 { success, data, error } 信封；否则按 HTTP 状态包装。
  if (envelope) return envelope;

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

export function exchangeMapSso(req: MapSsoRequest): Promise<ApiResponse<LoginResult>> {
  const existing = mapSsoExchanges.get(req.code);
  if (existing) return existing;

  const exchange = apiRequest<LoginResult>('/auth/map-sso', { method: 'POST', body: req });
  mapSsoExchanges.set(req.code, exchange);
  return exchange;
}

export function changePassword(req: ChangePasswordRequest): Promise<ApiResponse<ChangePasswordResult>> {
  return apiRequest<ChangePasswordResult>('/auth/change-password', { method: 'POST', body: req });
}

// ── 日志 ──
export function getLogs(params: LogsListParams): Promise<ApiResponse<LogsListData>> {
  return apiRequest<LogsListData>('/logs', { query: { ...params } });
}

type HealthData = {
  status: string;
  commit?: string | null;
  time?: string | null;
  /** 平台下发的 MAP 主入口；缺省表示平台没说，前端退回本地推算（见 mapNavigation）。 */
  mapHomeUrl?: string | null;
};

export function getHealth(): Promise<ApiResponse<HealthData>> {
  // 在这里而不是在页面里喂 mapNavigation：健康检查已经是 LoginPage / HomePage 的
  // 启动动作，顺路把权威地址收下即可，页面一行都不用改（也就不会碰跨模块源码契约）。
  return apiRequest<HealthData>('/healthz').then((res) => {
    if (res.success) setPlatformMapHome(res.data?.mapHomeUrl);
    return res;
  });
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
export function getPools(modelType?: string, sinceHours = 168): Promise<ApiResponse<PoolsData>> {
  return apiRequest<PoolsData>('/pools', { query: { modelType, sinceHours } });
}
export function getPlatforms(): Promise<ApiResponse<PlatformsData>> {
  return apiRequest<PlatformsData>('/platforms');
}
export function createPlatform(req: CreatePlatformRequest): Promise<ApiResponse<PlatformItem>> {
  return apiRequest<PlatformItem>('/platforms', { method: 'POST', body: req });
}
export function getModels(params?: { platformId?: string; enabled?: boolean }): Promise<ApiResponse<ModelsData>> {
  return apiRequest<ModelsData>('/models', {
    query: { platformId: params?.platformId, enabled: params?.enabled === undefined ? undefined : String(params.enabled) },
  });
}
export function createModel(req: CreateModelRequest): Promise<ApiResponse<CreateModelResult>> {
  return apiRequest<CreateModelResult>('/models', { method: 'POST', body: req });
}
export function getLogicalModels(params?: { modelType?: string; enabled?: boolean }): Promise<ApiResponse<LogicalModelsData>> {
  return apiRequest<LogicalModelsData>('/logical-models', {
    query: { modelType: params?.modelType, enabled: params?.enabled === undefined ? undefined : String(params.enabled) },
  });
}
export function createLogicalModel(req: CreateLogicalModelRequest): Promise<ApiResponse<LogicalModelItem>> {
  return apiRequest<LogicalModelItem>('/logical-models', { method: 'POST', body: req });
}
export function updateLogicalModel(id: string, req: UpdateLogicalModelRequest): Promise<ApiResponse<LogicalModelItem>> {
  return apiRequest<LogicalModelItem>(`/logical-models/${encodeURIComponent(id)}`, { method: 'PUT', body: req });
}
export function createModelOffering(logicalModelId: string, req: CreateModelOfferingRequest): Promise<ApiResponse<ModelOfferingItem>> {
  return apiRequest<ModelOfferingItem>(`/logical-models/${encodeURIComponent(logicalModelId)}/offerings`, { method: 'POST', body: req });
}
export function updateModelOffering(logicalModelId: string, offeringId: string, req: UpdateModelOfferingRequest): Promise<ApiResponse<ModelOfferingItem>> {
  return apiRequest<ModelOfferingItem>(
    `/logical-models/${encodeURIComponent(logicalModelId)}/offerings/${encodeURIComponent(offeringId)}`,
    { method: 'PUT', body: req },
  );
}
export function setLogicalModelEnabled(id: string, enabled: boolean): Promise<ApiResponse<LogicalModelItem>> {
  return apiRequest<LogicalModelItem>(`/logical-models/${encodeURIComponent(id)}/enabled`, { method: 'PUT', body: { enabled } });
}
export function setModelOfferingEnabled(logicalModelId: string, offeringId: string, enabled: boolean): Promise<ApiResponse<ModelOfferingItem>> {
  return apiRequest<ModelOfferingItem>(
    `/logical-models/${encodeURIComponent(logicalModelId)}/offerings/${encodeURIComponent(offeringId)}/enabled`,
    { method: 'PUT', body: { enabled } },
  );
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
  modelPoolId?: string;
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
      modelPoolId: params?.modelPoolId,
      drift: params?.drift,
      search: params?.search,
    },
  });
}
export function updateGatewayAppCaller(id: string, req: UpdateGatewayAppCallerRequest): Promise<ApiResponse<GatewayAppCaller>> {
  return apiRequest<GatewayAppCaller>(`/app-callers/${encodeURIComponent(id)}`, { method: 'PUT', body: req });
}
export function createGatewayAppCaller(req: CreateGatewayAppCallerRequest): Promise<ApiResponse<GatewayAppCaller>> {
  return apiRequest<GatewayAppCaller>('/app-callers', { method: 'POST', body: req });
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
export function confirmServiceKeyClientCutover(id: string): Promise<ApiResponse<{ id: string; successorKeyId: string; rotationState: string }>> {
  return apiRequest<{ id: string; successorKeyId: string; rotationState: string }>(`/service-keys/${encodeURIComponent(id)}/rotation/client-cutover`, { method: 'POST' });
}
export function getCostReconciliations(params?: { from?: string; to?: string }): Promise<ApiResponse<CostReconciliationSummary>> {
  return apiRequest<CostReconciliationSummary>('/cost-reconciliations', { query: params });
}
export function importCostReconciliation(req: CostReconciliationImportRequest): Promise<ApiResponse<CostReconciliationItem>> {
  return apiRequest<CostReconciliationItem>('/cost-reconciliations/import', { method: 'POST', body: req });
}
export function getTenantGovernance(): Promise<ApiResponse<TenantGovernanceData>> {
  return apiRequest<TenantGovernanceData>('/tenant-governance');
}
export function updateTenantGovernance(req: UpdateTenantGovernanceRequest): Promise<ApiResponse<TenantGovernanceData>> {
  return apiRequest<TenantGovernanceData>('/tenant-governance', { method: 'PUT', body: req });
}
export function getLegacyKeyCutover(): Promise<ApiResponse<LegacyKeyCutoverData>> {
  return apiRequest<LegacyKeyCutoverData>('/legacy-key-cutover');
}
export function updateLegacyKeyCutover(req: {
  status: 'observing' | 'ready' | 'revoked';
  deadlineAt: string;
  allowedAppCallerCodes: string[];
  successorServiceKeyIds: string[];
  requiredSuccessorObservations: number;
}): Promise<ApiResponse<{ id: string; status: string; deadlineAt: string; observed: number; required: number }>> {
  return apiRequest('/legacy-key-cutover', { method: 'PUT', body: req });
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
export function createMember(req: CreateMemberRequest): Promise<ApiResponse<CreatedMember>> {
  return apiRequest<CreatedMember>('/members', { method: 'POST', body: req });
}
export function updateMember(id: string, req: UpdateMemberRequest): Promise<ApiResponse<{ id: string; role: string; status: string; teamIds: string[]; version: number }>> {
  return apiRequest(`/members/${encodeURIComponent(id)}`, { method: 'PUT', body: req });
}
export function invalidateMemberSessions(id: string): Promise<ApiResponse<{ id: string; userId: string; version: number; invalidated: boolean }>> {
  return apiRequest(`/members/${encodeURIComponent(id)}/invalidate-sessions`, { method: 'POST' });
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
export function getExchangeMeta(): Promise<ApiResponse<ExchangeMetaData>> {
  return apiRequest<ExchangeMetaData>('/exchanges/meta');
}
export function createExchange(req: CreateExchangeRequest): Promise<ApiResponse<ExchangeItem>> {
  return apiRequest<ExchangeItem>('/exchanges', { method: 'POST', body: req });
}
export function updateExchange(id: string, req: UpdateExchangeRequest): Promise<ApiResponse<ExchangeItem>> {
  return apiRequest<ExchangeItem>(`/exchanges/${encodeURIComponent(id)}`, { method: 'PUT', body: req });
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
export function getPoolTypes(): Promise<ApiResponse<PoolTypesData>> {
  return apiRequest<PoolTypesData>('/pool-types');
}
export function ensurePoolTypes(): Promise<ApiResponse<EnsurePoolTypesResult>> {
  return apiRequest<EnsurePoolTypesResult>('/pool-types/ensure', { method: 'POST' });
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
export function recoverPoolModel(id: string, modelId: string, platformId: string): Promise<ApiResponse<ModelPool>> {
  return apiRequest<ModelPool>(`/pools/${encodeURIComponent(id)}/models/recover`, {
    method: 'POST',
    body: { modelId, platformId },
  });
}
export function removePoolModel(id: string, modelId: string, platformId?: string): Promise<ApiResponse<ModelPool>> {
  return apiRequest<ModelPool>(`/pools/${encodeURIComponent(id)}/models`, {
    method: 'DELETE',
    query: { modelId, platformId },
  });
}
