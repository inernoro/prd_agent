import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import type { DocumentContentInfo } from '@/types/admin';
import type { GetAdminDocumentContentContract } from '@/services/contracts/adminDocuments';

export const getAdminDocumentContentReal: GetAdminDocumentContentContract = async (
  documentId: string,
  params: { groupId: string }
): Promise<ApiResponse<DocumentContentInfo>> => {
  const groupId = String(params?.groupId ?? '').trim();
  return await apiRequest<DocumentContentInfo>(
    api.data.documents.content(encodeURIComponent(documentId), encodeURIComponent(groupId)),
    { method: 'GET' }
  );
};


