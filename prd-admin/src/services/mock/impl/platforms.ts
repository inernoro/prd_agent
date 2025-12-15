import { fail, ok, type ApiResponse } from '@/types/api';
import type { Platform } from '@/types/admin';
import { db } from '@/services/mock/db';
import { sleep } from '@/services/mock/utils';
import type { CreatePlatformInput, UpdatePlatformInput } from '@/services/contracts/platforms';

export async function getPlatformsMock(): Promise<ApiResponse<Platform[]>> {
  await sleep(240);
  return ok(db.platforms);
}

function mask(key: string) {
  if (!key) return 'sk-****************';
  const prefix = key.slice(0, Math.min(3, key.length));
  return `${prefix}${'*'.repeat(16)}`;
}

export async function createPlatformMock(input: CreatePlatformInput): Promise<ApiResponse<Platform>> {
  await sleep(320);
  if (!input.name || !input.platformType || !input.apiUrl || !input.apiKey) return fail('CONTENT_EMPTY', '字段缺失');
  const p: Platform = {
    id: `p_${Date.now()}`,
    name: input.name,
    platformType: input.platformType,
    apiUrl: input.apiUrl,
    apiKeyMasked: mask(input.apiKey),
    enabled: input.enabled,
  };
  db.platforms.unshift(p);
  return ok(p);
}

export async function updatePlatformMock(id: string, input: UpdatePlatformInput): Promise<ApiResponse<Platform>> {
  await sleep(320);
  const p = db.platforms.find((x) => x.id === id);
  if (!p) return fail('SESSION_NOT_FOUND', '平台不存在');

  p.name = input.name ?? p.name;
  p.platformType = input.platformType ?? p.platformType;
  p.apiUrl = input.apiUrl ?? p.apiUrl;
  if (typeof input.enabled === 'boolean') p.enabled = input.enabled;
  if (input.apiKey) p.apiKeyMasked = mask(input.apiKey);

  return ok({ ...p });
}

export async function deletePlatformMock(id: string): Promise<ApiResponse<true>> {
  await sleep(260);
  const hasModels = db.models.some((m) => m.platformId === id);
  if (hasModels) return fail('PERMISSION_DENIED', '平台下存在模型，无法删除');
  const idx = db.platforms.findIndex((x) => x.id === id);
  if (idx === -1) return fail('SESSION_NOT_FOUND', '平台不存在');
  db.platforms.splice(idx, 1);
  return ok(true);
}
