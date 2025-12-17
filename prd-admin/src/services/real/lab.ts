import { apiRequest } from '@/services/real/apiClient';
import { ok, type ApiResponse } from '@/types/api';
import type { AdminImpersonateContract, AdminImpersonateResponse } from '@/services/contracts/lab';

type BackendImpersonateResponse = AdminImpersonateResponse;

export const adminImpersonateReal: AdminImpersonateContract = async (
  userId: string,
  expiresInSeconds?: number
): Promise<ApiResponse<AdminImpersonateResponse>> => {
  const res = await apiRequest<BackendImpersonateResponse>('/api/v1/admin/lab/impersonate', {
    method: 'POST',
    body: { userId, expiresInSeconds },
  });
  if (!res.success) return res;
  return ok(res.data);
};

