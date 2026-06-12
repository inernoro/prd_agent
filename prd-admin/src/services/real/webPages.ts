import { apiRequest } from '@/services/real/apiClient';
import type { WebHostingRole } from '@/services/real/teams';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';

// ─── Types ───

export interface HostedSiteFile {
  path: string;
  cosKey: string;
  size: number;
  mimeType: string;
}

export interface HostedSite {
  id: string;
  title: string;
  description?: string;
  sourceType: string;
  sourceRef?: string;
  cosPrefix: string;
  entryFile: string;
  /** 自动包装的资产类型 ("pdf" / "video" / "markdown" / undefined=非包装站)；用于区分用户上传的"index.html + .pdf" 与系统自动包装的 PDF 壳子 */
  wrappedAssetType?: string;
  siteUrl: string;
  files: HostedSiteFile[];
  totalSize: number;
  tags: string[];
  folder?: string;
  coverImageUrl?: string;
  ownerUserId: string;
  /** 分享到的团队 ID 列表（仅网页托管消费） */
  sharedTeamIds?: string[];
  /** 团队空间分组归属（专题/日常分类的 WebPageGroup.Id；null/undefined = 未分组） */
  groupId?: string | null;
  viewCount: number;
  /** 可见性：private = 仅自己可见 | public = 出现在 /u/:username 公开页 */
  visibility?: 'private' | 'public';
  /** 首次设为 public 的时间 */
  publishedAt?: string | null;
  /** 是否允许被评论（默认 true，owner 可关闭） */
  commentsEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ShareLinkItem {
  id: string;
  token: string;
  /** 统一短链 Seq（数字 ID）；旧记录可能为 0，UI 此时退回老 /s/wp/{token} 链接 */
  shortSeq?: number;
  siteId?: string;
  siteIds: string[];
  shareType: string;
  title?: string;
  description?: string;
  accessLevel: string;
  password?: string;
  viewCount: number;
  /** 唯一 IP 数（基于访问日志 distinct IP 聚合缓存） */
  uniqueIpCount?: number;
  lastViewedAt?: string;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  expiresAt?: string;
  isRevoked: boolean;
  /** 可见性：owner-only（默认 = 仅创建者/团队） / logged-in / public */
  visibility?: 'owner-only' | 'logged-in' | 'public';
  /** 是否已过期 */
  isExpired?: boolean;
  /** 是否处于过期 7 天宽限期内（仍可续期） */
  inGracePeriod?: boolean;
  /** 续期/修改历史次数 */
  renewalCount?: number;
}

export interface ShareAnalyticsLinkSummary {
  shareId: string;
  token: string;
  title?: string;
  shareUrl?: string;
  viewCount: number;
  uniqueIpCount: number;
  lastViewedAt?: string;
  createdAt: string;
  expiresAt?: string;
  visibility: string;
  visitors?: ShareAnalyticsVisitorSummary[];
}

export interface ShareAnalyticsTimelineEntry {
  viewedAt: string;
  shareToken: string;
  shareTitle?: string;
  shareUrl?: string;
  viewerUserId?: string;
  viewerName?: string;
  viewerAvatarFileName?: string;
  ipAddress?: string;
  userAgent?: string;
  clientSummary?: string;
}

export interface ShareAnalyticsVisitorSummary {
  viewerUserId?: string;
  viewerName: string;
  viewerAvatarFileName?: string;
  viewCount: number;
}

export interface ShareAnalyticsResult {
  totalShares: number;
  activeShares: number;
  expiredShares: number;
  totalViews: number;
  uniqueIpCount: number;
  commentCount?: number;
  timeline: ShareAnalyticsTimelineEntry[];
  topLinks: ShareAnalyticsLinkSummary[];
  trend?: ShareAnalyticsTrendPoint[];
  hourly?: ShareAnalyticsHourlyPoint[];
  topVisitors?: ShareAnalyticsVisitorStats[];
  recentComments?: ShareAnalyticsCommentEntry[];
}

export interface ShareAnalyticsTrendPoint {
  date: string;
  views: number;
  comments: number;
}

export interface ShareAnalyticsHourlyPoint {
  hour: number;
  views: number;
}

export interface ShareAnalyticsVisitorStats {
  viewerUserId?: string;
  viewerName: string;
  viewerAvatarFileName?: string;
  viewCount: number;
  lastViewedAt: string;
}

export interface ShareAnalyticsCommentEntry {
  id: string;
  siteId: string;
  siteTitle: string;
  shareToken?: string;
  authorName: string;
  authorAvatarFileName?: string;
  content: string;
  createdAt: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

// ─── Helper ───

function getApiBaseUrl() {
  return ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

// ─── Upload (FormData) ───

export async function uploadSite(input: {
  file: File;
  title?: string;
  description?: string;
  folder?: string;
  tags?: string;
}): Promise<ApiResponse<HostedSite>> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', input.file);
  if (input.title) fd.append('title', input.title);
  if (input.description) fd.append('description', input.description);
  if (input.folder) fd.append('folder', input.folder);
  if (input.tags) fd.append('tags', input.tags);

  const url = joinUrl(getApiBaseUrl(), api.webPages.upload());
  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<HostedSite>;
  } catch {
    return { success: false, data: null as never, error: { code: 'INVALID_FORMAT', message: `响应解析失败（HTTP ${res.status}）` } };
  }
}

export async function reuploadSite(id: string, file: File): Promise<ApiResponse<HostedSite>> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', file);

  const url = joinUrl(getApiBaseUrl(), api.webPages.reupload(encodeURIComponent(id)));
  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<HostedSite>;
  } catch {
    return { success: false, data: null as never, error: { code: 'INVALID_FORMAT', message: `响应解析失败（HTTP ${res.status}）` } };
  }
}

// ─── From Content ───

export async function createFromContent(input: {
  htmlContent: string;
  title?: string;
  description?: string;
  sourceType?: string;
  sourceRef?: string;
  tags?: string[];
  folder?: string;
}): Promise<ApiResponse<HostedSite>> {
  return apiRequest(api.webPages.fromContent(), { method: 'POST', body: input });
}

// ─── CRUD ───

/** 团队作用域下，后端附带的创建者展示卡（userId → 昵称 + 头像文件名） */
export interface SiteOwnerCard {
  userId: string;
  displayName: string;
  avatarFileName?: string;
}

export async function listSites(params?: {
  keyword?: string;
  folder?: string;
  tag?: string;
  sourceType?: string;
  sort?: string;
  skip?: number;
  limit?: number;
  /** 'team' + teamId 返回团队共享站点，缺省返回我的 */
  scope?: 'mine' | 'team';
  teamId?: string | null;
}): Promise<
  ApiResponse<{
    items: HostedSite[];
    total: number;
    owners?: Record<string, SiteOwnerCard>;
    /** 团队作用域下，我在该团队的网页托管有效角色（owner/editor/viewer）；个人作用域不返回 */
    myWebHostingRole?: WebHostingRole;
  }>
> {
  const sp = new URLSearchParams();
  if (params?.keyword) sp.set('keyword', params.keyword);
  if (params?.folder) sp.set('folder', params.folder);
  if (params?.tag) sp.set('tag', params.tag);
  if (params?.sourceType) sp.set('sourceType', params.sourceType);
  if (params?.sort) sp.set('sort', params.sort);
  if (params?.skip) sp.set('skip', String(params.skip));
  if (params?.limit) sp.set('limit', String(params.limit));
  if (params?.scope === 'team') {
    sp.set('scope', 'team');
    // teamId 缺省 = 跨团队聚合视图（我加入的所有团队的共享站点）
    if (params.teamId) sp.set('teamId', params.teamId);
  }
  const q = sp.toString();
  return apiRequest(`${api.webPages.list()}${q ? `?${q}` : ''}`, { method: 'GET' });
}

export async function getSite(id: string): Promise<ApiResponse<HostedSite>> {
  return apiRequest(api.webPages.byId(encodeURIComponent(id)), { method: 'GET' });
}

export async function updateSite(id: string, data: {
  title?: string;
  description?: string;
  tags?: string[];
  folder?: string;
  coverImageUrl?: string;
}): Promise<ApiResponse<HostedSite>> {
  return apiRequest(api.webPages.byId(encodeURIComponent(id)), { method: 'PUT', body: data });
}

export async function deleteSite(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(api.webPages.byId(encodeURIComponent(id)), { method: 'DELETE' });
}

export async function batchDeleteSites(ids: string[]): Promise<ApiResponse<{ deletedCount: number }>> {
  return apiRequest(api.webPages.batchDelete(), { method: 'POST', body: { ids } });
}

export async function setSiteVisibility(
  id: string,
  visibility: 'public' | 'private',
): Promise<ApiResponse<HostedSite>> {
  return apiRequest(api.webPages.setVisibility(encodeURIComponent(id)), {
    method: 'PATCH',
    body: { visibility },
  });
}

export async function listFolders(): Promise<ApiResponse<{ folders: string[] }>> {
  return apiRequest(api.webPages.folders(), { method: 'GET' });
}

export async function listTags(): Promise<ApiResponse<{ tags: TagCount[] }>> {
  return apiRequest(api.webPages.tags(), { method: 'GET' });
}

// ─── Team Groups（团队空间专题 / 日常分类） ───

export type WebPageGroupVisibility = 'inherit' | 'restricted';
export type WebPageGroupSubjectType = 'user' | 'label';
/** 分组级角色档位（owner 不下放到分组级） */
export type WebPageGroupRole = 'viewer' | 'editor';

export interface WebPageGroupAccessRule {
  /** user = 具体成员 | label = 角色标签 */
  subjectType: WebPageGroupSubjectType;
  /** user 时为成员 UserId；label 时为标签文本 */
  subjectId: string;
  role: WebPageGroupRole;
}

export interface WebPageGroup {
  id: string;
  teamId: string;
  /** topic = 专题 | daily = 日常分类 */
  kind: 'topic' | 'daily';
  name: string;
  sortOrder: number;
  createdBy: string;
  /** inherit = 跟随空间角色（默认）| restricted = 仅授权成员与空间 owner 可见 */
  visibility?: WebPageGroupVisibility;
  /** 授权规则（仅空间 owner 拿得到；普通成员为 null） */
  accessRules?: WebPageGroupAccessRule[] | null;
  /** 我对该分组的有效角色（后端解析；受限分组未授权时整条分组不会返回） */
  myGroupRole?: 'owner' | 'editor' | 'viewer';
  createdAt: string;
  updatedAt: string;
}

export async function listSiteGroups(teamId: string): Promise<ApiResponse<{ groups: WebPageGroup[] }>> {
  return apiRequest(`${api.webPages.groups()}?teamId=${encodeURIComponent(teamId)}`, { method: 'GET' });
}

export async function createSiteGroup(input: {
  teamId: string;
  kind: 'topic' | 'daily';
  name: string;
  sortOrder?: number;
}): Promise<ApiResponse<WebPageGroup>> {
  return apiRequest(api.webPages.groups(), { method: 'POST', body: input });
}

export async function updateSiteGroup(
  groupId: string,
  input: { name?: string; sortOrder?: number },
): Promise<ApiResponse<WebPageGroup>> {
  return apiRequest(api.webPages.groupById(encodeURIComponent(groupId)), { method: 'PUT', body: input });
}

export async function deleteSiteGroup(groupId: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(api.webPages.groupById(encodeURIComponent(groupId)), { method: 'DELETE' });
}

/** 设置分组可见性与授权规则（仅空间 owner 可调）。inherit 时 rules 被清空。 */
export async function updateSiteGroupAccess(
  groupId: string,
  input: { visibility: WebPageGroupVisibility; rules?: WebPageGroupAccessRule[] },
): Promise<ApiResponse<WebPageGroup>> {
  return apiRequest(api.webPages.groupAccess(encodeURIComponent(groupId)), {
    method: 'PUT',
    body: input,
  });
}

export async function setSiteGroup(siteId: string, groupId: string | null): Promise<ApiResponse<HostedSite>> {
  return apiRequest(api.webPages.setGroup(encodeURIComponent(siteId)), {
    method: 'PATCH',
    body: { groupId },
  });
}

/** 把自己的网页物理复制一份进团队空间（副本独立，原件不受影响） */
export async function copySiteToTeam(
  siteId: string,
  teamId: string,
  groupId?: string | null,
): Promise<ApiResponse<HostedSite>> {
  return apiRequest(api.webPages.copyToTeam(encodeURIComponent(siteId)), {
    method: 'POST',
    body: { teamId, groupId: groupId ?? null },
  });
}

// ─── Share ───

export async function createShareLink(data: {
  siteId?: string;
  siteIds?: string[];
  shareType?: string;
  title?: string;
  description?: string;
  password?: string;
  expiresInDays?: number;
  /** 'visit' = 站点访问便捷链（公开永久、与用户分享互不复用/篡改）；缺省 = 用户分享 */
  purpose?: string;
  /** 是否强制新建（默认 true，分享面板每次显式新建） */
  forceNew?: boolean;
  /** 访问可见性：owner-only（默认）/ logged-in / public */
  visibility?: 'owner-only' | 'logged-in' | 'public';
  /** 是否分配数字短链 /s/{seq}。默认 false：只发 /s/wp/{token} 长链，不污染 short_links */
  allocateShortLink?: boolean;
}): Promise<ApiResponse<{
  id: string;
  token: string;
  shareType: string;
  accessLevel: string;
  /** 访问密码：复用已有带密码链接时返回的是既有密码（可能与本次输入不同） */
  password?: string;
  expiresAt?: string;
  /** 统一短链 Seq（>0 表示分配成功） */
  shortSeq?: number;
  /** 默认推荐：带分类前缀长链 /s/wp/{token}（URL 有语义、利于总管理分类） */
  shareUrl: string;
  /** 可选超短链：/s/{seq}（数字可枚举，须配强密码；分配失败为 null） */
  shortShareUrl?: string | null;
  /** 字母统一长链 /s/{token}（ShortLink 索引支持，高级选项） */
  unifiedShareUrl?: string;
}>> {
  return apiRequest(api.webPages.share(), { method: 'POST', body: data });
}

export async function listShares(): Promise<ApiResponse<{ items: ShareLinkItem[] }>> {
  return apiRequest(api.webPages.shares(), { method: 'GET' });
}

/**
 * 事后为某条已存在的分享按需生成数字短链 /s/{seq}（用户点「生成数字短链」时调用）。
 * 幂等：已有则返回原 seq。
 */
export async function ensureShareShortLink(shareId: string): Promise<ApiResponse<{
  shortSeq: number;
  shortShareUrl: string | null;
}>> {
  return apiRequest(api.webPages.shareShortLink(encodeURIComponent(shareId)), { method: 'POST' });
}

export async function revokeShare(shareId: string): Promise<ApiResponse<{ revoked: boolean }>> {
  return apiRequest(api.webPages.revokeShare(encodeURIComponent(shareId)), { method: 'DELETE' });
}

// ─── Public Share View ───

export interface SharedSiteInfo {
  id: string;
  title: string;
  description?: string;
  siteUrl: string;
  entryFile: string;
  totalSize: number;
  fileCount: number;
  coverImageUrl?: string;
  // 仅当本站点是「PDF 包装站」时填充。前端应直接 iframe 这个 URL，
  // 不能走 siteUrl + sandbox 嵌套——会被 Chrome 屏蔽 PDF Viewer。
  pdfAssetUrl?: string;
}

export interface ShareViewData {
  title: string;
  description?: string;
  shareType: string;
  createdAt: string;
  createdBy?: string;
  createdByName?: string;
  sites: SharedSiteInfo[];
}

export async function viewShare(token: string, password?: string): Promise<ApiResponse<ShareViewData>> {
  const q = password ? `?password=${encodeURIComponent(password)}` : '';
  // 使用 raw fetch 避免 apiRequest 的 401 自动 refresh/redirect 逻辑，此端点是公开的
  // 但仍需携带 auth token（如果已登录），以便后端识别观看者身份
  const url = joinUrl(getApiBaseUrl(), `${api.webPages.viewShare(encodeURIComponent(token))}${q}`);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const authToken = useAuthStore.getState().token;
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  try {
    const res = await fetch(url, { headers });
    const json = await res.json();
    return json as ApiResponse<ShareViewData>;
  } catch {
    return { success: false, data: null as never, error: { code: 'NETWORK_ERROR', message: '网络请求失败' } };
  }
}

// ─── Save Shared Site ───

export async function saveSharedSite(token: string, password?: string): Promise<ApiResponse<{ saved?: boolean; alreadySaved?: boolean; siteCount?: number }>> {
  const q = password ? `?password=${encodeURIComponent(password)}` : '';
  return apiRequest(`${api.webPages.saveShare(encodeURIComponent(token))}${q}`, { method: 'POST' });
}

// ─── Share View Logs ───

export interface ShareViewLogItem {
  id: string;
  shareToken: string;
  shareId: string;
  viewerUserId?: string;
  viewerName?: string;
  viewerAvatarFileName?: string;
  shareOwnerUserId: string;
  viewedAt: string;
  ipAddress?: string;
  userAgent?: string;
}

export async function listShareViewLogs(shareToken?: string, limit = 100): Promise<ApiResponse<{ items: ShareViewLogItem[] }>> {
  const params = new URLSearchParams();
  if (shareToken) params.set('shareToken', shareToken);
  if (limit !== 100) params.set('limit', String(limit));
  const q = params.toString();
  return apiRequest(`${api.webPages.viewLogs}${q ? `?${q}` : ''}`);
}

/** 续期某条分享链接（仅创建者，过期 ≤ 7 天宽限期内仍可续期） */
export async function renewShare(shareId: string, extendDays: number): Promise<ApiResponse<{ newExpiresAt: string }>> {
  return apiRequest(`/api/web-pages/shares/${encodeURIComponent(shareId)}/renew`, {
    method: 'POST',
    body: { extendDays },
  });
}

/** 用户分享统计聚合（参考 Cloudflare 简化版，含活跃链接 / 时间窗内访问 / 独立访客 / 时间线 / Top 链接） */
export async function getShareAnalytics(rangeDays = 7, siteId?: string): Promise<ApiResponse<ShareAnalyticsResult>> {
  const params = new URLSearchParams({ rangeDays: String(rangeDays) });
  if (siteId) params.set('siteId', siteId);
  return apiRequest(`/api/web-pages/shares/analytics?${params.toString()}`);
}

// ─── 评论 ───

export interface HostedSiteCommentDto {
  id: string;
  siteId: string;
  content: string;
  authorUserId: string;
  authorName: string;
  authorAvatarFileName?: string;
  createdAt: string;
  canDelete: boolean;
}

export interface SiteCommentsResult {
  siteId: string;
  commentsEnabled: boolean;
  canComment: boolean;
  comments: HostedSiteCommentDto[];
  /** 429 限流时后端返回的重试秒数（正常读取为 undefined） */
  retryAfterSeconds?: number;
}

/** 切换站点是否允许评论（仅 owner / editor 可调） */
export async function setSiteCommentsEnabled(siteId: string, enabled: boolean): Promise<ApiResponse<{ id: string; commentsEnabled: boolean }>> {
  return apiRequest(`/api/web-pages/${encodeURIComponent(siteId)}/comments-enabled`, {
    method: 'PATCH',
    body: { enabled },
  });
}

/** 列出某站点评论（owner / 团队成员视角，需登录） */
export async function listSiteComments(siteId: string): Promise<ApiResponse<SiteCommentsResult>> {
  return apiRequest(`/api/web-pages/${encodeURIComponent(siteId)}/comments`);
}

/** 在某站点发表评论（owner / 团队成员视角，需登录） */
export async function addSiteComment(siteId: string, content: string): Promise<ApiResponse<HostedSiteCommentDto>> {
  return apiRequest(`/api/web-pages/${encodeURIComponent(siteId)}/comments`, {
    method: 'POST',
    body: { content },
  });
}

/** 经分享链接列出评论（无需登录即可读）。走 raw fetch（公开端点 + 可选携带 token 识别身份） */
export async function listShareComments(token: string, password?: string): Promise<ApiResponse<SiteCommentsResult>> {
  const q = password ? `?password=${encodeURIComponent(password)}` : '';
  const url = joinUrl(getApiBaseUrl(), `/api/web-pages/shares/view/${encodeURIComponent(token)}/comments${q}`);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const authToken = useAuthStore.getState().token;
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  try {
    const res = await fetch(url, { headers });
    return (await res.json()) as ApiResponse<SiteCommentsResult>;
  } catch {
    return { success: false, data: null as never, error: { code: 'NETWORK_ERROR', message: '网络请求失败' } };
  }
}

/** 经分享链接发表评论（需登录） */
export async function addShareComment(token: string, content: string, password?: string): Promise<ApiResponse<HostedSiteCommentDto>> {
  const q = password ? `?password=${encodeURIComponent(password)}` : '';
  return apiRequest(`/api/web-pages/shares/view/${encodeURIComponent(token)}/comments${q}`, {
    method: 'POST',
    body: { content },
  });
}

/** 删除评论（作者本人或站点 owner） */
export async function deleteSiteComment(commentId: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiRequest(`/api/web-pages/comments/${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
  });
}
