import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type {
  AddVisualAgentMessageContract,
  AddVisualAgentWorkspaceMessageContract,
  CreateVisualAgentSessionContract,
  CreateVisualAgentWorkspaceContract,
  DeleteVisualAgentAssetContract,
  DeleteVisualAgentWorkspaceContract,
  GetVisualAgentCanvasContract,
  GetVisualAgentSessionContract,
  GetVisualAgentWorkspaceCanvasContract,
  GetVisualAgentWorkspaceDetailContract,
  ListVisualAgentWorkspacesContract,
  SaveVisualAgentCanvasContract,
  SaveVisualAgentWorkspaceCanvasContract,
  SaveVisualAgentWorkspaceViewportContract,
  UpdateVisualAgentWorkspaceContract,
  ListVisualAgentSessionsContract,
  UploadVisualAgentWorkspaceAssetContract,
  DeleteVisualAgentWorkspaceAssetContract,
  RefreshVisualAgentWorkspaceCoverContract,
  UploadImageAssetContract,
  CreateWorkspaceImageGenRunContract,
  ImageAsset,
  VisualAgentCanvas,
  VisualAgentMessage,
  VisualAgentSession,
  VisualAgentWorkspace,
} from '../contracts/visualAgent';

export const createVisualAgentSessionReal: CreateVisualAgentSessionContract = async (input) => {
  return await apiRequest<{ session: VisualAgentSession }>(api.visualAgent.imageMaster.sessions.list(), {
    method: 'POST',
    body: { title: input.title },
  });
};

export const listVisualAgentSessionsReal: ListVisualAgentSessionsContract = async (input) => {
  const limit = input?.limit ?? 20;
  return await apiRequest<{ items: VisualAgentSession[] }>(`${api.visualAgent.imageMaster.sessions.list()}?limit=${encodeURIComponent(String(limit))}`, {
    method: 'GET',
  });
};

export const getVisualAgentSessionReal: GetVisualAgentSessionContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.messageLimit != null) qs.set('messageLimit', String(input.messageLimit));
  if (input.assetLimit != null) qs.set('assetLimit', String(input.assetLimit));
  const q = qs.toString();
  return await apiRequest<{ session: VisualAgentSession; messages: VisualAgentMessage[]; assets: ImageAsset[] }>(
    `${api.visualAgent.imageMaster.sessions.byId(encodeURIComponent(input.id))}${q ? `?${q}` : ''}`,
    {
      method: 'GET',
    }
  );
};

export const addVisualAgentMessageReal: AddVisualAgentMessageContract = async (input) => {
  return await apiRequest<{ message: VisualAgentMessage }>(api.visualAgent.imageMaster.sessions.messages(encodeURIComponent(input.sessionId)), {
    method: 'POST',
    body: { role: input.role, content: input.content },
  });
};

export const uploadImageAssetReal: UploadImageAssetContract = async (input) => {
  return await apiRequest<{ asset: ImageAsset }>(api.visualAgent.imageMaster.assets.upload(), {
    method: 'POST',
    body: {
      data: input.data,
      sourceUrl: input.sourceUrl,
      prompt: input.prompt,
      width: input.width,
      height: input.height,
    },
  });
};

export const deleteVisualAgentAssetReal: DeleteVisualAgentAssetContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(api.visualAgent.imageMaster.assets.byId(encodeURIComponent(input.id)), {
    method: 'DELETE',
  });
};

export const getVisualAgentCanvasReal: GetVisualAgentCanvasContract = async (input) => {
  return await apiRequest<{ canvas: VisualAgentCanvas | null }>(api.visualAgent.imageMaster.sessions.canvas(encodeURIComponent(input.id)), {
    method: 'GET',
  });
};

export const saveVisualAgentCanvasReal: SaveVisualAgentCanvasContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ canvas: VisualAgentCanvas }>(api.visualAgent.imageMaster.sessions.canvas(encodeURIComponent(input.id)), {
    method: 'PUT',
    headers,
    body: {
      schemaVersion: input.schemaVersion ?? 1,
      payloadJson: input.payloadJson,
    },
  });
};

export const listVisualAgentWorkspacesReal: ListVisualAgentWorkspacesContract = async (input) => {
  const limit = input?.limit ?? 20;
  return await apiRequest<{ items: VisualAgentWorkspace[] }>(
    `${api.visualAgent.imageMaster.workspaces.list()}?limit=${encodeURIComponent(String(limit))}`,
    { method: 'GET' }
  );
};

export const createVisualAgentWorkspaceReal: CreateVisualAgentWorkspaceContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ workspace: VisualAgentWorkspace }>(api.visualAgent.imageMaster.workspaces.list(), {
    method: 'POST',
    headers,
    body: {
      title: input.title,
      scenarioType: input.scenarioType,
    },
  });
};

export const updateVisualAgentWorkspaceReal: UpdateVisualAgentWorkspaceContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ workspace: VisualAgentWorkspace }>(api.visualAgent.imageMaster.workspaces.byId(encodeURIComponent(input.id)), {
    method: 'PUT',
    headers,
    body: {
      title: input.title,
      memberUserIds: input.memberUserIds,
      coverAssetId: input.coverAssetId ?? null,
      articleContent: input.articleContent,
      scenarioType: input.scenarioType,
      folderName: input.folderName,
    },
  });
};

export const deleteVisualAgentWorkspaceReal: DeleteVisualAgentWorkspaceContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ deleted: boolean }>(api.visualAgent.imageMaster.workspaces.byId(encodeURIComponent(input.id)), {
    method: 'DELETE',
    headers,
  });
};

export const generateVisualAgentWorkspaceTitleReal = async (workspaceId: string, prompt: string) => {
  return await apiRequest<{ title: string }>(api.visualAgent.imageMaster.workspaces.generateTitle(encodeURIComponent(workspaceId)), {
    method: 'POST',
    body: { prompt },
  });
};

export const getVisualAgentWorkspaceDetailReal: GetVisualAgentWorkspaceDetailContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.messageLimit != null) qs.set('messageLimit', String(input.messageLimit));
  if (input.assetLimit != null) qs.set('assetLimit', String(input.assetLimit));
  const q = qs.toString();
  return await apiRequest<{
    workspace: VisualAgentWorkspace;
    messages: VisualAgentMessage[];
    assets: ImageAsset[];
    canvas: VisualAgentCanvas | null;
    viewport?: { z: number; x: number; y: number; updatedAt?: string } | null;
  }>(
    `${api.visualAgent.imageMaster.workspaces.detail(encodeURIComponent(input.id))}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const saveVisualAgentWorkspaceViewportReal: SaveVisualAgentWorkspaceViewportContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ viewport: { z: number; x: number; y: number; updatedAt?: string } }>(
    api.visualAgent.imageMaster.workspaces.viewport(encodeURIComponent(input.id)),
    {
      method: 'PUT',
      headers,
      body: { z: input.z, x: input.x, y: input.y },
    }
  );
};

export const addVisualAgentWorkspaceMessageReal: AddVisualAgentWorkspaceMessageContract = async (input) => {
  return await apiRequest<{ message: VisualAgentMessage }>(api.visualAgent.imageMaster.workspaces.messages(encodeURIComponent(input.id)), {
    method: 'POST',
    body: { role: input.role, content: input.content },
  });
};

export const getVisualAgentWorkspaceCanvasReal: GetVisualAgentWorkspaceCanvasContract = async (input) => {
  return await apiRequest<{ canvas: VisualAgentCanvas | null }>(api.visualAgent.imageMaster.workspaces.canvas(encodeURIComponent(input.id)), {
    method: 'GET',
  });
};

export const saveVisualAgentWorkspaceCanvasReal: SaveVisualAgentWorkspaceCanvasContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ canvas: VisualAgentCanvas }>(api.visualAgent.imageMaster.workspaces.canvas(encodeURIComponent(input.id)), {
    method: 'PUT',
    headers,
    body: { schemaVersion: input.schemaVersion ?? 1, payloadJson: input.payloadJson },
  });
};

export const uploadVisualAgentWorkspaceAssetReal: UploadVisualAgentWorkspaceAssetContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ asset: ImageAsset }>(api.visualAgent.imageMaster.workspaces.assets(encodeURIComponent(input.id)), {
    method: 'POST',
    headers,
    body: {
      data: input.data,
      sourceUrl: input.sourceUrl,
      prompt: input.prompt,
      width: input.width,
      height: input.height,
      articleInsertionIndex: input.articleInsertionIndex,
      originalMarkerText: input.originalMarkerText,
    },
  });
};

export const createWorkspaceImageGenRunReal: CreateWorkspaceImageGenRunContract = async ({ id, input, idempotencyKey }) => {
  const headers: Record<string, string> = {};
  const idem = String(idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ runId: string }>(api.visualAgent.imageMaster.workspaces.imageGenRuns(encodeURIComponent(id)), {
    method: 'POST',
    headers,
    body: input,
  });
};

export const deleteVisualAgentWorkspaceAssetReal: DeleteVisualAgentWorkspaceAssetContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    api.visualAgent.imageMaster.workspaces.asset(encodeURIComponent(input.id), encodeURIComponent(input.assetId)),
    { method: 'DELETE' }
  );
};

export const refreshVisualAgentWorkspaceCoverReal: RefreshVisualAgentWorkspaceCoverContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  const limit = input.limit ?? 6;
  return await apiRequest<{ workspace: VisualAgentWorkspace }>(
    `${api.visualAgent.imageMaster.workspaces.coverRefresh(encodeURIComponent(input.id))}?limit=${encodeURIComponent(String(limit))}`,
    { method: 'POST', headers }
  );
};

// -------- 文章配图场景专用接口 --------

export async function* generateArticleMarkersReal(input: {
  id: string;
  articleContent: string;
  userInstruction?: string;
  idempotencyKey?: string;
  insertionMode?: 'legacy' | 'anchor';
}): AsyncIterable<{ type: string; text?: string; fullText?: string; message?: string; index?: number; mode?: string; markerCount?: number }> {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
  };

  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;

  // 从 authStore 获取 token
  const { useAuthStore } = await import('@/stores/authStore');
  const token = useAuthStore.getState().token;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}${api.visualAgent.imageMaster.workspaces.article.generateMarkers(encodeURIComponent(input.id))}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      articleContent: input.articleContent,
      userInstruction: input.userInstruction,
      insertionMode: input.insertionMode,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data.trim()) {
            try {
              const parsed = JSON.parse(data);
              yield parsed;
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function extractArticleMarkersReal(input: {
  id: string;
  articleContentWithMarkers: string;
}) {
  return await apiRequest<{ markers: Array<{ index: number; text: string; startPos: number; endPos: number }> }>(
    api.visualAgent.imageMaster.workspaces.article.extractMarkers(encodeURIComponent(input.id)),
    {
      method: 'POST',
      body: {
        articleContentWithMarkers: input.articleContentWithMarkers,
      },
    }
  );
}

export async function exportArticleReal(input: {
  id: string;
  useCdn: boolean;
  exportFormat?: string;
}) {
  return await apiRequest<{ content: string; format: string; assetCount: number }>(
    api.visualAgent.imageMaster.workspaces.article.export(encodeURIComponent(input.id)),
    {
      method: 'POST',
      body: {
        useCdn: input.useCdn,
        exportFormat: input.exportFormat,
      },
    }
  );
}

export async function updateArticleMarkerReal(params: {
  workspaceId: string;
  markerIndex: number;
  draftText?: string;
  status?: string;
  runId?: string;
  errorMessage?: string;
  planItem?: { prompt: string; count: number; size?: string };
  url?: string;
}) {
  const { workspaceId, markerIndex, ...body } = params;
  return await apiRequest<{ marker: unknown }>(
    api.visualAgent.imageMaster.workspaces.article.marker(encodeURIComponent(workspaceId), markerIndex),
    {
      method: 'PATCH',
      body,
    }
  );
}
