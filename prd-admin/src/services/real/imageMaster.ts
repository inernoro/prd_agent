import { apiRequest } from './apiClient';
import type {
  AddImageMasterMessageContract,
  AddImageMasterWorkspaceMessageContract,
  CreateImageMasterSessionContract,
  CreateImageMasterWorkspaceContract,
  DeleteImageMasterAssetContract,
  DeleteImageMasterWorkspaceContract,
  GetImageMasterCanvasContract,
  GetImageMasterSessionContract,
  GetImageMasterWorkspaceCanvasContract,
  GetImageMasterWorkspaceDetailContract,
  ListImageMasterWorkspacesContract,
  SaveImageMasterCanvasContract,
  SaveImageMasterWorkspaceCanvasContract,
  SaveImageMasterWorkspaceViewportContract,
  UpdateImageMasterWorkspaceContract,
  ListImageMasterSessionsContract,
  UploadImageMasterWorkspaceAssetContract,
  DeleteImageMasterWorkspaceAssetContract,
  RefreshImageMasterWorkspaceCoverContract,
  UploadImageAssetContract,
  CreateWorkspaceImageGenRunContract,
  ImageAsset,
  ImageMasterCanvas,
  ImageMasterMessage,
  ImageMasterSession,
  ImageMasterWorkspace,
} from '../contracts/imageMaster';

export const createImageMasterSessionReal: CreateImageMasterSessionContract = async (input) => {
  return await apiRequest<{ session: ImageMasterSession }>('/api/v1/admin/image-master/sessions', {
    method: 'POST',
    body: { title: input.title },
  });
};

export const listImageMasterSessionsReal: ListImageMasterSessionsContract = async (input) => {
  const limit = input?.limit ?? 20;
  return await apiRequest<{ items: ImageMasterSession[] }>(`/api/v1/admin/image-master/sessions?limit=${encodeURIComponent(String(limit))}`, {
    method: 'GET',
  });
};

export const getImageMasterSessionReal: GetImageMasterSessionContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.messageLimit != null) qs.set('messageLimit', String(input.messageLimit));
  if (input.assetLimit != null) qs.set('assetLimit', String(input.assetLimit));
  const q = qs.toString();
  return await apiRequest<{ session: ImageMasterSession; messages: ImageMasterMessage[]; assets: ImageAsset[] }>(
    `/api/v1/admin/image-master/sessions/${encodeURIComponent(input.id)}${q ? `?${q}` : ''}`,
    {
      method: 'GET',
    }
  );
};

export const addImageMasterMessageReal: AddImageMasterMessageContract = async (input) => {
  return await apiRequest<{ message: ImageMasterMessage }>(`/api/v1/admin/image-master/sessions/${encodeURIComponent(input.sessionId)}/messages`, {
    method: 'POST',
    body: { role: input.role, content: input.content },
  });
};

export const uploadImageAssetReal: UploadImageAssetContract = async (input) => {
  return await apiRequest<{ asset: ImageAsset }>('/api/v1/admin/image-master/assets', {
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

export const deleteImageMasterAssetReal: DeleteImageMasterAssetContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(`/api/v1/admin/image-master/assets/${encodeURIComponent(input.id)}`, {
    method: 'DELETE',
  });
};

export const getImageMasterCanvasReal: GetImageMasterCanvasContract = async (input) => {
  return await apiRequest<{ canvas: ImageMasterCanvas | null }>(`/api/v1/admin/image-master/sessions/${encodeURIComponent(input.id)}/canvas`, {
    method: 'GET',
  });
};

export const saveImageMasterCanvasReal: SaveImageMasterCanvasContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ canvas: ImageMasterCanvas }>(`/api/v1/admin/image-master/sessions/${encodeURIComponent(input.id)}/canvas`, {
    method: 'PUT',
    headers,
    body: {
      schemaVersion: input.schemaVersion ?? 1,
      payloadJson: input.payloadJson,
    },
  });
};

export const listImageMasterWorkspacesReal: ListImageMasterWorkspacesContract = async (input) => {
  const limit = input?.limit ?? 20;
  return await apiRequest<{ items: ImageMasterWorkspace[] }>(
    `/api/v1/admin/image-master/workspaces?limit=${encodeURIComponent(String(limit))}`,
    { method: 'GET' }
  );
};

export const createImageMasterWorkspaceReal: CreateImageMasterWorkspaceContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ workspace: ImageMasterWorkspace }>('/api/v1/admin/image-master/workspaces', {
    method: 'POST',
    headers,
    body: { title: input.title },
  });
};

export const updateImageMasterWorkspaceReal: UpdateImageMasterWorkspaceContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ workspace: ImageMasterWorkspace }>(`/api/v1/admin/image-master/workspaces/${encodeURIComponent(input.id)}`, {
    method: 'PUT',
    headers,
    body: {
      title: input.title,
      memberUserIds: input.memberUserIds,
      coverAssetId: input.coverAssetId ?? null,
    },
  });
};

export const deleteImageMasterWorkspaceReal: DeleteImageMasterWorkspaceContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ deleted: boolean }>(`/api/v1/admin/image-master/workspaces/${encodeURIComponent(input.id)}`, {
    method: 'DELETE',
    headers,
  });
};

export const getImageMasterWorkspaceDetailReal: GetImageMasterWorkspaceDetailContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.messageLimit != null) qs.set('messageLimit', String(input.messageLimit));
  if (input.assetLimit != null) qs.set('assetLimit', String(input.assetLimit));
  const q = qs.toString();
  return await apiRequest<{
    workspace: ImageMasterWorkspace;
    messages: ImageMasterMessage[];
    assets: ImageAsset[];
    canvas: ImageMasterCanvas | null;
    viewport?: { z: number; x: number; y: number; updatedAt?: string } | null;
  }>(
    `/api/v1/admin/image-master/workspaces/${encodeURIComponent(input.id)}/detail${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const saveImageMasterWorkspaceViewportReal: SaveImageMasterWorkspaceViewportContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ viewport: { z: number; x: number; y: number; updatedAt?: string } }>(
    `/api/v1/admin/image-master/workspaces/${encodeURIComponent(input.id)}/viewport`,
    {
      method: 'PUT',
      headers,
      body: { z: input.z, x: input.x, y: input.y },
    }
  );
};

export const addImageMasterWorkspaceMessageReal: AddImageMasterWorkspaceMessageContract = async (input) => {
  return await apiRequest<{ message: ImageMasterMessage }>(`/api/v1/admin/image-master/workspaces/${encodeURIComponent(input.id)}/messages`, {
    method: 'POST',
    body: { role: input.role, content: input.content },
  });
};

export const getImageMasterWorkspaceCanvasReal: GetImageMasterWorkspaceCanvasContract = async (input) => {
  return await apiRequest<{ canvas: ImageMasterCanvas | null }>(`/api/v1/admin/image-master/workspaces/${encodeURIComponent(input.id)}/canvas`, {
    method: 'GET',
  });
};

export const saveImageMasterWorkspaceCanvasReal: SaveImageMasterWorkspaceCanvasContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ canvas: ImageMasterCanvas }>(`/api/v1/admin/image-master/workspaces/${encodeURIComponent(input.id)}/canvas`, {
    method: 'PUT',
    headers,
    body: { schemaVersion: input.schemaVersion ?? 1, payloadJson: input.payloadJson },
  });
};

export const uploadImageMasterWorkspaceAssetReal: UploadImageMasterWorkspaceAssetContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ asset: ImageAsset }>(`/api/v1/admin/image-master/workspaces/${encodeURIComponent(input.id)}/assets`, {
    method: 'POST',
    headers,
    body: {
      data: input.data,
      sourceUrl: input.sourceUrl,
      prompt: input.prompt,
      width: input.width,
      height: input.height,
    },
  });
};

export const createWorkspaceImageGenRunReal: CreateWorkspaceImageGenRunContract = async ({ id, input, idempotencyKey }) => {
  const headers: Record<string, string> = {};
  const idem = String(idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest<{ runId: string }>(`/api/v1/admin/image-master/workspaces/${encodeURIComponent(id)}/image-gen/runs`, {
    method: 'POST',
    headers,
    body: input,
  });
};

export const deleteImageMasterWorkspaceAssetReal: DeleteImageMasterWorkspaceAssetContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    `/api/v1/admin/image-master/workspaces/${encodeURIComponent(input.id)}/assets/${encodeURIComponent(input.assetId)}`,
    { method: 'DELETE' }
  );
};

export const refreshImageMasterWorkspaceCoverReal: RefreshImageMasterWorkspaceCoverContract = async (input) => {
  const headers: Record<string, string> = {};
  const idem = String(input.idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  const limit = input.limit ?? 6;
  return await apiRequest<{ workspace: ImageMasterWorkspace }>(
    `/api/v1/admin/image-master/workspaces/${encodeURIComponent(input.id)}/cover/refresh?limit=${encodeURIComponent(String(limit))}`,
    { method: 'POST', headers }
  );
};


