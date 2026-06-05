import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import type { ModelGroupForApp } from '@/types/modelGroup';
import type { ModelAdapterInfo } from '@/services/contracts/models';
import type { ImageGenGenerateResponse } from '@/services/contracts/imageGen';

// ============ Visual Creation — 视觉创作迷你面板服务层 ============
//
// 封装真实生图端点，供 VisualCreationMiniPanel 使用。
// 规则：apiRequest 内部已 JSON.stringify(body)，调用方传原始对象，禁止再 stringify。
// 返回 ApiResponse<T>，用 res.success 判断，错误信息 res.error?.message。

const FALLBACK_SIZES = ['1024x1024', '1344x768', '768x1344', '1248x832', '832x1248'];

/**
 * 生成图片（单张）。
 * - prompt: 提示词
 * - size: 尺寸字符串，如 "1024x1024"
 * - modelName: 平台侧模型 ID
 * - images: 参考图 dataURI 字符串数组（图生图场景）
 */
export async function generateVisualImage(p: {
  prompt: string;
  size?: string;
  modelName?: string;
  images?: string[];
}): Promise<ApiResponse<{ url: string; revisedPrompt?: string }>> {
  const res = await apiRequest<ImageGenGenerateResponse>(api.visualAgent.imageGen.generate(), {
    method: 'POST',
    body: {
      prompt: p.prompt,
      size: p.size,
      modelName: p.modelName,
      images: p.images,
      n: 1,
      responseFormat: 'url',
    },
  });

  if (!res.success) {
    return res as unknown as ApiResponse<{ url: string; revisedPrompt?: string }>;
  }

  const img = res.data?.images?.[0];
  return {
    success: true,
    data: { url: img?.url ?? '', revisedPrompt: img?.revisedPrompt ?? undefined },
    error: null,
  };
}

/**
 * 获取生图可用模型列表（从 visual-agent 模型池）。
 * 返回 { value: modelId, label: modelId }[] 去重列表。
 */
export async function listVisualModels(): Promise<ApiResponse<{ value: string; label: string }[]>> {
  const res = await apiRequest<ModelGroupForApp[]>(api.visualAgent.imageGen.models(), {
    method: 'GET',
  });

  if (!res.success) {
    return res as unknown as ApiResponse<{ value: string; label: string }[]>;
  }

  const seen = new Set<string>();
  const options: { value: string; label: string }[] = [];
  for (const pool of res.data ?? []) {
    for (const m of pool.models ?? []) {
      if (m.modelId && !seen.has(m.modelId)) {
        seen.add(m.modelId);
        options.push({ value: m.modelId, label: m.modelId });
      }
    }
  }

  return { success: true, data: options, error: null };
}

/**
 * 获取指定模型支持的尺寸列表。
 * 若获取失败或模型未找到适配信息，返回通用兜底尺寸。
 */
export async function listVisualSizes(modelName?: string): Promise<string[]> {
  if (!modelName) return FALLBACK_SIZES;

  try {
    const res = await apiRequest<ModelAdapterInfo>(
      api.visualAgent.imageGen.adapterInfo(modelName),
      { method: 'GET' },
    );

    if (!res.success || !res.data) return FALLBACK_SIZES;

    const info = res.data;

    // isAdaptive 表示尺寸由 prompt 决定，不应展示尺寸选择器，返回空列表
    if (info.isAdaptive) return [];

    const byResolution = info.sizesByResolution;
    if (!byResolution || typeof byResolution !== 'object') return FALLBACK_SIZES;

    const seen = new Set<string>();
    const sizes: string[] = [];
    for (const group of Object.values(byResolution)) {
      for (const entry of group) {
        if (entry.size && !seen.has(entry.size)) {
          seen.add(entry.size);
          sizes.push(entry.size);
        }
      }
    }

    return sizes.length > 0 ? sizes : FALLBACK_SIZES;
  } catch {
    return FALLBACK_SIZES;
  }
}

/**
 * 将 File 读取为 dataURI 字符串（用于参考图传参）。
 */
export function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}
