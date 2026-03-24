import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { fail, ok, type ApiResponse } from '@/types/api';
import type {
  CancelImageGenRunContract,
  ClarifyImageGenPromptContract,
  CreateImageGenRunContract,
  GenerateImageGenContract,
  GetImageGenSizeCapsContract,
  GetImageGenRunContract,
  PlanImageGenContract,
  RunImageGenBatchStreamContract,
  RunImageGenRunStreamContract,
  StreamImageGenRunWithRetryContract,
} from '@/services/contracts/imageGen';
import { connectSse } from '@/lib/useSseStream';

export const planImageGenReal: PlanImageGenContract = async (input) => {
  return await apiRequest(api.visualAgent.imageGen.plan(), {
    method: 'POST',
    body: { text: input.text, maxItems: input.maxItems, systemPromptOverride: input.systemPromptOverride },
  });
};

export const clarifyImageGenPromptReal: ClarifyImageGenPromptContract = async (input) => {
  return await apiRequest(api.visualAgent.imageGen.clarify(), {
    method: 'POST',
    body: { prompt: input.prompt, hasReferenceImage: input.hasReferenceImage ?? false },
  });
};

export const generateImageGenReal: GenerateImageGenContract = async (input) => {
  return await apiRequest(api.visualAgent.imageGen.generate(), {
    method: 'POST',
    body: {
      modelId: input.modelId,
      platformId: input.platformId,
      modelName: input.modelName,
      prompt: input.prompt,
      n: input.n,
      size: input.size,
      responseFormat: input.responseFormat,
      initImageBase64: input.initImageBase64,
      initImageUrl: input.initImageUrl,
      initImageAssetSha256: input.initImageAssetSha256,
    },
  });
};

export const runImageGenBatchStreamReal: RunImageGenBatchStreamContract = async ({ input, onEvent, signal }) => {
  const result = await connectSse({
    url: api.visualAgent.imageGen.batch.stream(),
    method: 'POST',
    body: input ?? {},
    onEvent,
    signal,
  });
  return (result.success ? ok(true) : fail(result.errorCode!, result.errorMessage!)) as unknown as ApiResponse<true>;
};

export const getImageGenSizeCapsReal: GetImageGenSizeCapsContract = async (input) => {
  const includeFallback = Boolean(input?.includeFallback);
  const qs = includeFallback ? '?includeFallback=true' : '';
  return await apiRequest(`${api.visualAgent.imageGen.sizeCaps()}${qs}`, { method: 'GET' });
};

export const createImageGenRunReal: CreateImageGenRunContract = async ({ input, idempotencyKey }) => {
  const headers: Record<string, string> = {};
  const idem = String(idempotencyKey ?? '').trim();
  if (idem) headers['Idempotency-Key'] = idem;
  return await apiRequest(api.visualAgent.imageGen.runs.create(), { method: 'POST', body: input, headers });
};

export const getImageGenRunReal: GetImageGenRunContract = async ({ runId, includeItems = true, includeImages = false }) => {
  const rid = encodeURIComponent(String(runId ?? '').trim());
  const qs = `?includeItems=${includeItems ? 'true' : 'false'}&includeImages=${includeImages ? 'true' : 'false'}`;
  return await apiRequest(`${api.visualAgent.imageGen.runs.byId(rid)}${qs}`, { method: 'GET' });
};

export const cancelImageGenRunReal: CancelImageGenRunContract = async ({ runId }) => {
  const rid = encodeURIComponent(String(runId ?? '').trim());
  return await apiRequest(api.visualAgent.imageGen.runs.cancel(rid), { method: 'POST' });
};

export const runImageGenRunStreamReal: RunImageGenRunStreamContract = async ({ runId, afterSeq, onEvent, signal }) => {
  const rid = encodeURIComponent(String(runId ?? '').trim());
  const a = Number(afterSeq ?? 0);
  const qs = a > 0 ? `?afterSeq=${encodeURIComponent(String(a))}` : '';
  const url = `${api.visualAgent.imageGen.runs.byId(rid)}/stream${qs}`;

  const result = await connectSse({ url, method: 'GET', onEvent, signal });
  return (result.success ? ok(true) : fail(result.errorCode!, result.errorMessage!)) as unknown as ApiResponse<true>;
};

export const streamImageGenRunWithRetryReal: StreamImageGenRunWithRetryContract = async ({ runId, afterSeq, onEvent, signal, maxAttempts }) => {
  let lastSeq = Math.max(0, Number(afterSeq ?? 0) || 0);
  let attempt = 0;
  const max = Math.max(1, Math.min(50, Number(maxAttempts ?? 10) || 10));

  while (!signal.aborted) {
    attempt += 1;

    // 子 AbortController：用于每次连接独立取消
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort);

    const res = await runImageGenRunStreamReal({
      runId,
      afterSeq: lastSeq,
      signal: ac.signal,
      onEvent: (evt) => {
        onEvent(evt);
        const id = evt.id ? Number(evt.id) : NaN;
        if (Number.isFinite(id) && id > lastSeq) lastSeq = id;
      },
    });

    signal.removeEventListener('abort', onAbort);

    if (res.success) return ok(true);
    if (signal.aborted) return ok(true);
    if (attempt >= max) return res;

    // 指数退避 + jitter（上限 8s）
    const pow = Math.min(5, attempt); // 2^1..2^5
    const base = Math.min(8000, 400 * Math.pow(2, pow));
    const jitter = Math.floor(Math.random() * 240);
    await new Promise((r) => setTimeout(r, base + jitter));
  }

  return ok(true);
};

