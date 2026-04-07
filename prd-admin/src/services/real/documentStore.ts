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

export const listDocumentEntriesReal: ListDocumentEntriesContract = async (storeId, page = 1, pageSize = 20, keyword) => {
  let url = `${api.documentStore.entries.list(storeId)}?page=${page}&pageSize=${pageSize}`;
  if (keyword) url += `&keyword=${encodeURIComponent(keyword)}`;
  return await apiRequest(url, { method: 'GET' });
};

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

/** 设置/清除主文档 */
export async function setPrimaryEntry(storeId: string, entryId: string | null) {
  return await apiRequest<{ primaryEntryId: string | null }>(
    api.documentStore.stores.primaryEntry(storeId),
    { method: 'PUT', body: { entryId } },
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
