import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import type { ModelGroupForApp } from '@/types/modelGroup';
import type { ModelAdapterInfo } from '@/services/contracts/models';
import type { ImageGenGenerateResponse } from '@/services/contracts/imageGen';
import {
  createLiteraryAgentImageGenRunReal,
  getLiteraryAgentImageGenModelsReal,
  streamLiteraryAgentImageGenRunWithRetryReal,
} from '@/services/real/literaryAgentConfig';

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
  appKey?: 'visual-agent' | 'literary-agent';
}): Promise<ApiResponse<{ url: string; revisedPrompt?: string }>> {
  if (p.appKey === 'literary-agent') {
    const created = await createLiteraryAgentImageGenRunReal({
      input: {
        items: [{ prompt: p.prompt, count: 1, size: p.size }],
        size: p.size,
        modelId: p.modelName,
        responseFormat: 'url',
        maxConcurrency: 1,
      },
      idempotencyKey: `doc-literary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });

    if (!created.success) {
      return created as unknown as ApiResponse<{ url: string; revisedPrompt?: string }>;
    }

    const runId = created.data.runId;
    return await new Promise<ApiResponse<{ url: string; revisedPrompt?: string }>>((resolve) => {
      const ac = new AbortController();
      let settled = false;
      const finish = (result: ApiResponse<{ url: string; revisedPrompt?: string }>) => {
        if (settled) return;
        settled = true;
        ac.abort();
        resolve(result);
      };

      void streamLiteraryAgentImageGenRunWithRetryReal({
        runId,
        afterSeq: 0,
        signal: ac.signal,
        maxAttempts: 10,
        onEvent: (evt) => {
          if (settled) return;
          if (evt.event === 'error') {
            let message = '图片生成失败';
            try {
              const payload = JSON.parse(evt.data || '{}') as { message?: string; errorMessage?: string };
              message = payload.message || payload.errorMessage || message;
            } catch { /* ignore malformed SSE payload */ }
            finish({ success: false, data: null as never, error: { code: 'IMAGE_GEN_FAILED', message } });
            return;
          }
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(evt.data || '{}') as Record<string, unknown>;
          } catch {
            return;
          }
          const type = typeof payload.type === 'string' ? payload.type : '';
          if (type === 'imageDone') {
            const asset = payload.asset && typeof payload.asset === 'object' ? payload.asset as Record<string, unknown> : null;
            const url = typeof payload.url === 'string' ? payload.url : (typeof asset?.url === 'string' ? asset.url : '');
            if (url) {
              finish({
                success: true,
                data: {
                  url,
                  revisedPrompt: typeof payload.revisedPrompt === 'string' ? payload.revisedPrompt : undefined,
                },
                error: null,
              });
            }
          } else if (type === 'runDone') {
            const failed = Number(payload.failed ?? 0);
            const status = String(payload.status ?? '');
            if (failed > 0 || status === 'Failed' || status === 'Cancelled') {
              finish({
                success: false,
                data: null as never,
                error: { code: 'IMAGE_GEN_FAILED', message: status === 'Cancelled' ? '图片生成已取消' : '图片生成失败' },
              });
            }
          }
        },
      }).then((res) => {
        if (!settled && !res.success) {
          finish(res as unknown as ApiResponse<{ url: string; revisedPrompt?: string }>);
        } else if (!settled) {
          finish({
            success: false,
            data: null as never,
            error: { code: 'IMAGE_GEN_NO_RESULT', message: '图片生成结束但未收到图片结果' },
          });
        }
      });
    });
  }

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
 * 获取生图可用模型列表（按 appKey 使用对应模型池）。
 * 返回 { value: modelId, label: modelId }[] 去重列表。
 */
export async function listVisualModels(appKey: 'visual-agent' | 'literary-agent' = 'visual-agent'): Promise<ApiResponse<{ value: string; label: string }[]>> {
  const res = appKey === 'literary-agent'
    ? await getLiteraryAgentImageGenModelsReal() as ApiResponse<ModelGroupForApp[]>
    : await apiRequest<ModelGroupForApp[]>(api.visualAgent.imageGen.models(), {
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
