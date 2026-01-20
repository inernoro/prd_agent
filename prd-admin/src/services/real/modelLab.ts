import type {
  CreateModelLabExperimentContract,
  DeleteModelLabExperimentContract,
  GetModelLabExperimentContract,
  ListModelLabExperimentsContract,
  ListModelLabModelSetsContract,
  ModelLabExperiment,
  ModelLabModelSet,
  ModelLabSuite,
  RunModelLabStreamContract,
  RunModelLabStreamEvent,
  UpsertModelLabExperimentInput,
  UpdateModelLabExperimentContract,
  UpsertModelLabModelSetContract,
} from '@/services/contracts/modelLab';
import { apiRequest } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';
import { fail, ok, type ApiResponse } from '@/types/api';

function normalizeSuiteFromApi(x: unknown): ModelLabSuite {
  if (typeof x === 'string') {
    const s = x.trim();
    const lower = s.toLowerCase();
    if (lower === 'speed' || lower === 'intent' || lower === 'custom') return lower;
    // 兼容后端 PascalCase（Speed/Intent/Custom）
    if (s === 'Speed') return 'speed';
    if (s === 'Intent') return 'intent';
    if (s === 'Custom') return 'custom';
  }
  if (typeof x === 'number') {
    if (x === 0) return 'speed';
    if (x === 1) return 'intent';
    if (x === 2) return 'custom';
  }
  return 'speed';
}

function toApiSuite(x: unknown): string | undefined {
  const n = normalizeSuiteFromApi(x);
  if (n === 'speed') return 'Speed';
  if (n === 'intent') return 'Intent';
  if (n === 'custom') return 'Custom';
  return undefined;
}

function normalizeExperimentFromApi(exp: unknown): ModelLabExperiment {
  const e = (exp ?? {}) as any;
  return {
    ...e,
    suite: normalizeSuiteFromApi(e.suite),
  } as ModelLabExperiment;
}

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

async function readSseStream(res: Response, onEvent: (evt: RunModelLabStreamEvent) => void, signal: AbortSignal): Promise<void> {
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

export const listModelLabExperimentsReal: ListModelLabExperimentsContract = async (args) => {
  const sp = new URLSearchParams();
  if (args?.search) sp.set('search', args.search);
  if (typeof args?.page === 'number') sp.set('page', String(args.page));
  if (typeof args?.pageSize === 'number') sp.set('pageSize', String(args.pageSize));

  const qs = sp.toString();
  const res = await apiRequest<{ items: ModelLabExperiment[]; page: number; pageSize: number }>(
    `/api/lab/model/experiments${qs ? `?${qs}` : ''}`
  );

  if (!res.success) return res;
  return ok({
    items: Array.isArray(res.data.items) ? res.data.items.map((x) => normalizeExperimentFromApi(x)) : [],
    page: res.data.page,
    pageSize: res.data.pageSize,
  });
};

export const createModelLabExperimentReal: CreateModelLabExperimentContract = async (input) => {
  // 后端允许部分字段；缺失字段会使用默认值
  const res = await apiRequest<ModelLabExperiment>('/api/lab/model/experiments', {
    method: 'POST',
    body: {
      name: input.name,
      suite: toApiSuite(input.suite) ?? toApiSuite('speed'),
      selectedModels: input.selectedModels,
      promptTemplateId: 'promptTemplateId' in input ? input.promptTemplateId : undefined,
      promptText: 'promptText' in input ? input.promptText : undefined,
      params: input.params,
    },
  });
  if (!res.success) return res;
  return ok(normalizeExperimentFromApi(res.data));
};

export const getModelLabExperimentReal: GetModelLabExperimentContract = async (id: string) => {
  const res = await apiRequest<ModelLabExperiment>(`/api/lab/model/experiments/${encodeURIComponent(id)}`);
  if (!res.success) return res;
  return ok(normalizeExperimentFromApi(res.data));
};

export const updateModelLabExperimentReal: UpdateModelLabExperimentContract = async (id: string, input: UpsertModelLabExperimentInput) => {
  // 后端 PUT 对 Params 是整体替换；这里先拉取现有实验并合并，避免 params 部分更新导致字段回退到默认值
  const current = await apiRequest<ModelLabExperiment>(`/api/lab/model/experiments/${encodeURIComponent(id)}`);
  if (!current.success) return current as unknown as ApiResponse<ModelLabExperiment>;

  const exp = normalizeExperimentFromApi(current.data);
  const mergedParams = {
    temperature: input.params?.temperature ?? exp.params.temperature,
    maxTokens: 'maxTokens' in (input.params ?? {}) ? (input.params?.maxTokens ?? null) : (exp.params.maxTokens ?? null),
    timeoutMs: input.params?.timeoutMs ?? exp.params.timeoutMs,
    maxConcurrency: input.params?.maxConcurrency ?? exp.params.maxConcurrency,
    repeatN: input.params?.repeatN ?? exp.params.repeatN,
  };

  const body: Record<string, unknown> = {
    name: input.name ?? exp.name,
    suite: toApiSuite(input.suite ?? exp.suite),
    selectedModels: input.selectedModels ?? exp.selectedModels,
    promptTemplateId: 'promptTemplateId' in input ? input.promptTemplateId ?? null : (exp.promptTemplateId ?? null),
    promptText: 'promptText' in input ? input.promptText ?? null : (exp.promptText ?? null),
    params: mergedParams,
  };

  const updated = await apiRequest<ModelLabExperiment>(`/api/lab/model/experiments/${encodeURIComponent(id)}`, { method: 'PUT', body });
  if (!updated.success) return updated;
  return ok(normalizeExperimentFromApi(updated.data));
};

export const deleteModelLabExperimentReal: DeleteModelLabExperimentContract = async (id: string) => {
  return await apiRequest<true>(`/api/lab/model/experiments/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

export const listModelLabModelSetsReal: ListModelLabModelSetsContract = async (args) => {
  const sp = new URLSearchParams();
  if (args?.search) sp.set('search', args.search);
  if (typeof args?.limit === 'number') sp.set('limit', String(args.limit));
  const qs = sp.toString();
  return await apiRequest<{ items: ModelLabModelSet[] }>(`/api/lab/model/model-sets${qs ? `?${qs}` : ''}`);
};

export const upsertModelLabModelSetReal: UpsertModelLabModelSetContract = async (input) => {
  return await apiRequest<ModelLabModelSet>('/api/lab/model/model-sets', {
    method: 'POST',
    body: { id: input.id, name: input.name, models: input.models },
  });
};

export const runModelLabStreamReal: RunModelLabStreamContract = async ({ input, onEvent, signal }) => {
  const token = useAuthStore.getState().token;
  if (!token) return fail('UNAUTHORIZED', '未登录') as unknown as ApiResponse<true>;

  const url = joinUrl(getApiBaseUrl(), '/api/lab/model/runs/stream');
  const body = {
    ...(input ?? {}),
    suite: input?.suite ? toApiSuite(input.suite) : undefined,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
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

 