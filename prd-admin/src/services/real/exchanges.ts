import type {
  ModelExchange,
  CreateExchangeRequest,
  UpdateExchangeRequest,
  TransformerTypeOption,
  ExchangeForPool,
  ExchangeTestResult,
  ExchangeTemplate,
} from '@/types/exchange';
import type { ApiResponse } from '@/types/api';
import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';

/** 获取所有 Exchange 配置 */
export async function getExchanges(): Promise<ApiResponse<ModelExchange[]>> {
  const res = await apiRequest<{ items: ModelExchange[] }>(api.mds.exchanges.list());
  if (!res.success) return res as unknown as ApiResponse<ModelExchange[]>;
  return { success: true, data: res.data.items ?? [], error: null };
}

/** 获取单个 Exchange 配置 */
export async function getExchange(id: string): Promise<ApiResponse<ModelExchange>> {
  return await apiRequest<ModelExchange>(api.mds.exchanges.byId(id));
}

/** 创建 Exchange */
export async function createExchange(request: CreateExchangeRequest): Promise<ApiResponse<{ id: string }>> {
  return await apiRequest<{ id: string }>(api.mds.exchanges.list(), {
    method: 'POST',
    body: request,
  });
}

/** 更新 Exchange */
export async function updateExchange(id: string, request: UpdateExchangeRequest): Promise<ApiResponse<{ id: string }>> {
  return await apiRequest<{ id: string }>(api.mds.exchanges.byId(id), {
    method: 'PUT',
    body: request,
  });
}

/** 删除 Exchange */
export async function deleteExchange(id: string): Promise<ApiResponse<{ id: string }>> {
  return await apiRequest<{ id: string }>(api.mds.exchanges.byId(id), {
    method: 'DELETE',
  });
}

/** 获取可用的转换器类型列表 */
export async function getTransformerTypes(): Promise<ApiResponse<TransformerTypeOption[]>> {
  const res = await apiRequest<{ items: TransformerTypeOption[] }>(api.mds.exchanges.transformerTypes());
  if (!res.success) return res as unknown as ApiResponse<TransformerTypeOption[]>;
  return { success: true, data: res.data.items ?? [], error: null };
}

/** 获取供模型池使用的 Exchange 精简列表 */
export async function getExchangesForPool(): Promise<ApiResponse<ExchangeForPool[]>> {
  const res = await apiRequest<{ items: ExchangeForPool[] }>(api.mds.exchanges.forPool());
  if (!res.success) return res as unknown as ApiResponse<ExchangeForPool[]>;
  return { success: true, data: res.data.items ?? [], error: null };
}

/** 测试 Exchange 转换管线 */
export async function testExchange(
  id: string,
  standardRequestBody: string,
  dryRun: boolean = false
): Promise<ApiResponse<ExchangeTestResult>> {
  return await apiRequest<ExchangeTestResult>(api.mds.exchanges.test(id), {
    method: 'POST',
    body: { standardRequestBody, dryRun },
  });
}

/** 获取导入模板列表 */
export async function getExchangeTemplates(): Promise<ApiResponse<ExchangeTemplate[]>> {
  const res = await apiRequest<{ items: ExchangeTemplate[] }>(api.mds.exchanges.templates());
  if (!res.success) return res as unknown as ApiResponse<ExchangeTemplate[]>;
  return { success: true, data: res.data.items ?? [], error: null };
}

/** 通过模板导入 Exchange */
export async function importExchangeFromTemplate(
  templateId: string,
  apiKey: string
): Promise<ApiResponse<{ id: string; name: string; modelCount?: number }>> {
  return await apiRequest<{ id: string; name: string; modelCount?: number }>(
    api.mds.exchanges.importFromTemplate(),
    {
      method: 'POST',
      body: { templateId, apiKey },
    }
  );
}

/** 一键体验 Exchange 下的某个模型（走完整转换管线，返回与 TestExchange 一致的结构） */
export async function tryExchangeModel(
  exchangeId: string,
  modelId: string,
  opts?: { prompt?: string; dryRun?: boolean }
): Promise<ApiResponse<ExchangeTestResult>> {
  return await apiRequest<ExchangeTestResult>(
    api.mds.exchanges.tryModel(exchangeId, modelId),
    {
      method: 'POST',
      body: {
        prompt: opts?.prompt,
        dryRun: opts?.dryRun ?? false,
      },
    }
  );
}
