import { apiRequest } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';
import { fail, ok, type ApiResponse } from '@/types/api';
import type {
  GenerateImageGenContract,
  ImageGenBatchStreamEvent,
  PlanImageGenContract,
  RunImageGenBatchStreamContract,
} from '@/services/contracts/imageGen';

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

async function readSseStream(res: Response, onEvent: (evt: ImageGenBatchStreamEvent) => void, signal: AbortSignal): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buf.indexOf('\n\n');
      if (idx < 0) break;
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      const lines = raw.split('\n').map((l) => l.trimEnd());
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
      }
      onEvent({ event, data: dataLines.length ? dataLines.join('\n') : undefined });
    }
  }
}

export const planImageGenReal: PlanImageGenContract = async (input) => {
  return await apiRequest('/api/v1/admin/image-gen/plan', { method: 'POST', body: { text: input.text, maxItems: input.maxItems } });
};

export const generateImageGenReal: GenerateImageGenContract = async (input) => {
  return await apiRequest('/api/v1/admin/image-gen/generate', {
    method: 'POST',
    body: {
      modelId: input.modelId,
      platformId: input.platformId,
      modelName: input.modelName,
      prompt: input.prompt,
      n: input.n,
      size: input.size,
      responseFormat: input.responseFormat,
    },
  });
};

export const runImageGenBatchStreamReal: RunImageGenBatchStreamContract = async ({ input, onEvent, signal }) => {
  const token = useAuthStore.getState().token;
  if (!token) return fail('UNAUTHORIZED', '未登录') as unknown as ApiResponse<true>;

  const url = joinUrl(getApiBaseUrl(), '/api/v1/admin/image-gen/batch/stream');

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

  await readSseStream(res, onEvent, signal);
  return ok(true);
};

