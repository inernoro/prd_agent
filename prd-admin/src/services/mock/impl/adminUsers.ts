import { db } from '@/services/mock/db';
import { ok, fail, type ApiResponse } from '@/types/api';
import type { AdminUser, PagedResult, UserRole, UserStatus } from '@/types/admin';
import { randomFail, sleep } from '@/services/mock/utils';

export async function getUsersMock(params: {
  page: number;
  pageSize: number;
  search?: string;
  role?: UserRole;
  status?: UserStatus;
}): Promise<ApiResponse<PagedResult<AdminUser>>> {
  await sleep(320);
  const maybe = randomFail<ApiResponse<PagedResult<AdminUser>>>(0.01);
  if (maybe) return maybe;

  const { page, pageSize } = params;
  if (page <= 0 || pageSize <= 0) return fail('INVALID_FORMAT', '分页参数不合法');

  const s = params.search?.trim().toLowerCase();

  let list = [...db.users];
  if (s) {
    list = list.filter((u) => u.username.toLowerCase().includes(s) || u.displayName.toLowerCase().includes(s));
  }
  if (params.role) list = list.filter((u) => u.role === params.role);
  if (params.status) list = list.filter((u) => u.status === params.status);

  const total = list.length;
  const start = (page - 1) * pageSize;
  const items = list.slice(start, start + pageSize);

  return ok({ items, total });
}

export async function updateUserRoleMock(userId: string, role: UserRole): Promise<ApiResponse<true>> {
  await sleep(220);
  const u = db.users.find((x) => x.userId === userId);
  if (!u) return fail('SESSION_NOT_FOUND', '用户不存在');
  u.role = role;
  return ok(true);
}

export async function updateUserStatusMock(userId: string, status: UserStatus): Promise<ApiResponse<true>> {
  await sleep(220);
  const u = db.users.find((x) => x.userId === userId);
  if (!u) return fail('SESSION_NOT_FOUND', '用户不存在');
  u.status = status;
  return ok(true);
}

export async function updateUserPasswordMock(userId: string, password: string): Promise<ApiResponse<true>> {
  await sleep(260);
  const u = db.users.find((x) => x.userId === userId);
  if (!u) return fail('SESSION_NOT_FOUND', '用户不存在');
  if (!password || password.length < 8) return fail('WEAK_PASSWORD', '密码强度不足');
  // mock 模式不存储密码，仅模拟成功
  return ok(true);
}

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]!;
  return out;
}

export async function generateInviteCodesMock(count: number): Promise<ApiResponse<{ codes: string[] }>> {
  await sleep(260);
  const n = Math.max(1, Math.min(50, Math.floor(count || 1)));
  return ok({ codes: Array.from({ length: n }).map(() => genCode()) });
}
