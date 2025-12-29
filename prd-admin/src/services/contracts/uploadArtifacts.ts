import type { ApiResponse } from '@/types/api';
import type { UploadArtifact } from '@/types/admin';

export type ListUploadArtifactsParams = {
  requestId: string;
  limit?: number;
};

export type ListUploadArtifactsData = {
  items: UploadArtifact[];
};

export type ListUploadArtifactsContract = (params: ListUploadArtifactsParams) => Promise<ApiResponse<ListUploadArtifactsData>>;


