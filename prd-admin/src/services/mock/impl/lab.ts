import { fail, ok, type ApiResponse } from '@/types/api';
import type { AdminImpersonateResponse } from '@/services/contracts/lab';
import { sleep } from '@/services/mock/utils';

export async function adminImpersonateMock(userId: string, expiresInSeconds?: number): Promise<ApiResponse<AdminImpersonateResponse>> {
  await sleep(250);
  if (!userId) return fail('INVALID_FORMAT', 'userId 不能为空');
  return ok({
    accessToken: `mock-impersonate-${userId}-${Date.now()}`,
    expiresIn: expiresInSeconds ?? 900,
    user: { userId, username: `mock_${userId}`, displayName: `Mock ${userId}`, role: 'DEV' },
  });
}


