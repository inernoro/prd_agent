import type { ApiResponse } from '@/types/api';
import type { DocumentContentInfo } from '@/types/admin';

export type GetAdminDocumentContentParams = {
  groupId: string;
};

export type GetAdminDocumentContentContract = (
  documentId: string,
  params: GetAdminDocumentContentParams
) => Promise<ApiResponse<DocumentContentInfo>>;


