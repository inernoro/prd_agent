import { apiRequest } from './apiClient';
import type {
  AddImageMasterMessageContract,
  CreateImageMasterSessionContract,
  DeleteImageMasterAssetContract,
  GetImageMasterSessionContract,
  ListImageMasterSessionsContract,
  UploadImageAssetContract,
  ImageAsset,
  ImageMasterMessage,
  ImageMasterSession,
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


