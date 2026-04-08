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
export async function listDocumentStoresWithPreview(page = 1, pageSize = 20) {
  return await apiRequest<{ items: import('@/services/contracts/documentStore').DocumentStoreWithPreview[]; total: number; page: number; pageSize: number }>(
    `${api.documentStore.stores.listWithPreview()}?page=${page}&pageSize=${pageSize}`,
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
export async function updateDocumentContent(entryId: string, content: string) {
  return await apiRequest<{ updated: boolean }>(
    api.documentStore.entries.content(entryId),
    { method: 'PUT', body: { content } },
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

/** 添加 GitHub 目录订阅 */
export async function addGitHubSubscription(storeId: string, input: {
  githubUrl: string;
  title?: string;
  syncIntervalMinutes?: number;
  tags?: string[];
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
