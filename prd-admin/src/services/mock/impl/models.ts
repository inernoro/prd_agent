import { fail, ok, type ApiResponse } from '@/types/api';
import type { Model } from '@/types/admin';
import { db } from '@/services/mock/db';
import { sleep } from '@/services/mock/utils';
import type { CreateModelInput, UpdateModelInput } from '@/services/contracts/models';

export async function getModelsMock(): Promise<ApiResponse<Model[]>> {
  await sleep(240);
  return ok(db.models);
}

export async function createModelMock(input: CreateModelInput): Promise<ApiResponse<Model>> {
  await sleep(320);
  if (!input.name || !input.modelName || !input.platformId) return fail('CONTENT_EMPTY', '字段缺失');
  const platformExists = db.platforms.some((p) => p.id === input.platformId);
  if (!platformExists) return fail('INVALID_FORMAT', 'platformId 不存在');

  const m: Model = {
    id: `m_${Date.now()}`,
    name: input.name,
    modelName: input.modelName,
    platformId: input.platformId,
    enabled: input.enabled,
    isMain: false,
    isIntent: false,
    isVision: false,
    isImageGen: false,
    group: input.group,
    enablePromptCache: typeof input.enablePromptCache === 'boolean' ? input.enablePromptCache : true,
    maxTokens: typeof input.maxTokens === 'number' ? input.maxTokens : null,
  };

  db.models.unshift(m);
  return ok(m);
}

export async function updateModelMock(id: string, input: UpdateModelInput): Promise<ApiResponse<Model>> {
  await sleep(320);
  const m = db.models.find((x) => x.id === id);
  if (!m) return fail('SESSION_NOT_FOUND', '模型不存在');

  if (input.platformId) {
    const platformExists = db.platforms.some((p) => p.id === input.platformId);
    if (!platformExists) return fail('INVALID_FORMAT', 'platformId 不存在');
    m.platformId = input.platformId;
  }
  m.name = input.name ?? m.name;
  m.modelName = input.modelName ?? m.modelName;
  m.group = input.group ?? m.group;
  if (typeof input.enabled === 'boolean') m.enabled = input.enabled;
  if (typeof (input as any).enablePromptCache === 'boolean') (m as any).enablePromptCache = (input as any).enablePromptCache;
  if ('maxTokens' in (input as any)) (m as any).maxTokens = (input as any).maxTokens ?? null;

  if (typeof input.isMain === 'boolean') {
    if (input.isMain) {
      db.models.forEach((x) => (x.isMain = x.id === id));
    } else {
      m.isMain = false;
    }
  }

  return ok({ ...m });
}

export async function deleteModelMock(id: string): Promise<ApiResponse<true>> {
  await sleep(260);
  const idx = db.models.findIndex((x) => x.id === id);
  if (idx === -1) return fail('SESSION_NOT_FOUND', '模型不存在');
  db.models.splice(idx, 1);
  return ok(true);
}

export async function setMainModelMock(id: string): Promise<ApiResponse<true>> {
  await sleep(260);
  const exists = db.models.some((x) => x.id === id);
  if (!exists) return fail('SESSION_NOT_FOUND', '模型不存在');
  db.models.forEach((x) => (x.isMain = x.id === id));
  return ok(true);
}

export async function setIntentModelMock(id: string): Promise<ApiResponse<true>> {
  await sleep(260);
  const exists = db.models.some((x) => x.id === id);
  if (!exists) return fail('SESSION_NOT_FOUND', '模型不存在');
  db.models.forEach((x) => (x.isIntent = x.id === id));
  return ok(true);
}

export async function setVisionModelMock(id: string): Promise<ApiResponse<true>> {
  await sleep(260);
  const exists = db.models.some((x) => x.id === id);
  if (!exists) return fail('SESSION_NOT_FOUND', '模型不存在');
  db.models.forEach((x) => (x.isVision = x.id === id));
  return ok(true);
}

export async function setImageGenModelMock(id: string): Promise<ApiResponse<true>> {
  await sleep(260);
  const exists = db.models.some((x) => x.id === id);
  if (!exists) return fail('SESSION_NOT_FOUND', '模型不存在');
  db.models.forEach((x) => (x.isImageGen = x.id === id));
  return ok(true);
}

export async function testModelMock(id: string): Promise<ApiResponse<{ success: boolean; duration: number; error?: string }>> {
  await sleep(520);
  const m = db.models.find((x) => x.id === id);
  if (!m) return fail('SESSION_NOT_FOUND', '模型不存在');
  if (!m.enabled) return ok({ success: false, duration: 12, error: '模型未启用' });
  const duration = 120 + Math.floor(Math.random() * 560);
  const okRate = 0.92;
  if (Math.random() > okRate) return ok({ success: false, duration, error: 'mock: 连接失败' });
  return ok({ success: true, duration });
}
