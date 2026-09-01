import { apiRequest } from './apiClient';

export type VisualModelPolicy = {
  revision: number;
  defaultModelId: string;
  models: { modelId: string; displayName: string; description?: string | null }[];
};

export type VisualModelCatalogEntry = {
  model: { code: string; name: string; description?: string; capabilities: string[] };
  imageCapabilities: { supportsImageToImage: boolean; sizesByResolution: Record<string, { size: string; aspectRatio: string }[]> } | null;
};

const endpoint = '/api/visual-agent/model-policy';
export const getVisualModelPolicy = () => apiRequest<VisualModelPolicy>(endpoint);
export const getVisualModelCatalog = () => apiRequest<VisualModelCatalogEntry[]>(`${endpoint}/catalog`);
export const saveVisualModelPolicy = (body: VisualModelPolicy) => apiRequest<VisualModelPolicy>(endpoint, { method: 'PUT', body });
