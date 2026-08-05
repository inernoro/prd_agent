/**
 * 通用对话智能体的前端服务层。
 *
 * 只有两类调用：普通 REST 走 apiRequest，事件流走 fetch + readSseStream
 * （EventSource 设不了 Authorization header，所以流式必须自己读）。
 */
import { api } from '@/services/api';
import { readSseStream } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';
import { apiRequest } from './apiClient';

export interface ChatSession {
  id: string;
  title: string;
  model: string | null;
  effectiveModel: string;
  running: boolean;
  eventSeq: number;
  /** 当前这一轮的起始事件序号；没有在跑时为 null。断线重连从这里起订。 */
  runningTurnStartSeq: number | null;
  createdAt: string;
  updatedAt: string;
}

export type ChatMessageStatus = 'running' | 'completed' | 'failed';

export interface ChatMessage {
  id: string;
  turnId: string;
  role: 'user' | 'assistant';
  content: string;
  status: ChatMessageStatus;
  error: string | null;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ChatTurnAccepted {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  seq: number;
}

/** 事件流推回来的一条事件。type 与后端 ChatAgentEventTypes 对齐，另加一个 idle 收流标记。 */
export interface ChatStreamEvent {
  seq: number;
  type: 'turn_started' | 'text_delta' | 'thinking' | 'usage' | 'done' | 'error' | 'log' | 'idle';
  payload: Record<string, unknown>;
}

export async function listChatSessions(): Promise<ApiResponse<{ items: ChatSession[] }>> {
  return await apiRequest<{ items: ChatSession[] }>(api.chatAgent.sessions(), { method: 'GET' });
}

export async function createChatSession(title?: string): Promise<ApiResponse<{ item: ChatSession }>> {
  // apiRequest 内部会 JSON.stringify，这里必须传原始对象
  return await apiRequest<{ item: ChatSession }>(api.chatAgent.sessions(), {
    method: 'POST',
    body: { title: title ?? null, model: null },
  });
}

export async function renameChatSession(
  id: string,
  title: string,
): Promise<ApiResponse<{ item: ChatSession }>> {
  return await apiRequest<{ item: ChatSession }>(api.chatAgent.session(encodeURIComponent(id)), {
    method: 'PATCH',
    body: { title },
  });
}

export async function deleteChatSession(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return await apiRequest<{ deleted: boolean }>(api.chatAgent.session(encodeURIComponent(id)), {
    method: 'DELETE',
  });
}

export async function listChatMessages(
  id: string,
  limit = 200,
): Promise<ApiResponse<{ items: ChatMessage[] }>> {
  return await apiRequest<{ items: ChatMessage[] }>(
    `${api.chatAgent.messages(encodeURIComponent(id))}?limit=${limit}`,
    { method: 'GET' },
  );
}

export async function sendChatMessage(
  id: string,
  content: string,
): Promise<ApiResponse<ChatTurnAccepted>> {
  return await apiRequest<ChatTurnAccepted>(api.chatAgent.messages(encodeURIComponent(id)), {
    method: 'POST',
    body: { content },
  });
}

/**
 * 订阅会话事件流。afterSeq 给上次收到的最后一个序号，服务端把之后的补齐再继续推——
 * 这就是刷新页面 / 换设备回来内容不丢的机制。
 * 服务端在「追平且没有轮次在跑」时会推一条 idle 然后收流，正常结束不算错误。
 */
export async function streamChatEvents(
  id: string,
  afterSeq: number,
  onEvent: (evt: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const baseUrl = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').replace(/\/+$/, '');
  const path = `${api.chatAgent.stream(encodeURIComponent(id))}?afterSeq=${afterSeq}`;
  const token = useAuthStore.getState().token;

  const res = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      'X-Client': 'admin',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal,
  });

  if (!res.ok) throw new Error(`对话事件流连接失败：HTTP ${res.status}`);

  await readSseStream(
    res,
    (evt) => {
      if (!evt.event) return;
      let payload: Record<string, unknown> = {};
      if (evt.data) {
        try {
          payload = JSON.parse(evt.data) as Record<string, unknown>;
        } catch {
          // 载荷解析不了不该让整条流挂掉，降级成空对象继续走
          payload = {};
        }
      }
      onEvent({
        seq: Number(evt.id ?? 0),
        type: evt.event as ChatStreamEvent['type'],
        payload,
      });
    },
    signal,
  );
}
