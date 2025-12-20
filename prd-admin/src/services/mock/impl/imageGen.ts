import { fail, ok, type ApiResponse } from '@/types/api';
import type { GenerateImageGenContract, PlanImageGenContract, RunImageGenBatchStreamContract } from '@/services/contracts/imageGen';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X1rAAAAABJRU5ErkJggg==';

export const planImageGenMock: PlanImageGenContract = async ({ text, maxItems }) => {
  const t = (text ?? '').trim();
  if (!t) return fail('CONTENT_EMPTY', 'text 不能为空') as unknown as ApiResponse<any>;

  const limit = Math.max(1, Math.min(10, maxItems ?? 10));
  const parts = t
    .split(/\n+|；|;|。|\.|,|，/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, limit);

  const items = (parts.length ? parts : [t]).slice(0, limit).map((p) => ({ prompt: p, count: 1 }));
  return ok({ total: items.length, items, usedPurpose: 'intent' as const });
};

export const generateImageGenMock: GenerateImageGenContract = async ({ prompt, n }) => {
  const p = (prompt ?? '').trim();
  if (!p) return fail('CONTENT_EMPTY', 'prompt 不能为空') as unknown as ApiResponse<any>;
  const count = Math.max(1, Math.min(4, n ?? 1));
  return ok({
    images: Array.from({ length: count }).map((_, i) => ({
      index: i,
      base64: TINY_PNG_BASE64,
      url: null,
      revisedPrompt: null,
    })),
  });
};

export const runImageGenBatchStreamMock: RunImageGenBatchStreamContract = async ({ input, onEvent, signal }) => {
  const modelId = String((input as any)?.modelId ?? '').trim() || null;
  const platformId = String((input as any)?.platformId ?? '').trim() || null;
  const modelName = String((input as any)?.modelName ?? '').trim() || null;
  const items = input?.items ?? [];
  if (items.length === 0) return fail('INVALID_FORMAT', 'items 不能为空') as unknown as ApiResponse<true>;

  const total = items.reduce((sum, it) => sum + Math.max(1, it.count || 1), 0);
  const runId = `mock_${Date.now()}`;
  onEvent({ event: 'run', data: JSON.stringify({ type: 'runStart', runId, total, modelId, platformId, modelName }) });

  let done = 0;
  let failed = 0;

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const prompt = (items[itemIndex].prompt ?? '').trim();
    const count = Math.max(1, Math.min(5, items[itemIndex].count || 1));
    for (let imageIndex = 0; imageIndex < count; imageIndex++) {
      if (signal.aborted) break;
      onEvent({ event: 'image', data: JSON.stringify({ type: 'imageStart', runId, itemIndex, imageIndex, prompt, modelId, platformId, modelName }) });
      await new Promise((r) => setTimeout(r, 60));
      if (!prompt) {
        failed += 1;
        onEvent({
          event: 'image',
          data: JSON.stringify({ type: 'imageError', runId, itemIndex, imageIndex, prompt, modelId, platformId, modelName, errorCode: 'INVALID_FORMAT', errorMessage: 'prompt 不能为空' }),
        });
        continue;
      }
      done += 1;
      onEvent({
        event: 'image',
        data: JSON.stringify({ type: 'imageDone', runId, itemIndex, imageIndex, prompt, modelId, platformId, modelName, base64: TINY_PNG_BASE64, url: null, revisedPrompt: null }),
      });
    }
  }

  onEvent({ event: 'run', data: JSON.stringify({ type: 'runDone', runId, total, done, failed, endedAt: new Date().toISOString() }) });
  return ok(true);
};

