import { api } from '@/services/api';
import { readSseStream } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';
import { apiRequest } from './apiClient';
import type {
  StreamTapdBugPreviewContract,
  SubmitTapdBugContract,
  TapdBugDraft,
  TapdBugSubmitResult,
} from '@/services/contracts/tapdBugAgent';

function parseJson<T>(raw?: string): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const streamTapdBugPreviewReal: StreamTapdBugPreviewContract = async (input, handlers, signal) => {
  const token = useAuthStore.getState().token;
  if (!token) throw new Error('未登录');

  const controller = signal ? null : new AbortController();
  const activeSignal = signal ?? controller!.signal;
  let latestDraft: TapdBugDraft | null = null;
  let latestError: string | null = null;

  const res = await fetch(api.tapdBugAgent.previewStream(), {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Client': 'admin',
      'X-App-Name': 'tapd-bug-agent',
    },
    body: JSON.stringify(input),
    signal: activeSignal,
  });

  if (!res.ok) {
    throw new Error(`预览生成失败（HTTP ${res.status}）`);
  }

  await readSseStream(res, (evt) => {
    const eventName = evt.event || 'message';
    if (eventName === 'stage') {
      const data = parseJson<{ stage?: string; message?: string }>(evt.data);
      handlers?.onStage?.(data?.stage || '', data?.message || '');
      return;
    }
    if (eventName === 'model') {
      const data = parseJson<{ model?: string; platform?: string }>(evt.data);
      handlers?.onModel?.(data?.model || '', data?.platform);
      return;
    }
    if (eventName === 'thinking') {
      const data = parseJson<{ text?: string }>(evt.data);
      handlers?.onThinking?.(data?.text || '');
      return;
    }
    if (eventName === 'typing') {
      const data = parseJson<{ text?: string }>(evt.data);
      handlers?.onTyping?.(data?.text || '');
      return;
    }
    if (eventName === 'draft') {
      const data = parseJson<TapdBugDraft>(evt.data);
      if (data) {
        latestDraft = data;
        handlers?.onDraft?.(data);
      }
      return;
    }
    if (eventName === 'error') {
      const data = parseJson<{ message?: string }>(evt.data);
      latestError = data?.message || '预览生成失败';
    }
  }, activeSignal);

  if (latestError) throw new Error(latestError);
  if (!latestDraft) throw new Error('未生成缺陷草稿');
  return latestDraft;
};

export const submitTapdBugReal: SubmitTapdBugContract = async (input) => {
  return await apiRequest<{ result: TapdBugSubmitResult }>(
    api.tapdBugAgent.submit(),
    { method: 'POST', body: input }
  );
};
