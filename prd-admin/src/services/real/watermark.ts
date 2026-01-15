import { apiRequest } from '@/services/real/apiClient';
import type {
  GetModelSizesContract,
  GetWatermarkContract,
  GetWatermarkFontsContract,
  PutWatermarkContract,
} from '@/services/contracts/watermark';

export const getWatermarkReal: GetWatermarkContract = async () => {
  return await apiRequest('/api/user/watermark', { method: 'GET' });
};

export const putWatermarkReal: PutWatermarkContract = async (input) => {
  return await apiRequest('/api/user/watermark', { method: 'PUT', body: input });
};

export const getWatermarkFontsReal: GetWatermarkFontsContract = async () => {
  return await apiRequest('/api/watermark/fonts', { method: 'GET' });
};

export const getModelSizesReal: GetModelSizesContract = async (input) => {
  const key = encodeURIComponent(input.modelKey);
  return await apiRequest(`/api/model/${key}/sizes`, { method: 'GET' });
};
