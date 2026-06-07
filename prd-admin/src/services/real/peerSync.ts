import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';

/** 互传方向：push（本地→对端）/ pull（对端→本地）/ both（双向，仅双向资源） */
export type PeerTransferDirection = 'push' | 'pull' | 'both';
export type PeerApplyMode = 'overwrite' | 'add-only';
export type PeerNodeStatus = 'pending' | 'connected' | 'error';

export interface PeerNode {
  id: string;
  remoteNodeId: string;
  displayName: string;
  baseUrl: string;
  status: PeerNodeStatus;
  lastError?: string | null;
  lastContactAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SyncResourceCapability {
  resourceType: string;
  displayName: string;
  supportsBidirectional: boolean;
  schemaVersion: number;
}

export interface SyncItemSummary {
  itemId: string;
  name: string;
  description?: string | null;
  recordCount: number;
  updatedAt?: string | null;
}

export interface TransferItemResult {
  itemId: string;
  ok: boolean;
  message?: string;
}

// ─────────────────────────────────────────────
// 用户侧：发起互传
// ─────────────────────────────────────────────

/** 列出可发送的对端节点 + 本节点支持的资源能力 */
export async function listPeerNodes() {
  return await apiRequest<{ items: PeerNode[]; capabilities: SyncResourceCapability[] }>(
    api.peerSync.nodes(),
    { method: 'GET' },
  );
}

/** 列出本节点当前用户可发送的某类资源条目 */
export async function listPeerItems(resourceType: string) {
  return await apiRequest<{ items: SyncItemSummary[] }>(api.peerSync.items(resourceType), { method: 'GET' });
}

/** 发起互传 */
export async function transferToPeer(params: {
  nodeId: string;
  resourceType: string;
  itemIds: string[];
  direction: PeerTransferDirection;
  mode?: PeerApplyMode;
}) {
  return await apiRequest<{ direction: string; results: TransferItemResult[]; anyFail: boolean }>(
    api.peerSync.transfer(),
    { method: 'POST', body: params },
  );
}

// ─────────────────────────────────────────────
// 管理侧：系统互联配置
// ─────────────────────────────────────────────

export async function listAdminPeerNodes() {
  return await apiRequest<{ selfNodeId: string; selfBaseUrl: string; items: PeerNode[] }>(
    api.peerSync.adminList(),
    { method: 'GET' },
  );
}

export async function generatePairingCode() {
  return await apiRequest<{ pairingCode: string; expiresInSeconds: number; selfNodeId: string; selfBaseUrl: string }>(
    api.peerSync.adminPairingCode(),
    { method: 'POST' },
  );
}

export async function addPeerNode(params: {
  baseUrl: string;
  pairingCode: string;
  displayName?: string;
  selfBaseUrl?: string;
  selfDisplayName?: string;
}) {
  return await apiRequest<PeerNode>(api.peerSync.adminAdd(), { method: 'POST', body: params });
}

export async function testPeerNode(id: string) {
  return await apiRequest<{ ok: boolean; status?: number; error?: string }>(
    api.peerSync.adminTest(id),
    { method: 'POST' },
  );
}

export async function deletePeerNode(id: string) {
  return await apiRequest<{ deleted: boolean }>(api.peerSync.adminDelete(id), { method: 'DELETE' });
}
