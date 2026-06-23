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
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
  assetsRewritten?: number;
  assetRewriteFailed?: number;
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

/** 强制对齐模式：remote=远端为准 / local=本地为准 / both=同时对准 */
export type PeerAlign = 'remote' | 'local' | 'both';

/** 发起互传（普通方向 direction，或强制对齐 align —— align 设置后覆盖 direction/mode） */
export async function transferToPeer(params: {
  nodeId: string;
  resourceType: string;
  itemIds: string[];
  direction?: PeerTransferDirection;
  align?: PeerAlign;
  mode?: PeerApplyMode;
  preserveTimestamps?: boolean;
  rewriteAssetLinks?: boolean;
}) {
  return await apiRequest<{ direction: string; results: TransferItemResult[]; anyFail: boolean }>(
    api.peerSync.transfer(),
    { method: 'POST', body: params },
  );
}

/** 开/关某知识库的后台自动同步（复用最近一次同步的对端 + 方向；非破坏性，绝不删条目） */
export async function setAutoSync(params: {
  resourceType: string;
  itemId: string;
  enabled: boolean;
  intervalMinutes?: number;
}) {
  return await apiRequest<{ enabled: boolean; intervalMinutes: number; direction?: string | null; nodeName?: string | null }>(
    api.peerSync.autoSync(),
    { method: 'POST', body: params },
  );
}

/** 同步运行台账（进行中 / 发出去 / 收进来 / 历史） */
export interface PeerSyncRun {
  id: string;
  resourceType: string;
  itemId: string;
  itemName: string;
  /** push / pull / both / received / align-remote / align-local / align-both */
  direction: string;
  /** outgoing（本端发起）/ incoming（对端推来） */
  origin: 'outgoing' | 'incoming' | string;
  peerNodeId: string;
  peerNodeName: string;
  peerNodeBaseUrl?: string | null;
  status: 'syncing' | 'synced' | 'skipped' | 'error' | string;
  created: number;
  updated: number;
  skipped: number;
  deleted: number;
  failed: number;
  assetsRewritten: number;
  assetRewriteFailed: number;
  message?: string | null;
  triggeredByUserId: string;
  triggeredByName?: string | null;
  durationMs: number;
  startedAt: string;
  finishedAt?: string | null;
}

/** 列出同步运行台账。itemId 省略=当前用户全部可见条目；传 itemId=限定单库。 */
export async function listPeerSyncRuns(resourceType: string, itemId?: string) {
  return await apiRequest<{ items: PeerSyncRun[] }>(
    api.peerSync.runs(resourceType, itemId),
    { method: 'GET' },
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
