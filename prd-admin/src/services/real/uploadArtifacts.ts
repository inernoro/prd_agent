import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import type { ListUploadArtifactsContract, ListUploadArtifactsParams, ListUploadArtifactsData } from '@/services/contracts/uploadArtifacts';

function toQuery(params: ListUploadArtifactsParams) {
  const sp = new URLSearchParams();
  sp.set('requestId', String(params.requestId ?? '').trim());
  if (params.limit != null) sp.set('limit', String(params.limit));
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

export const listUploadArtifactsReal: ListUploadArtifactsContract = async (params): Promise<ApiResponse<ListUploadArtifactsData>> => {
  return await apiRequest<ListUploadArtifactsData>(`${api.visualAgent.uploadArtifacts()}${toQuery(params)}`, { method: 'GET' });
};


