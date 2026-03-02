import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { type ApiResponse } from '@/types/api';
import { useAuthStore } from '@/stores/authStore';

// ============ Arena Groups ============

export async function listArenaGroupsReal(): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.groups.list());
}

export async function createArenaGroupReal(data: any): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.groups.list(), {
    method: 'POST',
    body: data,
  });
}

export async function updateArenaGroupReal(id: string, data: any): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.groups.byId(id), {
    method: 'PUT',
    body: data,
  });
}

export async function deleteArenaGroupReal(id: string): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.groups.byId(id), {
    method: 'DELETE',
  });
}

// ============ Arena Slots ============

export async function listArenaSlotsReal(group?: string): Promise<ApiResponse<any>> {
  const params = new URLSearchParams();
  if (group) params.set('group', group);
  const qs = params.toString() ? `?${params}` : '';
  return await apiRequest(`${api.arena.slots.list()}${qs}`);
}

export async function createArenaSlotReal(data: any): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.slots.list(), {
    method: 'POST',
    body: data,
  });
}

export async function updateArenaSlotReal(id: string, data: any): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.slots.byId(id), {
    method: 'PUT',
    body: data,
  });
}

export async function deleteArenaSlotReal(id: string): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.slots.byId(id), {
    method: 'DELETE',
  });
}

export async function toggleArenaSlotReal(id: string): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.slots.toggle(id), {
    method: 'PUT',
  });
}

// ============ Arena Lineup & Reveal ============

export async function getArenaLineupReal(): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.lineup());
}

export async function revealArenaSlotsReal(slotIds: string[]): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.reveal(), {
    method: 'POST',
    body: { slotIds },
  });
}

// ============ Arena Runs (Run/Worker + afterSeq) ============

export async function createArenaRunReal(data: {
  prompt: string;
  groupKey: string;
  slots: Array<{
    slotId: string;
    platformId: string;
    modelId: string;
    label: string;
    labelIndex: number;
  }>;
  attachmentIds?: string[];
}): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.runs.create(), {
    method: 'POST',
    body: data,
  });
}

export async function getArenaRunReal(runId: string): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.runs.byId(runId));
}

export async function cancelArenaRunReal(runId: string): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.runs.cancel(runId), {
    method: 'POST',
  });
}

// ============ Arena Battles ============

export async function saveArenaBattleReal(data: any): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.battles.list(), {
    method: 'POST',
    body: data,
  });
}

export async function listArenaBattlesReal(page?: number, pageSize?: number): Promise<ApiResponse<any>> {
  const params = new URLSearchParams();
  if (page != null) params.set('page', String(page));
  if (pageSize != null) params.set('pageSize', String(pageSize));
  const qs = params.toString() ? `?${params}` : '';
  return await apiRequest(`${api.arena.battles.list()}${qs}`);
}

export async function getArenaBattleReal(id: string): Promise<ApiResponse<any>> {
  return await apiRequest(api.arena.battles.byId(id));
}

// ============ Arena Attachment Upload ============

export interface ArenaAttachmentInfo {
  attachmentId: string;
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export async function uploadArenaAttachmentReal(file: File): Promise<ApiResponse<ArenaAttachmentInfo>> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase ? `${rawBase}/api/v1/attachments` : '/api/v1/attachments';

  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<ArenaAttachmentInfo>;
  } catch {
    return { success: false, error: { code: 'PARSE_ERROR', message: text || '上传失败' } } as any;
  }
}
