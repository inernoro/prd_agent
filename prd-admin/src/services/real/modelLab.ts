import { apiRequest } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';
import { fail, ok, type ApiResponse } from '@/types/api';
import type {
  CreateModelLabExperimentContract,
  GetModelLabExperimentContract,
  ListModelLabExperimentsContract,
  ListModelLabModelSetsContract,
  RunModelLabStreamContract,
  UpdateModelLabExperimentContract,
  UpsertModelLabExperimentInput,
  UpsertModelLabModelSetContract,
  ModelLabParams,
  ModelLabSuite,
} from '@/services/contracts/modelLab';

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

function getApiBaseUrl() {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:5000';
  return raw.trim().replace(/\/+$/, '');
}

const defaultParams: ModelLabParams = {
  temperature: 0.2,
  maxTokens: null,
  timeoutMs: 60000,
  maxConcurrency: 3,
  repeatN: 1,
};

function normalizeSuite(s?: ModelLabSuite): ModelLabSuite | undefined {
  if (!s) return undefined;
  if (s === 'speed' || s === 'intent' || s === 'custom') return s;
  return undefined;
}

function mapSuiteToBackend(s?: ModelLabSuite): string | undefined {
  const v = normalizeSuite(s);
  if (!v) return undefined;
  if (v === 'speed') return 'Speed';
  if (v === 'intent') return 'Intent';
  return 'Custom';
}

function mapSuiteFromBackend(s: any): ModelLabSuite {
  const v = String(s ?? '').toLowerCase();
  if (v === 'intent') return 'intent';
  if (v === 'custom') return 'custom';
  return 'speed';
}

function normalizeExperimentInput(input: UpsertModelLabExperimentInput) {
  return {
    name: input.name,
    suite: mapSuiteToBackend(input.suite),
    selectedModels: input.selectedModels,
    promptTemplateId: 'promptTemplateId' in input ? input.promptTemplateId ?? null : undefined,
    promptText: 'promptText' in input ? input.promptText ?? null : undefined,
    params: input.params ? { ...defaultParams, ...input.params } : undefined,
  };
}

export const listModelLabExperimentsReal: ListModelLabExperimentsContract = async (args) => {
  const q = new URLSearchParams();
  if (args?.search) q.set('search', args.search);
  q.set('page', String(args?.page ?? 1));
  q.set('pageSize', String(args?.pageSize ?? 20));
  return await apiRequest<{ items: any[]; page: number; pageSize: number }>(`/api/v1/admin/model-lab/experiments?${q.toString()}`);
};

export const createModelLabExperimentReal: CreateModelLabExperimentContract = async (input) => {
  const res = await apiRequest<any>(`/api/v1/admin/model-lab/experiments`, { method: 'POST', body: normalizeExperimentInput(input) });
  if (!res.success) return res as any;
  // 后端返回的是 ModelLabExperiment（Suite 为枚举字符串），这里做一次 suite 映射以方便前端使用
  const exp = res.data as any;
  exp.suite = mapSuiteFromBackend(exp.suite);
  return ok(exp);
};

export const getModelLabExperimentReal: GetModelLabExperimentContract = async (id) => {
  const res = await apiRequest<any>(`/api/v1/admin/model-lab/experiments/${encodeURIComponent(id)}`);
  if (!res.success) return res as any;
  const exp = res.data as any;
  exp.suite = mapSuiteFromBackend(exp.suite);
  return ok(exp);
};

export const updateModelLabExperimentReal: UpdateModelLabExperimentContract = async (id, input) => {
  const res = await apiRequest<any>(`/api/v1/admin/model-lab/experiments/${encodeURIComponent(id)}`, { method: 'PUT', body: normalizeExperimentInput(input) });
  if (!res.success) return res as any;
  const exp = res.data as any;
  exp.suite = mapSuiteFromBackend(exp.suite);
  return ok(exp);
};

export const listModelLabModelSetsReal: ListModelLabModelSetsContract = async (args) => {
  const q = new URLSearchParams();
  if (args?.search) q.set('search', args.search);
  if (typeof args?.limit === 'number') q.set('limit', String(args.limit));
  return await apiRequest<{ items: any[] }>(`/api/v1/admin/model-lab/model-sets?${q.toString()}`);
};

export const upsertModelLabModelSetReal: UpsertModelLabModelSetContract = async (input) => {
  const res = await apiRequest<any>(`/api/v1/admin/model-lab/model-sets`, { method: 'POST', body: input });
  if (!res.success) return res as any;
  return ok(res.data as any);
};

async function readSseStream(
  res: Response,
  onEvent: (evt: { event?: string; data?: string }) => void,
  signal: AbortSignal
): Promise<void> {
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

export const runModelLabStreamReal: RunModelLabStreamContract = async ({ input, onEvent, signal }) => {
  const token = useAuthStore.getState().token;
  if (!token) return fail('UNAUTHORIZED', '未登录') as any;

  const url = joinUrl(getApiBaseUrl(), `/api/v1/admin/model-lab/runs/stream`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      experimentId: input.experimentId ?? null,
      suite: mapSuiteToBackend(input.suite),
      promptText: input.promptText ?? null,
      params: input.params ? { ...defaultParams, ...input.params } : null,
      enablePromptCache: typeof input.enablePromptCache === 'boolean' ? input.enablePromptCache : null,
      modelIds: input.modelIds ?? null,
      models: input.models ?? null,
    }),
    signal,
  });

  if (!res.ok) {
    const t = await res.text();
    return fail('HTTP_ERROR', t || `HTTP ${res.status}`) as any;
  }

  await readSseStream(res, onEvent, signal);
  return ok(true);
};


