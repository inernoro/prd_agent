import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import { fail, ok, type ApiResponse } from '@/types/api';
import type {
  CancelImageGenRunContract,
  CreateImageGenRunContract,
  GenerateImageGenContract,
  ImageGenBatchStreamEvent,
  ImageGenRunStreamEvent,
  GetImageGenSizeCapsContract,
  GetImageGenRunContract,
  PlanImageGenContract,
  RunImageGenBatchStreamContract,
  RunImageGenRunStreamContract,
  StreamImageGenRunWithRetryContract,
} from '@/services/contracts/imageGen';
import { readSseStream } from '@/lib/sse';

function getApiBaseUrl() {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:5000';
  return raw.trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

async function readImageGenSseStream(
  res: Response,
  onEvent: (evt: ImageGenBatchStreamEvent) => void,
  signal: AbortSignal
): Promise<void> {
  await readSseStream(res, onEvent, signal);
}

async function readImageGenRunSseStream(
  res: Response,
  onEvent: (evt: ImageGenRunStreamEvent) => void,
  signal: AbortSignal
): Promise<void> {
  await readSseStream(res, onEvent, signal);
}

export const planImageGenReal: PlanImageGenContract = async (input) => {
  return await apiRequest(api.visualAgent.imageGen.plan(), {
    method: 'POST',
    body: { text: input.text, maxItems: input.maxItems, systemPromptOverride: input.systemPromptOverride },
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
  const token = useAuthStore.getState().token;
  if (!token) return fail('UNAUTHORIZED', '未登录') as unknown as ApiResponse<true>;

  const url = joinUrl(getApiBaseUrl(), api.visualAgent.imageGen.batch.stream());

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input ?? {}),
      signal,
    });
  } catch (e) {
    return fail('NETWORK_ERROR', e instanceof Error ? e.message : '网络错误') as unknown as ApiResponse<true>;
  }

  if (res.status === 401) {
    const authStore = useAuthStore.getState();
    if (authStore.isAuthenticated) {
      authStore.logout();
      window.location.href = '/login';
    }
    return fail('UNAUTHORIZED', '未登录') as unknown as ApiResponse<true>;
  }

  if (!res.ok) {
    const t = await res.text();
    return fail('UNKNOWN', t || `HTTP ${res.status} ${res.statusText}`) as unknown as ApiResponse<true>;
  }

  try {
    await readImageGenSseStream(res, onEvent, signal);
  } catch (e) {
    if (signal.aborted) return ok(true);
    return fail('NETWORK_ERROR', e instanceof Error ? e.message : 'SSE 读取失败') as unknown as ApiResponse<true>;
  }
  return ok(true);
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
  const token = useAuthStore.getState().token;
  if (!token) return fail('UNAUTHORIZED', '未登录') as unknown as ApiResponse<true>;

  const rid = encodeURIComponent(String(runId ?? '').trim());
  const a = Number(afterSeq ?? 0);
  const qs = a > 0 ? `?afterSeq=${encodeURIComponent(String(a))}` : '';
  const url = joinUrl(getApiBaseUrl(), `${api.visualAgent.imageGen.runs.byId(rid)}/stream${qs}`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      signal,
    });
  } catch (e) {
    return fail('NETWORK_ERROR', e instanceof Error ? e.message : '网络错误') as unknown as ApiResponse<true>;
  }

  if (res.status === 401) {
    const authStore = useAuthStore.getState();
    if (authStore.isAuthenticated) {
      authStore.logout();
      window.location.href = '/login';
    }
    return fail('UNAUTHORIZED', '未登录') as unknown as ApiResponse<true>;
  }

  if (!res.ok) {
    const t = await res.text();
    return fail('UNKNOWN', t || `HTTP ${res.status} ${res.statusText}`) as unknown as ApiResponse<true>;
  }

  try {
    await readImageGenRunSseStream(res, onEvent, signal);
  } catch (e) {
    if (signal.aborted) return ok(true);
    return fail('NETWORK_ERROR', e instanceof Error ? e.message : 'SSE 读取失败') as unknown as ApiResponse<true>;
  }
  return ok(true);
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

