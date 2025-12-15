import { db } from '@/services/mock/db';
import { sleep } from '@/services/mock/utils';
import { fail, ok, type ApiResponse } from '@/types/api';
import type { LLMConfig } from '@/types/admin';
import type {
  CreateLLMConfigInput,
  UpdateLLMConfigInput,
} from '@/services/contracts/llmConfigs';

function mask(key: string) {
  if (!key) return 'sk-****************';
  const prefix = key.slice(0, Math.min(3, key.length));
  return `${prefix}${'*'.repeat(16)}`;
}

export async function getLLMConfigsMock(): Promise<ApiResponse<LLMConfig[]>> {
  await sleep(240);
  return ok([...db.llmConfigs]);
}

export async function createLLMConfigMock(input: CreateLLMConfigInput): Promise<ApiResponse<LLMConfig>> {
  await sleep(320);
  if (!input.provider || !input.model || !input.apiKey) return fail('CONTENT_EMPTY', '字段缺失');

  const cfg: LLMConfig = {
    id: `c_${Date.now()}`,
    provider: input.provider,
    model: input.model,
    apiEndpoint: input.apiEndpoint,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    topP: input.topP,
    rateLimitPerMinute: input.rateLimitPerMinute,
    isActive: Boolean(input.isActive),
    apiKeyMasked: mask(input.apiKey),
  };

  if (cfg.isActive) {
    db.llmConfigs.forEach((c) => (c.isActive = false));
  }

  db.llmConfigs.unshift(cfg);
  return ok(cfg);
}

export async function updateLLMConfigMock(id: string, input: UpdateLLMConfigInput): Promise<ApiResponse<LLMConfig>> {
  await sleep(320);
  const cfg = db.llmConfigs.find((c) => c.id === id);
  if (!cfg) return fail('SESSION_NOT_FOUND', '配置不存在');

  cfg.provider = input.provider ?? cfg.provider;
  cfg.model = input.model ?? cfg.model;
  cfg.apiEndpoint = input.apiEndpoint ?? cfg.apiEndpoint;
  cfg.maxTokens = input.maxTokens ?? cfg.maxTokens;
  cfg.temperature = input.temperature ?? cfg.temperature;
  cfg.topP = input.topP ?? cfg.topP;
  cfg.rateLimitPerMinute = input.rateLimitPerMinute ?? cfg.rateLimitPerMinute;

  if (typeof input.isActive === 'boolean') {
    if (input.isActive) {
      db.llmConfigs.forEach((c) => (c.isActive = false));
    }
    cfg.isActive = input.isActive;
  }

  if (input.apiKey) {
    cfg.apiKeyMasked = mask(input.apiKey);
  }

  return ok({ ...cfg });
}

export async function deleteLLMConfigMock(id: string): Promise<ApiResponse<true>> {
  await sleep(260);
  const idx = db.llmConfigs.findIndex((c) => c.id === id);
  if (idx === -1) return fail('SESSION_NOT_FOUND', '配置不存在');
  db.llmConfigs.splice(idx, 1);
  return ok(true);
}

export async function activateLLMConfigMock(id: string): Promise<ApiResponse<true>> {
  await sleep(260);
  const cfg = db.llmConfigs.find((c) => c.id === id);
  if (!cfg) return fail('SESSION_NOT_FOUND', '配置不存在');
  db.llmConfigs.forEach((c) => (c.isActive = c.id === id));
  return ok(true);
}
