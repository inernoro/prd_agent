import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type {
  CreateDocumentStoreContract,
  ListDocumentStoresContract,
  GetDocumentStoreContract,
  UpdateDocumentStoreContract,
  DeleteDocumentStoreContract,
  AddDocumentEntryContract,
  ListDocumentEntriesContract,
  UpdateDocumentEntryContract,
  DeleteDocumentEntryContract,
} from '@/services/contracts/documentStore';

export const createDocumentStoreReal: CreateDocumentStoreContract = async (input) => {
  return await apiRequest(api.documentStore.stores.create(), {
    method: 'POST',
    body: input,
  });
};

export const listDocumentStoresReal: ListDocumentStoresContract = async (page = 1, pageSize = 20) => {
  return await apiRequest(`${api.documentStore.stores.list()}?page=${page}&pageSize=${pageSize}`, {
    method: 'GET',
  });
};

export const getDocumentStoreReal: GetDocumentStoreContract = async (storeId) => {
  return await apiRequest(api.documentStore.stores.detail(storeId), {
    method: 'GET',
  });
};

export const updateDocumentStoreReal: UpdateDocumentStoreContract = async (storeId, input) => {
  return await apiRequest(api.documentStore.stores.detail(storeId), {
    method: 'PUT',
    body: input,
  });
};

export const deleteDocumentStoreReal: DeleteDocumentStoreContract = async (storeId) => {
  return await apiRequest(api.documentStore.stores.detail(storeId), {
    method: 'DELETE',
  });
};

export const addDocumentEntryReal: AddDocumentEntryContract = async (storeId, input) => {
  return await apiRequest(api.documentStore.entries.add(storeId), {
    method: 'POST',
    body: input,
  });
};

export const listDocumentEntriesReal: ListDocumentEntriesContract = async (storeId, page = 1, pageSize = 200, keyword) => {
  let url = `${api.documentStore.entries.list(storeId)}?page=${page}&pageSize=${pageSize}&all=true`;
  if (keyword) url += `&keyword=${encodeURIComponent(keyword)}`;
  return await apiRequest(url, { method: 'GET' });
};

/** 获取单条文档条目详情 */
export async function getDocumentEntry(entryId: string) {
  return await apiRequest<import('@/services/contracts/documentStore').DocumentEntry>(
    api.documentStore.entries.detail(entryId), { method: 'GET' });
}

/** 知识列表查询参数（产品知识库列表视图：分页 + 多维筛选） */
export interface KnowledgeEntriesQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  searchContent?: boolean;
  /** 分类过滤；'__none__' = 未分类 */
  category?: string;
  tag?: string;
  versionId?: string;
  sourceType?: string;
}

/** 分页 + 筛选列出知识条目（知识库列表视图专用，all=true 跨文件夹平铺、不含文件夹） */
export async function listKnowledgeEntriesPaged(storeId: string, q: KnowledgeEntriesQuery = {}) {
  const params = new URLSearchParams({ page: String(q.page ?? 1), pageSize: String(q.pageSize ?? 20), all: 'true', excludeFolders: 'true' });
  if (q.keyword) params.set('keyword', q.keyword);
  if (q.searchContent) params.set('searchContent', 'true');
  if (q.category) params.set('category', q.category);
  if (q.tag) params.set('tag', q.tag);
  if (q.versionId) params.set('versionId', q.versionId);
  if (q.sourceType) params.set('sourceType', q.sourceType);
  return await apiRequest<{
    items: import('@/services/contracts/documentStore').DocumentEntry[];
    total: number;
    page: number;
    pageSize: number;
  }>(`${api.documentStore.entries.list(storeId)}?${params.toString()}`, { method: 'GET' });
}

/** 搜索文档条目（支持内容搜索） */
export async function searchDocumentEntries(storeId: string, keyword: string, searchContent: boolean) {
  let url = `${api.documentStore.entries.list(storeId)}?page=1&pageSize=200&all=true&keyword=${encodeURIComponent(keyword)}`;
  if (searchContent) url += '&searchContent=true';
  return await apiRequest<{ items: import('@/services/contracts/documentStore').DocumentEntry[]; total: number }>(url, { method: 'GET' });
}

export const updateDocumentEntryReal: UpdateDocumentEntryContract = async (entryId, input) => {
  return await apiRequest(api.documentStore.entries.update(entryId), {
    method: 'PUT',
    body: input,
  });
};

export const deleteDocumentEntryReal: DeleteDocumentEntryContract = async (entryId) => {
  return await apiRequest(api.documentStore.entries.delete(entryId), {
    method: 'DELETE',
  });
};

/**
 * 上传文件到文档空间（multipart/form-data）。
 * ⚠️ 不能用 apiRequest（会 JSON.stringify body），直接 fetch。
 */
export async function uploadDocumentFile(storeId: string, file: File): Promise<import('@/types/api').ApiResponse<{
  entry: import('@/services/contracts/documentStore').DocumentEntry;
  attachmentId: string;
  documentId?: string;
  fileUrl: string;
}>> {
  const { useAuthStore } = await import('@/stores/authStore');
  const token = useAuthStore.getState().token;
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(api.documentStore.entries.upload(storeId), {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { success: false, data: null as never, error: { code: 'UPLOAD_FAILED', message: text || `HTTP ${res.status}` } };
  }
  return await res.json();
}

/**
 * 替换已有条目的文件（原地替换，保留 Id / 标签 / 主文档 / 置顶）。
 * ⚠️ 不能用 apiRequest（会 JSON.stringify body），直接 fetch。
 */
export async function replaceDocumentFile(entryId: string, file: File): Promise<import('@/types/api').ApiResponse<{
  entry: import('@/services/contracts/documentStore').DocumentEntry;
  attachmentId: string;
  documentId?: string;
  fileUrl: string;
}>> {
  const { useAuthStore } = await import('@/stores/authStore');
  const token = useAuthStore.getState().token;
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(api.documentStore.entries.replace(entryId), {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { success: false, data: null as never, error: { code: 'REPLACE_FAILED', message: text || `HTTP ${res.status}` } };
  }
  return await res.json();
}

/** 获取文档内容 */
export async function getDocumentContent(entryId: string) {
  return await apiRequest<{
    entryId: string;
    title: string;
    content: string | null;
    contentType: string;
    fileUrl: string | null;
    hasContent: boolean;
  }>(api.documentStore.entries.content(entryId), { method: 'GET' });
}

/** 添加订阅源 */
export async function addSubscription(storeId: string, input: {
  title: string;
  description?: string;
  sourceUrl: string;
  syncIntervalMinutes?: number;
  tags?: string[];
}) {
  return await apiRequest<import('@/services/contracts/documentStore').DocumentEntry>(
    api.documentStore.entries.subscribe(storeId),
    { method: 'POST', body: input },
  );
}

/** 创建文件夹 */
export async function createFolder(storeId: string, name: string, parentId?: string) {
  return await apiRequest<import('@/services/contracts/documentStore').DocumentEntry>(
    api.documentStore.entries.folders(storeId),
    { method: 'POST', body: { name, parentId: parentId || null } },
  );
}

/** 设置/清除主文档 */
export async function setPrimaryEntry(storeId: string, entryId: string | null) {
  return await apiRequest<{ primaryEntryId: string | null }>(
    api.documentStore.stores.primaryEntry(storeId),
    { method: 'PUT', body: { entryId } },
  );
}

/** 置顶/取消置顶文档条目 */
export async function togglePinnedEntry(storeId: string, entryId: string, pin: boolean) {
  return await apiRequest<{ pinnedEntryIds: string[] }>(
    api.documentStore.stores.pinnedEntries(storeId),
    { method: 'PUT', body: { entryId, pin } },
  );
}

/** 获取文档空间列表（含最近文档预览） */
export async function listDocumentStoresWithPreview(
  page = 1,
  pageSize = 20,
  opts?: { scope?: 'mine' | 'team'; teamId?: string | null },
) {
  const sp = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (opts?.scope === 'team') {
    sp.set('scope', 'team');
    // teamId 缺省 = 跨团队聚合视图（我加入的所有团队的共享空间）
    if (opts.teamId) sp.set('teamId', opts.teamId);
  }
  return await apiRequest<{ items: import('@/services/contracts/documentStore').DocumentStoreWithPreview[]; total: number; page: number; pageSize: number }>(
    `${api.documentStore.stores.listWithPreview()}?${sp.toString()}`,
    { method: 'GET' },
  );
}

/** 移动文档条目到指定文件夹 */
export async function moveDocumentEntry(entryId: string, parentId: string | null) {
  return await apiRequest<{ moved: boolean }>(
    api.documentStore.entries.move(entryId),
    { method: 'PUT', body: { parentId } },
  );
}

/** 更新文档内容（在线编辑） */
export async function updateDocumentContent(entryId: string, content: string, contentType?: string) {
  return await apiRequest<{ updated: boolean; updatedAt?: string; updatedBy?: string; updatedByName?: string }>(
    api.documentStore.entries.content(entryId),
    { method: 'PUT', body: contentType ? { content, contentType } : { content } },
  );
}

/** 设置文件夹内的主文档 */
export async function setFolderPrimaryChild(folderId: string, entryId: string | null) {
  return await apiRequest<{ primaryChildId: string | null }>(
    api.documentStore.entries.primaryChild(folderId),
    { method: 'PUT', body: { entryId } },
  );
}

/** 回填文档内容索引（供内容搜索使用） */
export async function rebuildContentIndex(storeId: string) {
  return await apiRequest<{ total: number; updated: number }>(
    api.documentStore.stores.rebuildContentIndex(storeId),
    { method: 'POST' },
  );
}

/** 获取所有公开知识库（首页/library 页用） */
export async function listPublicDocumentStores(page = 1, pageSize = 24, sort: 'hot' | 'new' | 'popular' | 'viewed' = 'hot') {
  return await apiRequest<{ items: import('@/services/contracts/documentStore').PublicDocumentStore[]; total: number; page: number; pageSize: number }>(
    `${api.documentStore.stores.publicList()}?page=${page}&pageSize=${pageSize}&sort=${sort}`,
    { method: 'GET' },
  );
}

/** 获取公开知识库详情 */
export async function getPublicDocumentStore(storeId: string) {
  return await apiRequest<import('@/services/contracts/documentStore').PublicStoreDetail>(
    api.documentStore.stores.publicDetail(storeId),
    { method: 'GET' },
  );
}

/** 获取公开知识库内文档列表 */
export async function listPublicStoreEntries(storeId: string) {
  return await apiRequest<{ items: import('@/services/contracts/documentStore').DocumentEntry[]; total: number }>(
    api.documentStore.stores.publicEntries(storeId),
    { method: 'GET' },
  );
}

/** 获取公开文档内容 */
export async function getPublicEntryContent(entryId: string) {
  return await apiRequest<{
    entryId: string;
    title: string;
    content: string | null;
    contentType: string;
    fileUrl: string | null;
    hasContent: boolean;
  }>(api.documentStore.stores.publicEntryContent(entryId), { method: 'GET' });
}

/** 点赞知识库 */
export async function likeDocumentStore(storeId: string) {
  return await apiRequest<{ liked: boolean; likeCount: number }>(
    api.documentStore.stores.like(storeId),
    { method: 'POST' },
  );
}

/** 取消点赞 */
export async function unlikeDocumentStore(storeId: string) {
  return await apiRequest<{ liked: boolean; likeCount: number }>(
    api.documentStore.stores.like(storeId),
    { method: 'DELETE' },
  );
}

/** 收藏知识库 */
export async function favoriteDocumentStore(storeId: string) {
  return await apiRequest<{ favorited: boolean; favoriteCount: number }>(
    api.documentStore.stores.favorite(storeId),
    { method: 'POST' },
  );
}

/** 取消收藏 */
export async function unfavoriteDocumentStore(storeId: string) {
  return await apiRequest<{ favorited: boolean; favoriteCount: number }>(
    api.documentStore.stores.favorite(storeId),
    { method: 'DELETE' },
  );
}

/** 列出我收藏的知识库（含最近文档预览 + 店主信息） */
export async function listMyFavoriteDocumentStores() {
  return await apiRequest<{ items: import('@/services/contracts/documentStore').InteractionStoreCard[] }>(
    api.documentStore.stores.myFavorites(),
    { method: 'GET' },
  );
}

/** 列出我点赞的知识库（含最近文档预览 + 店主信息） */
export async function listMyLikedDocumentStores() {
  return await apiRequest<{ items: import('@/services/contracts/documentStore').InteractionStoreCard[] }>(
    api.documentStore.stores.myLikes(),
    { method: 'GET' },
  );
}

/** 创建分享链接（entryId 非空 = 单篇文档分享） */
export async function createShareLink(storeId: string, input: { title?: string; description?: string; expiresInDays?: number; entryId?: string }) {
  return await apiRequest<import('@/services/contracts/documentStore').DocumentStoreShareLink>(
    api.documentStore.stores.shareLinks(storeId),
    { method: 'POST', body: { ...input, expiresInDays: input.expiresInDays ?? 0 } },
  );
}

/** 解析公开分享视图（匿名可访问，必须 auth:false 否则未登录访客被前端拦成"未登录"） */
export async function getDocStoreShareView(token: string) {
  return await apiRequest<import('@/services/contracts/documentStore').DocStoreShareView>(
    api.documentStore.stores.publicShare(token),
    { method: 'GET', auth: false },
  );
}

/** 列出分享范围内的文档（匿名；单篇分享只返回该篇） */
export async function listDocStoreShareEntries(token: string) {
  return await apiRequest<{ items: import('@/services/contracts/documentStore').DocumentEntry[]; total: number }>(
    api.documentStore.stores.publicShareEntries(token),
    { method: 'GET', auth: false },
  );
}

/** 读取分享范围内某篇文档正文（匿名） */
export async function getDocStoreShareEntryContent(token: string, entryId: string) {
  return await apiRequest<{
    entryId: string;
    title: string;
    content: string | null;
    contentType: string;
    fileUrl: string | null;
    hasContent: boolean;
  }>(api.documentStore.stores.publicShareEntryContent(token, entryId), { method: 'GET', auth: false });
}

/** 列出分享链接 */
export async function listShareLinks(storeId: string) {
  return await apiRequest<{ items: import('@/services/contracts/documentStore').DocumentStoreShareLink[] }>(
    api.documentStore.stores.shareLinks(storeId),
    { method: 'GET' },
  );
}

/** 撤销分享链接 */
export async function revokeShareLink(linkId: string) {
  return await apiRequest<{ revoked: boolean }>(
    api.documentStore.stores.shareLinkDetail(linkId),
    { method: 'DELETE' },
  );
}

/** 添加 GitHub 目录订阅 */
export async function addGitHubSubscription(storeId: string, input: {
  githubUrl: string;
  title?: string;
  syncIntervalMinutes?: number;
  tags?: string[];
  includeGlob?: string;
}) {
  return await apiRequest<import('@/services/contracts/documentStore').DocumentEntry>(
    api.documentStore.entries.subscribeGithub(storeId),
    { method: 'POST', body: input },
  );
}

/** 手动触发同步 */
export async function triggerSync(entryId: string) {
  return await apiRequest<{ triggered: boolean }>(
    api.documentStore.entries.sync(entryId),
    { method: 'POST' },
  );
}

/** 获取订阅条目的最近同步日志（含当前订阅状态 + 下次同步时间） */
export async function listSubscriptionDetail(entryId: string, limit = 20) {
  return await apiRequest<import('@/services/contracts/documentStore').SubscriptionDetail>(
    `${api.documentStore.entries.syncLogs(entryId)}?limit=${limit}`,
    { method: 'GET' },
  );
}

/** 更新订阅可变状态：暂停/恢复 + 同步间隔 */
export async function updateSubscription(entryId: string, input: {
  isPaused?: boolean;
  syncIntervalMinutes?: number;
}) {
  return await apiRequest<import('@/services/contracts/documentStore').DocumentEntry>(
    api.documentStore.entries.subscriptionUpdate(entryId),
    { method: 'PATCH', body: input },
  );
}

// ── 知识库 Agent：字幕生成 + 文档再加工 ──

/** 发起字幕生成任务 */
export async function generateSubtitle(entryId: string) {
  return await apiRequest<{ runId: string; status: string; reused: boolean }>(
    api.documentStore.entries.generateSubtitle(entryId),
    { method: 'POST' },
  );
}

/** 获取再加工可用模板列表 */
export async function listReprocessTemplates() {
  return await apiRequest<{ items: import('@/services/contracts/documentStore').ReprocessTemplate[] }>(
    api.documentStore.stores.reprocessTemplates(),
    { method: 'GET' },
  );
}

/** 列出当前用户可调用的「再加工·智能体」（system 内置 + 自己创建的 personal） */
export async function listReprocessAgents() {
  return await apiRequest<{ items: import('@/services/contracts/documentStore').ReprocessAgent[] }>(
    api.documentStore.stores.reprocessAgents(),
    { method: 'GET' },
  );
}

/** 创建一个个人再加工智能体 */
export async function createReprocessAgent(input: {
  label: string;
  description?: string;
  systemPrompt: string;
}) {
  return await apiRequest<import('@/services/contracts/documentStore').ReprocessAgent>(
    api.documentStore.stores.reprocessAgents(),
    { method: 'POST', body: input },
  );
}

/** 删除一个自己的个人再加工智能体 */
export async function deleteReprocessAgent(id: string) {
  return await apiRequest<{ deleted: boolean }>(
    api.documentStore.stores.reprocessAgentDetail(id),
    { method: 'DELETE' },
  );
}

/** 发起文档再加工任务（旧接口，单轮兼容） */
export async function startReprocess(entryId: string, input: {
  templateKey: string;
  customPrompt?: string;
}) {
  return await apiRequest<{ runId: string; status: string; messageSeq?: number }>(
    api.documentStore.entries.reprocess(entryId),
    { method: 'POST', body: input },
  );
}

// 已删除（Bugbot Low 反馈）：
//   - sendReprocessChat：对应后端 /reprocess/chat 多轮端点，新架构走 streamDirectChat
//   - applyReprocessMessage：对应后端 /agent-runs/{id}/apply，新架构走 applyReprocessContent
// 后端端点保留向后兼容，但前端不再需要 wrapper。如未来其他模块要复用可重新导出。

/** 获取某文档的活跃再加工会话（含完整 messages）—— 用于重开抽屉时恢复历史对话 */
export async function getActiveReprocessRun(entryId: string) {
  return await apiRequest<import('@/services/contracts/documentStore').DocumentStoreAgentRun | null>(
    api.documentStore.entries.reprocessActiveRun(entryId),
    { method: 'GET' },
  );
}

// ── 智能体抽屉对话的后端持久化（关浏览器标签页/换设备都不丢；详见 DocumentStoreConversation.cs） ──

/** 读取某文档的智能体对话（含 messages / 暂存图 / 选中智能体），用于重开抽屉恢复 */
export async function getReprocessConversation(entryId: string) {
  return await apiRequest<import('@/services/contracts/documentStore').DocumentStoreConversation | null>(
    api.documentStore.entries.reprocessConversation(entryId),
    { method: 'GET' },
  );
}

/** 覆盖式保存某文档的智能体对话（去抖调用）。三个字段都是前端拥有形状的 JSON 字符串 */
export async function saveReprocessConversation(entryId: string, input: {
  messagesJson: string;
  pendingImagesJson: string;
  activeRefJson?: string | null;
}) {
  return await apiRequest<{ ok: boolean }>(
    api.documentStore.entries.reprocessConversation(entryId),
    { method: 'PUT', body: input },
  );
}

/** 清空某文档的智能体对话（"开启全新对话"） */
export async function clearReprocessConversation(entryId: string) {
  return await apiRequest<{ ok: boolean }>(
    api.documentStore.entries.reprocessConversation(entryId),
    { method: 'DELETE' },
  );
}

/** 写回任意内容到文档（不依赖 Run；用于通过 /ai-toolbox/direct-chat 直调拿回的内容） */
export async function applyReprocessContent(entryId: string, input: {
  mode: 'replace' | 'append' | 'new';
  content: string;
  title?: string;
  /** Phase 2：mode=new 时的目标目录（文件夹条目 id）；为空落在源文档同目录 */
  parentId?: string;
}) {
  return await apiRequest<{ mode: string; outputEntryId?: string; updatedEntryId?: string }>(
    api.documentStore.entries.reprocessApplyContent(entryId),
    { method: 'POST', body: input },
  );
}

/** Phase 2：知识库目录（文件夹）列表，供「另存到指定目录」选择器用 */
export interface DocStoreFolder {
  id: string;
  title: string;
  parentId?: string | null;
}
export async function getDocumentStoreFolders(storeId: string) {
  return await apiRequest<{ folders: DocStoreFolder[] }>(
    api.documentStore.entries.folders(storeId),
    { method: 'GET' },
  );
}

/** 获取 Agent Run 当前状态 */
export async function getAgentRun(runId: string) {
  return await apiRequest<import('@/services/contracts/documentStore').DocumentStoreAgentRun>(
    api.documentStore.stores.agentRun(runId),
    { method: 'GET' },
  );
}

/** 查询某 entry 最近一次 Agent Run（按 kind 过滤） */
export async function getLatestAgentRun(entryId: string, kind: 'subtitle' | 'reprocess') {
  return await apiRequest<import('@/services/contracts/documentStore').DocumentStoreAgentRun | null>(
    `${api.documentStore.entries.latestAgentRun(entryId)}?kind=${kind}`,
    { method: 'GET' },
  );
}

// ── 批次 C：浏览事件埋点 + 访客统计 ──

/** 记录一次浏览事件（进入文档时调用，返回 viewEventId 供后续补时长） */
export async function logEntryView(entryId: string, anonSessionToken?: string) {
  return await apiRequest<{ viewEventId: string }>(
    api.documentStore.entries.logView(entryId),
    { method: 'POST', body: { anonSessionToken: anonSessionToken ?? null } },
  );
}

/** 补写浏览时长（离开/切换文档时调用；推荐用 navigator.sendBeacon 走一次） */
export async function leaveEntryView(viewEventId: string, durationMs: number) {
  return await apiRequest<object>(
    api.documentStore.entries.leaveView(viewEventId),
    { method: 'POST', body: { durationMs } },
  );
}

/** 获取知识库访客统计（仅 owner） */
export async function listStoreViewEvents(storeId: string, limit = 50) {
  return await apiRequest<{
    stats: import('@/services/contracts/documentStore').DocumentStoreViewStats;
    events: import('@/services/contracts/documentStore').DocumentStoreViewEvent[];
  }>(
    `${api.documentStore.entries.storeViewEvents(storeId)}?limit=${limit}`,
    { method: 'GET' },
  );
}

/** 获取知识库访客聚合报表（仅 owner）。days 取值范围 1-365，tz 形如 "+08:00" */
export async function getStoreAnalytics(storeId: string, days = 30, tz?: string) {
  const qs = new URLSearchParams({ days: String(days) });
  if (tz) qs.set('tz', tz);
  return await apiRequest<import('@/services/contracts/documentStore').DocumentStoreAnalytics>(
    `${api.documentStore.entries.storeAnalytics(storeId)}?${qs.toString()}`,
    { method: 'GET' },
  );
}

/** 账号级访客总计（我名下所有知识库聚合，仅 owner 自己） */
export async function getStoresAnalyticsSummary() {
  return await apiRequest<import('@/services/contracts/documentStore').DocumentStoreAccountSummary>(
    api.documentStore.entries.storesAnalyticsSummary(),
    { method: 'GET' },
  );
}

/** 账号级访客聚合报表（我名下所有知识库，与单库报表同结构） */
export async function getAllStoresAnalytics(days = 30, tz?: string) {
  const qs = new URLSearchParams({ days: String(days) });
  if (tz) qs.set('tz', tz);
  return await apiRequest<import('@/services/contracts/documentStore').DocumentStoreAnalytics>(
    `${api.documentStore.entries.storesAnalyticsAll()}?${qs.toString()}`,
    { method: 'GET' },
  );
}

/** 账号级访客明细（我名下所有知识库最近访问，与单库 view-events 同结构） */
export async function listAllStoresViewEvents(limit = 50) {
  return await apiRequest<{
    stats: import('@/services/contracts/documentStore').DocumentStoreViewStats;
    events: import('@/services/contracts/documentStore').DocumentStoreViewEvent[];
  }>(
    `${api.documentStore.entries.storesViewEventsAll()}?limit=${limit}`,
    { method: 'GET' },
  );
}

// ── 批次 D：划词评论 ──

/** 创建划词评论 */
export async function createInlineComment(entryId: string, input: {
  selectedText: string;
  contextBefore?: string;
  contextAfter?: string;
  startOffset: number;
  endOffset: number;
  content: string;
}) {
  return await apiRequest<import('@/services/contracts/documentStore').DocumentInlineComment>(
    api.documentStore.entries.inlineComments(entryId),
    { method: 'POST', body: input },
  );
}

/**
 * 列出文档的划词评论。
 * owner / 公开库可直接读；私有库分享视图须传 shareToken（属于该 store + 未撤销 + 未过期）
 * 才能读到评论气泡（PR #685 Codex P1：避免知 entryId 即可枚举私有库评论）。
 */
export async function listInlineComments(entryId: string, shareToken?: string) {
  const base = api.documentStore.entries.inlineComments(entryId);
  const url = shareToken ? `${base}?shareToken=${encodeURIComponent(shareToken)}` : base;
  return await apiRequest<{
    items: import('@/services/contracts/documentStore').DocumentInlineComment[];
    canCreate: boolean;
    /** 当前查看者是否为库主（库主可删任意评论） */
    isOwner?: boolean;
    /** 当前查看者 userId（用于「作者可删自己评论」逐条判定）；匿名为 null */
    viewerUserId?: string | null;
  }>(
    url,
    { method: 'GET' },
  );
}

/** 删除划词评论（仅作者或 store owner） */
export async function deleteInlineComment(commentId: string) {
  return await apiRequest<{ deleted: boolean }>(
    api.documentStore.entries.inlineCommentDetail(commentId),
    { method: 'DELETE' },
  );
}
