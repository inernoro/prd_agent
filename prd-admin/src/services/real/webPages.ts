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
  /** 入口 HTML 是不是一套幻灯片（后端上传时扫签名落库）；老数据没有这个字段 */
  isSlideDeck?: boolean;
  siteUrl: string;
  /**
   * PDF 包装站的原始 PDF 直链（后端算出，不入库）。
   *
   * 刻意写成**必填**而不是 `pdfAssetUrl?: string`：站内大预览要靠它绕开依赖第三方 CDN 的
   * PDF.js 壳子，而这个字段此前只挂在 SharedSiteInfo 上，站内列表根本收不到——判据在、数据不在，
   * 大预览的「绕开壳子」分支永远走不到，源码扫描型守卫还看不出来。
   * 声明成必填后，只要后端哪天不再下发、或有人把它从这个接口删掉，
   * resolveSitePreviewSource 的调用点会直接编译不过（predicate-and-wiring-discipline 形状 2）。
   */
  pdfAssetUrl: string | undefined;
  files: HostedSiteFile[];
  totalSize: number;
  tags: string[];
  folder?: string;
  /** 服务端权威文件夹名称键；禁止在浏览器端重新实现 Unicode 大小写归一化。 */
  folderCanonicalName: string;
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
  /**
   * 是否开放「向我提问」。**三态**，别当 boolean 用：
   * null / 缺字段 = owner 从没表过态（含全部存量站点与新上传）→ 视为**开**；
   * true = 明确打开；false = 明确关掉。
   * 所以判断一律用 `!== false`，写 `=== true` 会把「没表过态」误判成关。
   * 后端唯一判定源是 AskAccessPolicy.IsAskOn（还要叠加形态是否支持）。
   */
  askEnabled?: boolean | null;
  /** 站点级开场问题题库（分享时可从中挑几条） */
  askSuggestedQuestions?: string[];
  askAllowAnonymous?: boolean;
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
  /** 撤销时刻；存量已撤销链接没有这个字段，那一行只显示「已撤销」不带日期 */
  revokedAt?: string;
  /** 撤销原因（撤销时用户自己填的一句话），可空 */
  revokedReason?: string;
  /** 这条链接指向的站点标题；合集分享有多个。站点已删的 id 不会出现在这里 */
  siteTitles?: string[];
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
  /** 已过期之中续期真的救得回来的条数（未撤销且还在 7 天宽限窗内） */
  renewableExpiredShares: number;
  totalViews: number;
  uniqueIpCount: number;
  /** 独立访客数取自被截断的样本时为 true——此时它只是下界，不得据它算人均 */
  visitorSampleCapped: boolean;
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

/**
 * 把 `/api/...` 拼成实际要请求的地址。
 *
 * 走 apiRequest 的调用不用管这件事，但**裸 fetch 必须自己拼**——SSE 和 FormData 都绕开了
 * apiRequest。后端与前端分开部署时（VITE_API_BASE_URL 指向另一个域），相对路径会打到
 * 前端自己身上，拿回一个 404 或者一坨 HTML 而不是事件流。
 */
export function buildApiUrl(path: string) {
  return joinUrl(getApiBaseUrl(), path);
}

// ─── Upload (FormData) ───

export async function uploadSite(input: {
  file: File;
  title?: string;
  description?: string;
  folder?: string;
  tags?: string;
  /**
   * 上传字节进度回调。走 XHR 而不是 fetch 只为这一件事：
   * fetch 不暴露 request body 的发送进度，500MB 的 ZIP 在 fetch 下只能给一个转圈。
   * 这里回调的是**真实已发送字节数**，不是估的（`expectation-management`：
   * 给不出的数不许编，给得出的必须给）。
   */
  onProgress?: (loaded: number, total: number) => void;
  /**
   * 本次上传的标识，用于旁路查解包进度（见 getUploadProgress）。
   * 不传 = 服务端不记录进度，行为与改动前完全一致。
   */
  uploadId?: string;
  /** 拿到 XHR 句柄，调用方据此实现「中止」 */
  onStart?: (xhr: XMLHttpRequest) => void;
}): Promise<ApiResponse<HostedSite>> {
  const token = useAuthStore.getState().token;

  const fd = new FormData();
  fd.append('file', input.file);
  if (input.title) fd.append('title', input.title);
  if (input.description) fd.append('description', input.description);
  if (input.folder) fd.append('folder', input.folder);
  if (input.tags) fd.append('tags', input.tags);
  if (input.uploadId) fd.append('uploadId', input.uploadId);

  const url = joinUrl(getApiBaseUrl(), api.webPages.upload());
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Accept', 'application/json');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    if (input.onProgress) {
      xhr.upload.onprogress = (ev) => {
        // lengthComputable 为 false 时 total 是 0，报 0 会让进度条假装「一直 0%」，
        // 不如不报，让调用方走「无进度」分支。
        if (ev.lengthComputable) input.onProgress!(ev.loaded, ev.total);
      };
    }
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText) as ApiResponse<HostedSite>);
      } catch {
        resolve({ success: false, data: null as never, error: { code: 'INVALID_FORMAT', message: `响应解析失败（HTTP ${xhr.status}）` } });
      }
    };
    xhr.onerror = () => resolve({
      success: false, data: null as never,
      error: { code: 'NETWORK_ERROR', message: '网络异常，上传未完成' },
    });
    // 用户点「中止」时 xhr.abort() 走这里；不能落到 onerror 报「网络异常」，
    // 那是他自己按的，不是出错了
    xhr.onabort = () => resolve({
      success: false, data: null as never,
      error: { code: 'ABORTED', message: '已中止上传' },
    });
    input.onStart?.(xhr);
    xhr.send(fd);
  });
}

/**
 * 重传（替换既有站点的文件）。
 *
 * `signal` 是给「中止」那颗按钮用的：这条路径走 `fetch`（FormData 不能过 apiRequest），
 * 拿不到 XHR，所以中止必须靠 AbortController。没有它的话按钮点下去只是把进度屏藏起来，
 * 请求照跑、站点照换 —— 界面说停了，实际没停，比没有这颗按钮更糟。
 */
export async function reuploadSite(
  id: string, file: File, uploadId?: string, signal?: AbortSignal,
): Promise<ApiResponse<HostedSite>> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', file);
  // 解包进度是按这个键存的，不带上的话换 ZIP 时那块面板一直停在「等待中」
  if (uploadId) fd.append('uploadId', uploadId);

  const url = joinUrl(getApiBaseUrl(), api.webPages.reupload(encodeURIComponent(id)));
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: fd, signal });
  } catch (e) {
    // 用户自己按的中止不是故障，给它独立的 code，让调用方能不弹「上传失败」
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { success: false, data: null as never, error: { code: 'ABORTED', message: '已中止' } };
    }
    throw e;
  }
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
    /** 每个站点的独立访客数（siteId → 人数，后端按 userId / IP 去重）。
     *  浏览数是累计次数、访客是去重人数，两个数不能互相冒充。没有访问记录的站点不出现在表里。 */
    visitors?: Record<string, number>;
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

/** 读取站点入口 HTML 原文（服务端代理，绕开 CORS）。供知识库「从网页托管导入」使用。 */
export async function getSiteContent(id: string): Promise<ApiResponse<{ siteId: string; title: string; contentType: string; html: string }>> {
  return apiRequest(api.webPages.content(encodeURIComponent(id)), { method: 'GET' });
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
  /**
   * 本条分享链接自选的开场问题。三态，**不要**在调用前把 undefined 兜成 []：
   *   不传   = 沿用站点题库
   *   []     = 这条链接不显示开场问题
   *   非空   = 只显示这几条
   */
  askSuggestedQuestions?: string[];
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

/**
 * @param includeRevoked 一并取回已撤销的链接（分享管理面板的「已撤销」一层要用）。
 *   默认 false —— 后端也默认排除，两边口径一致。
 */
/**
 * 我建的分享链接。
 *
 * `siteId` 非空时只返回指向该站点的。判断「这个站点有没有活着的链接」必须带上它——
 * 不带时服务端按时间只返回最近 100 条，该站点的链接落在窗口外就会被当成「没有」，
 * 调用方据此再建一条，于是每次都多出一条重复链接、卡片上还显示未分享。
 */
export async function listShares(
  includeRevoked = false,
  siteId?: string,
): Promise<ApiResponse<{ items: ShareLinkItem[] }>> {
  const q = new URLSearchParams();
  if (includeRevoked) q.set('includeRevoked', 'true');
  if (siteId) q.set('siteId', siteId);
  const qs = q.toString();
  return apiRequest(`${api.webPages.shares()}${qs ? `?${qs}` : ''}`, { method: 'GET' });
}

/**
 * 服务端解包进度。上传是一次同步 POST，前端在等那个响应，这条是旁路查询。
 * uploadId 由调用方生成、随上传表单一起发过去。
 * pending=true 表示还没开始记录（或已过 TTL），不是错误。
 */
export interface UploadUnpackProgress {
  pending?: boolean;
  doneFiles?: number;
  totalFiles?: number;
  entryFile?: string | null;
  currentPath?: string | null;
  currentSize?: number;
  finished?: boolean;
}

export async function getUploadProgress(uploadId: string): Promise<ApiResponse<UploadUnpackProgress>> {
  return apiRequest(api.webPages.uploadProgress(encodeURIComponent(uploadId)), { method: 'GET' });
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

/**
 * 就地改一条分享链接的设置（分享下拉面板的「谁能打开 / 有效期」）。
 *
 * 与 renewShare 分开：续期是在现有到期日上**累加**，这里是从现在起**重设**。
 * 面板上选「7 天」，用户要的是「还剩 7 天」。
 *
 * 两个字段都可选（不传 = 不动那一项）。expiresInDays 传 0 是「改成永久」，
 * 与不传是两回事，别在调用前把 undefined 兜成 0。
 *
 * 返回的是**改完之后的实际值**，直接拿它更新界面；别用请求参数乐观更新——
 * 服务端会规范化（白名单、天数夹取），拿参数更新等于显示一个没存进去的值。
 */
export async function updateShareSettings(
  shareId: string,
  patch: { visibility?: 'owner-only' | 'logged-in' | 'public'; expiresInDays?: number },
): Promise<ApiResponse<{ visibility: string; expiresAt?: string | null }>> {
  return apiRequest(`/api/web-pages/shares/${encodeURIComponent(shareId)}`, {
    method: 'PATCH',
    body: patch,
  });
}

/**
 * 撤销分享链接（不可逆）。
 * @param reason 可选，「为什么撤」。几周后回头看列表时这句话是唯一的线索。
 */
export async function revokeShare(shareId: string, reason?: string): Promise<ApiResponse<{ revoked: boolean }>> {
  const q = reason?.trim() ? `?reason=${encodeURIComponent(reason.trim())}` : '';
  return apiRequest(`${api.webPages.revokeShare(encodeURIComponent(shareId))}${q}`, { method: 'DELETE' });
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
  /** 包装资产类型（pdf / video / markdown …），普通 HTML 站为空。包装站没有可读正文 */
  wrappedAssetType?: string | null;
}

export interface ShareViewData {
  title: string;
  description?: string;
  shareType: string;
  createdAt: string;
  createdBy?: string;
  createdByName?: string;
  sites: SharedSiteInfo[];
  /**
   * 「向我提问」呈现配置。开关关闭时后端返回 null，前端据此不渲染入口。
   * openingQuestions 已由后端把「分享自选 / 站点题库」两层三态取舍完毕，
   * 前端**不要**再自己合并一遍（那正是判据分裂的起点）。
   */
  ask?: ShareAskInfo | null;
}

export interface ShareAskInfo {
  siteId: string;
  enabled: boolean;
  allowAnonymous: boolean;
  welcome?: string | null;
  openingQuestions: string[];
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

/**
 * 经分享链接读取站点入口 HTML 原文（无需登录）。走服务端同源代理，**不要**改回浏览器直接
 * fetch(site.siteUrl)：托管内容在独立域名且不返回 Access-Control-Allow-Origin，浏览器侧 fetch
 * 必被 CORS 拦掉，srcDoc 预览会永远拿不到内容而静默退化成「Chrome 里只绘制空白」的直链 iframe。
 * 守卫见 ShareViewPage.preview.test.ts。
 */
export async function getShareSiteContent(
  token: string,
  siteId?: string,
  password?: string,
): Promise<ApiResponse<{ siteId: string; title: string; contentType: string; siteUrl: string; html: string }>> {
  const params = new URLSearchParams();
  if (siteId) params.set('siteId', siteId);
  if (password) params.set('password', password);
  const q = params.toString() ? `?${params.toString()}` : '';
  const url = joinUrl(getApiBaseUrl(), `/api/web-pages/shares/view/${encodeURIComponent(token)}/content${q}`);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const authToken = useAuthStore.getState().token;
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  try {
    const res = await fetch(url, { headers });
    return (await res.json()) as ApiResponse<{ siteId: string; title: string; contentType: string; siteUrl: string; html: string }>;
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

// ─── 向我提问 ───

/** 站点提问配置（owner 视角） */
export interface SiteAskConfig {
  siteId: string;
  enabled: boolean;
  welcome?: string | null;
  /** 站点级题库；分享时可从中挑几条 */
  suggestedQuestions: string[];
  allowAnonymous: boolean;
  /** 0 = 用系统默认 */
  dailyLimit: number;
  updatedAt?: string | null;
  /**
   * 这批题是谁写的：'auto' = 系统读正文生成，'manual' = owner 自己动过手。
   * 自动填的值必须让用户看得出来、可改、说得出依据（minimal-user-input 第 3 条）。
   */
  questionsSource?: 'auto' | 'manual';
  /** 上一次自动生成对应的内容版本时间；没生成过则为空 */
  questionsGeneratedAt?: string | null;
  /** 题库最多存几条（服务端 SSOT，前端不自己定）。这是**存储**上限，不是展示上限 */
  maxQuestions: number;
  /** 一条分享面板最多显示几条（题库比它大，分享时挑子集） */
  maxDisplay?: number;
  /** 这个站点形态支不支持提问（视频包装站没有正文，开了每个访客都会吃 422） */
  supported?: boolean;
  /** 不支持的原因，直接展示给 owner */
  unsupportedReason?: string | null;
  maxQuestionLength: number;
}

/** 读站点的提问配置 */
export async function getSiteAskConfig(siteId: string): Promise<ApiResponse<SiteAskConfig>> {
  return apiRequest(api.webPages.askConfig(siteId));
}

/** 写站点的提问配置（仅 owner / editor） */
export async function updateSiteAskConfig(
  siteId: string,
  config: {
    enabled: boolean;
    welcome?: string | null;
    /**
     * 只在用户**真的编辑过题库**时才传。省略（undefined）= 「这次不动题库」。
     *
     * 为什么不能每次都带上：打开抽屉会顺手排一次后台生成，而抽屉里那份题是打开那一刻
     * 读到的旧值。只改了别的开关就保存时把旧值一起送上去，会盖掉这期间生成好的题，
     * 还会被后端判成「owner 手写过」从此钉成 manual，自动生成再也补不回来。
     */
    suggestedQuestions?: string[];
    allowAnonymous: boolean;
    dailyLimit: number;
  },
): Promise<ApiResponse<SiteAskConfig>> {
  return apiRequest(api.webPages.askConfig(siteId), { method: 'PUT', body: config });
}

/** 重新按正文生成开场问题的结果 */
export interface AskQuestionRegenResult {
  siteId: string;
  /** 这次是不是真的写出了新题库 */
  generated: boolean;
  /**
   * 这次的结局。四种「没生成出来」的下一步不同，界面上不要压成同一句「失败了」：
   * NoContent 重试没用、ModelUnavailable 值得过会儿再点、ModelUnusable 该自己加一条。
   */
  outcome?: 'Generated' | 'NoContent' | 'ModelUnusable' | 'ModelUnavailable' | 'Skipped' | 'Busy';
  suggestedQuestions: string[];
  questionsSource?: 'auto' | 'manual';
  /** generated=false 时的原话，直接展示，不要自己编一句 */
  message?: string | null;
}

/**
 * 重新按正文生成开场问题（仅 owner / editor）。
 *
 * 同步等：这是 owner 明确点的按钮，转个圈几秒钟，比让他保存完再刷新猜有没有到位清楚。
 * 会覆盖他之前手写的那份——按钮文案必须把这件事说清。
 */
export async function regenerateSiteAskQuestions(
  siteId: string,
): Promise<ApiResponse<AskQuestionRegenResult>> {
  return apiRequest(api.webPages.askRegenerateQuestions(siteId), { method: 'POST' });
}
