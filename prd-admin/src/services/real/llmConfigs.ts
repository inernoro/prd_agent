import { apiRequest } from '@/services/real/apiClient';
import { fail, ok, type ApiResponse } from '@/types/api';
import type {
  ActivateLLMConfigContract,
  CreateLLMConfigContract,
  CreateLLMConfigInput,
  DeleteLLMConfigContract,
  GetLLMConfigsContract,
  UpdateLLMConfigContract,
  UpdateLLMConfigInput,
} from '@/services/contracts/llmConfigs';
import type { LLMConfig } from '@/types/admin';

export const getLLMConfigsReal: GetLLMConfigsContract = async (): Promise<ApiResponse<LLMConfig[]>> => {
  return await apiRequest<LLMConfig[]>(`/api/mds/llm-configs`);
};

type BackendCreateResponse = { id: string };
type BackendUpdateResponse = { configId: string };

async function refetchConfig(configId: string): Promise<ApiResponse<LLMConfig>> {
  const listRes = await getLLMConfigsReal();
  if (!listRes.success) return listRes as unknown as ApiResponse<LLMConfig>;
  const found = listRes.data.find((c) => c.id === configId);
  if (!found) return fail('UNKNOWN', '创建/更新成功但未在列表中找到配置') as unknown as ApiResponse<LLMConfig>;
  return ok(found);
}

export const createLLMConfigReal: CreateLLMConfigContract = async (input: CreateLLMConfigInput): Promise<ApiResponse<LLMConfig>> => {
  const res = await apiRequest<BackendCreateResponse>(`/api/mds/llm-configs`, {
    method: 'POST',
    body: input,
  });
  if (!res.success) return res as unknown as ApiResponse<LLMConfig>;
  return await refetchConfig(res.data.id);
};

export const updateLLMConfigReal: UpdateLLMConfigContract = async (id: string, input: UpdateLLMConfigInput): Promise<ApiResponse<LLMConfig>> => {
  // 后端 Update 接口是“全量字段模型”，这里先取旧值做 merge，避免缺字段被默认值覆盖
  const listRes = await getLLMConfigsReal();
  if (!listRes.success) return listRes as unknown as ApiResponse<LLMConfig>;
  const current = listRes.data.find((c) => c.id === id);
  if (!current) return fail('UNKNOWN', '配置不存在') as unknown as ApiResponse<LLMConfig>;

  const body = {
    model: input.model ?? current.model ?? '',
    apiKey: input.apiKey,
    apiEndpoint: input.apiEndpoint ?? current.apiEndpoint,
    maxTokens: input.maxTokens ?? current.maxTokens ?? 4096,
    temperature: input.temperature ?? current.temperature ?? 0.7,
    topP: input.topP ?? current.topP ?? 0.95,
    rateLimitPerMinute: input.rateLimitPerMinute ?? current.rateLimitPerMinute ?? 60,
    isActive: input.isActive ?? current.isActive ?? false,
    enablePromptCache: input.enablePromptCache ?? current.enablePromptCache ?? true,
  };

  const res = await apiRequest<BackendUpdateResponse>(`/api/mds/llm-configs/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body,
  });
  if (!res.success) return res as unknown as ApiResponse<LLMConfig>;
  return await refetchConfig(res.data.configId ?? id);
};

export const deleteLLMConfigReal: DeleteLLMConfigContract = async (id: string): Promise<ApiResponse<true>> => {
  const res = await apiRequest<true>(`/api/mds/llm-configs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    emptyResponseData: true,
  });
  if (!res.success) return res;
  return ok(true);
};

export const activateLLMConfigReal: ActivateLLMConfigContract = async (id: string): Promise<ApiResponse<true>> => {
  const res = await apiRequest<unknown>(`/api/mds/llm-configs/${encodeURIComponent(id)}/activate`, {
    method: 'POST',
    body: {},
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};




