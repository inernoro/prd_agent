import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';

/** 同步方向 */
export type SyncDirection = 'push' | 'pull' | 'both';
/** 配对类型 */
export type SyncLinkType = 'local' | 'remote';
/** 配对状态 */
export type SyncLinkStatus = 'never' | 'synced' | 'pending' | 'error';

export interface DocumentSyncLink {
  id: string;
  localStoreId: string;
  localStoreName?: string | null;
  linkType: SyncLinkType;
  direction: SyncDirection;
  remoteStoreId: string;
  remoteStoreName?: string | null;
  remoteBaseUrl?: string | null;
  lastSyncedAt?: string | null;
  lastResult?: string | null;
  status: SyncLinkStatus;
}

/** 列出当前用户的全部同步配对（跨所有库，用于「跨环境同步」页签） */
export async function listAllSyncLinks() {
  return await apiRequest<{ items: DocumentSyncLink[] }>(api.documentStore.sync.listAll(), { method: 'GET' });
}

/** 列出某个库的同步配对 + 实时状态 */
export async function listStoreSyncLinks(storeId: string) {
  return await apiRequest<{ items: DocumentSyncLink[]; hasSyncToken: boolean }>(
    api.documentStore.sync.listForStore(storeId),
    { method: 'GET' },
  );
}

/** 创建本地配对（同环境两个库） */
export async function createLocalSyncLink(storeId: string, targetStoreId: string, direction: SyncDirection) {
  return await apiRequest<DocumentSyncLink>(api.documentStore.sync.createLocal(storeId), {
    method: 'POST',
    body: { targetStoreId, direction },
  });
}

/** 生成跨环境连接链接（baseUrl 可选，缺省用当前环境地址） */
export async function generateSyncLink(storeId: string, baseUrl?: string) {
  return await apiRequest<{ link: string; baseUrl: string; storeName: string }>(
    api.documentStore.sync.generateLink(storeId),
    { method: 'POST', body: { baseUrl } },
  );
}

/** 粘贴对方链接以建立跨环境配对 */
export async function connectSyncLink(storeId: string, link: string, direction: SyncDirection) {
  return await apiRequest<DocumentSyncLink>(api.documentStore.sync.connect(storeId), {
    method: 'POST',
    body: { link, direction },
  });
}

/** 触发一次同步 */
export async function runSyncLink(linkId: string) {
  return await apiRequest<DocumentSyncLink>(api.documentStore.sync.run(linkId), { method: 'POST' });
}

/** 修改同步方向 */
export async function updateSyncLinkDirection(linkId: string, direction: SyncDirection) {
  return await apiRequest<DocumentSyncLink>(api.documentStore.sync.update(linkId), {
    method: 'PATCH',
    body: { direction },
  });
}

/** 撤销配对 */
export async function deleteSyncLink(linkId: string) {
  return await apiRequest<{ deleted: boolean }>(api.documentStore.sync.delete(linkId), { method: 'DELETE' });
}

/** 撤销本库的跨环境令牌（让所有连入对端失效） */
export async function revokeSyncToken(storeId: string) {
  return await apiRequest<{ revoked: boolean }>(api.documentStore.sync.revokeToken(storeId), { method: 'POST' });
}
