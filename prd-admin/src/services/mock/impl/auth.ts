import { ok, fail, type ApiResponse } from '@/types/api';
import type { LoginResponse } from '@/services/contracts/auth';
import { sleep } from '@/services/mock/utils';

export async function loginMock(username: string, password: string): Promise<ApiResponse<LoginResponse>> {
  await sleep(450);

  const u = username.trim();
  if (!u || !password) return fail('CONTENT_EMPTY', '用户名或密码为空');

  if (u !== 'admin' || password !== 'admin') {
    return fail('UNAUTHORIZED', '账号或密码错误');
  }

  return ok({
    user: { userId: 'u_1', username: 'admin', displayName: 'Admin', role: 'ADMIN' },
    accessToken: `mock-jwt-${Date.now()}`,
  });
}
