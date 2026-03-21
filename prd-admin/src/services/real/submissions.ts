import { apiRequest } from '@/services/real/apiClient';
import api from '@/services/api';

export interface SubmissionItem {
  id: string;
  title: string;
  contentType: 'visual' | 'literary';
  coverUrl: string;
  coverWidth: number;
  coverHeight: number;
  prompt?: string;
  ownerUserId: string;
  ownerUserName: string;
  ownerAvatarFileName?: string;
  likeCount: number;
  likedByMe: boolean;
  createdAt: string;
}

export async function listPublicSubmissions(params?: {
  contentType?: string;
  skip?: number;
  limit?: number;
}) {
  const query = new URLSearchParams();
  if (params?.contentType) query.set('contentType', params.contentType);
  if (params?.skip != null) query.set('skip', String(params.skip));
  if (params?.limit != null) query.set('limit', String(params.limit));
  const qs = query.toString();
  const url = api.submissions.public() + (qs ? `?${qs}` : '');
  return apiRequest<{ total: number; items: SubmissionItem[] }>(url);
}

export async function createSubmission(body: {
  contentType: string;
  title?: string;
  imageAssetId?: string;
  workspaceId?: string;
  isPublic?: boolean;
}) {
  return apiRequest<{ submission: SubmissionItem; created: boolean }>(
    api.submissions.create(),
    { method: 'POST', body },
  );
}

export async function autoSubmitImages(imageAssetIds: string[]) {
  return apiRequest<{ submitted: number }>(
    api.submissions.autoSubmit(),
    { method: 'POST', body: { imageAssetIds } },
  );
}

export async function toggleSubmissionVisibility(id: string, isPublic: boolean) {
  return apiRequest<{ id: string; isPublic: boolean }>(
    api.submissions.visibility(id),
    { method: 'PATCH', body: { isPublic } },
  );
}

export async function deleteSubmission(id: string) {
  return apiRequest<{ deleted: boolean }>(
    api.submissions.delete(id),
    { method: 'DELETE' },
  );
}

export async function likeSubmission(id: string) {
  return apiRequest<{ likedByMe: boolean; count: number }>(
    api.submissions.like(id),
    { method: 'POST' },
  );
}

export async function unlikeSubmission(id: string) {
  return apiRequest<{ likedByMe: boolean; count: number }>(
    api.submissions.like(id),
    { method: 'DELETE' },
  );
}

export async function checkSubmission(params: { imageAssetId?: string; workspaceId?: string }) {
  const query = new URLSearchParams();
  if (params.imageAssetId) query.set('imageAssetId', params.imageAssetId);
  if (params.workspaceId) query.set('workspaceId', params.workspaceId);
  return apiRequest<{ submitted: boolean; submission?: SubmissionItem }>(
    api.submissions.check() + `?${query.toString()}`,
  );
}
