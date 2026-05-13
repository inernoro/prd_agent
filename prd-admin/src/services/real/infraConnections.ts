/**
 * 基础设施连接 service（MAP 端剪贴板配对密钥）
 * 详见 doc/spec.cds-map-pairing-protocol.md
 */
import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

export interface InfraConnectionPublicView {
  id: string;
  partner: string;
  partnerName: string;
  partnerId: string;
  partnerBaseUrl: string;
  projectId: string;
  instanceDiscoveryUrl: string;
  scopes: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
  lastProbedAt?: string | null;
  lastProbeOk?: boolean | null;
  lastProbeError?: string | null;
  longTokenExpiresAt: string;
}

interface ListResp {
  items: InfraConnectionPublicView[];
}

interface ItemResp {
  item: InfraConnectionPublicView;
}

interface DeleteResp {
  deleted: boolean;
}

interface CdsAuthorizeStartResp {
  authorizeUrl: string;
  state: string;
  cdsBaseUrl: string;
  expiresAt: string;
}

export async function listInfraConnections(): Promise<ApiResponse<ListResp>> {
  return await apiRequest<ListResp>(api.infraConnections.list(), { method: 'GET' });
}

export async function pasteInfraConnection(
  clipboardText: string,
): Promise<ApiResponse<ItemResp>> {
  return await apiRequest<ItemResp>(api.infraConnections.paste(), {
    method: 'POST',
    body: { clipboardText },
  });
}

export async function startCdsAuthorization(
  cdsBaseUrl: string,
): Promise<ApiResponse<CdsAuthorizeStartResp>> {
  return await apiRequest<CdsAuthorizeStartResp>(api.infraConnections.cdsAuthorizeStart(), {
    method: 'POST',
    body: { cdsBaseUrl },
  });
}

export async function completeCdsAuthorization(
  code: string,
  state: string,
): Promise<ApiResponse<ItemResp>> {
  return await apiRequest<ItemResp>(api.infraConnections.cdsAuthorizeComplete(), {
    method: 'POST',
    body: { code, state },
  });
}

export async function deleteInfraConnection(id: string): Promise<ApiResponse<DeleteResp>> {
  return await apiRequest<DeleteResp>(api.infraConnections.byId(encodeURIComponent(id)), {
    method: 'DELETE',
    emptyResponseData: { deleted: true },
  });
}

export async function probeInfraConnection(id: string): Promise<ApiResponse<ItemResp>> {
  return await apiRequest<ItemResp>(api.infraConnections.probe(encodeURIComponent(id)), {
    method: 'POST',
    body: {},
  });
}

/**
 * 解析剪贴板密文，给 UI 二次确认（钓鱼防护，spec §5）。
 * 不调后端，纯前端 base64url 解码 + JSON 解析。
 * 解析失败返回 null，让 UI 展示通用"格式不对"。
 */
export interface ClipboardPayloadPreview {
  cdsBaseUrl: string;
  cdsId?: string;
  cdsName?: string;
  scopes?: string[];
  expiresAt?: string;
  version?: number;
}

export function parseClipboardPreview(text: string): ClipboardPayloadPreview | null {
  if (!text) return null;
  const trimmed = text.trim();
  const prefix = 'cds-connect:v1:';
  if (!trimmed.startsWith(prefix)) return null;
  const encoded = trimmed.slice(prefix.length);
  try {
    // base64url → base64
    let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const json = atob(b64);
    // 处理可能的 UTF-8 多字节字符
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder('utf-8').decode(bytes);
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const cdsBaseUrl = typeof parsed.cdsBaseUrl === 'string' ? parsed.cdsBaseUrl : '';
    if (!cdsBaseUrl) return null;
    return {
      cdsBaseUrl,
      cdsId: typeof parsed.cdsId === 'string' ? parsed.cdsId : undefined,
      cdsName: typeof parsed.cdsName === 'string' ? parsed.cdsName : undefined,
      scopes: Array.isArray(parsed.scopes)
        ? (parsed.scopes.filter((s) => typeof s === 'string') as string[])
        : undefined,
      expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : undefined,
      version: typeof parsed.version === 'number' ? parsed.version : undefined,
    };
  } catch {
    return null;
  }
}
