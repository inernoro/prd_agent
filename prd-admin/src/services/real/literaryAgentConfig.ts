import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type {
  GetLiteraryAgentConfigContract,
  UpdateLiteraryAgentConfigContract,
  UploadReferenceImageContract,
  ClearReferenceImageContract,
  ListReferenceImageConfigsContract,
  CreateReferenceImageConfigContract,
  UpdateReferenceImageConfigContract,
  UpdateReferenceImageFileContract,
  DeleteReferenceImageConfigContract,
  ActivateReferenceImageConfigContract,
  DeactivateReferenceImageConfigContract,
  GetActiveReferenceImageConfigContract,
  LiteraryAgentConfig,
  ReferenceImageConfig,
} from '../contracts/literaryAgentConfig';

export const getLiteraryAgentConfigReal: GetLiteraryAgentConfigContract = async () => {
  return await apiRequest<LiteraryAgentConfig>(api.literaryAgent.config.get(), {
    method: 'GET',
  });
};

export const updateLiteraryAgentConfigReal: UpdateLiteraryAgentConfigContract = async (input) => {
  return await apiRequest<LiteraryAgentConfig>(api.literaryAgent.config.get(), {
    method: 'PUT',
    body: {
      referenceImageSha256: input.referenceImageSha256,
      referenceImageUrl: input.referenceImageUrl,
    },
  });
};

export const uploadReferenceImageReal: UploadReferenceImageContract = async (file) => {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase
    ? `${rawBase}${api.literaryAgent.config.referenceImage()}`
    : api.literaryAgent.config.referenceImage();

  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const json = await res.json();

  if (!res.ok || !json.success) {
    return {
      success: false,
      data: null,
      error: json.error ?? { code: 'UPLOAD_FAILED', message: '上传失败' },
    };
  }

  return {
    success: true,
    data: json.data as { sha256: string; url: string; config: LiteraryAgentConfig },
    error: null,
  };
};

export const clearReferenceImageReal: ClearReferenceImageContract = async () => {
  return await apiRequest<{ cleared: boolean; config: LiteraryAgentConfig }>(
    api.literaryAgent.config.referenceImage(),
    { method: 'DELETE' }
  );
};

// ========== 新的底图配置 API ==========

export const listReferenceImageConfigsReal: ListReferenceImageConfigsContract = async () => {
  return await apiRequest<{ items: ReferenceImageConfig[] }>(
    api.literaryAgent.config.referenceImages.list(),
    { method: 'GET' }
  );
};

export const createReferenceImageConfigReal: CreateReferenceImageConfigContract = async (input) => {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('name', input.name);
  if (input.prompt) fd.append('prompt', input.prompt);
  fd.append('file', input.file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase
    ? `${rawBase}${api.literaryAgent.config.referenceImages.list()}`
    : api.literaryAgent.config.referenceImages.list();

  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const json = await res.json();

  if (!res.ok || !json.success) {
    return {
      success: false,
      data: null,
      error: json.error ?? { code: 'CREATE_FAILED', message: '创建失败' },
    };
  }

  return {
    success: true,
    data: json.data as { config: ReferenceImageConfig },
    error: null,
  };
};

export const updateReferenceImageConfigReal: UpdateReferenceImageConfigContract = async (input) => {
  return await apiRequest<{ config: ReferenceImageConfig }>(
    api.literaryAgent.config.referenceImages.byId(encodeURIComponent(input.id)),
    {
      method: 'PUT',
      body: {
        name: input.name,
        prompt: input.prompt,
      },
    }
  );
};

export const updateReferenceImageFileReal: UpdateReferenceImageFileContract = async (input) => {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', input.file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase
    ? `${rawBase}${api.literaryAgent.config.referenceImages.image(encodeURIComponent(input.id))}`
    : api.literaryAgent.config.referenceImages.image(encodeURIComponent(input.id));

  const res = await fetch(url, { method: 'PUT', headers, body: fd });
  const json = await res.json();

  if (!res.ok || !json.success) {
    return {
      success: false,
      data: null,
      error: json.error ?? { code: 'UPDATE_FAILED', message: '更新失败' },
    };
  }

  return {
    success: true,
    data: json.data as { config: ReferenceImageConfig },
    error: null,
  };
};

export const deleteReferenceImageConfigReal: DeleteReferenceImageConfigContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    api.literaryAgent.config.referenceImages.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

export const activateReferenceImageConfigReal: ActivateReferenceImageConfigContract = async (input) => {
  return await apiRequest<{ config: ReferenceImageConfig }>(
    api.literaryAgent.config.referenceImages.activate(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const deactivateReferenceImageConfigReal: DeactivateReferenceImageConfigContract = async (input) => {
  return await apiRequest<{ config: ReferenceImageConfig }>(
    api.literaryAgent.config.referenceImages.deactivate(encodeURIComponent(input.id)),
    { method: 'POST' }
  );
};

export const getActiveReferenceImageConfigReal: GetActiveReferenceImageConfigContract = async () => {
  return await apiRequest<{ config: ReferenceImageConfig | null }>(
    api.literaryAgent.config.referenceImages.active(),
    { method: 'GET' }
  );
};
