import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';

// ============ Agent Universe（智能体宇宙）============
//
// 一套标准把所有智能体接到一起：每个智能体声明输入/输出/调用模式/交互形态（能力契约），
// 统一调用信封 invoke 按契约路由（生成型→适配器产图，文本型→gateway），
// 产出统一为带类型的 SSE 事件（text / thinking / artifact / done / error）。
//
// 契约来自后端 SSOT（AgentCapabilityRegistry），前端只消费不维护业务映射表。

/** 输入/输出数据类型 */
export type AgentDataKind =
  | 'text' | 'document' | 'image' | 'audio' | 'structured' | 'video';

/** 调用模式：决定后端路由 */
export type AgentInvokeMode = 'chat' | 'generation' | 'structured' | 'transform';

/** 前端交互形态：决定渲染哪种输入/输出 UI */
export type AgentInteraction =
  | 'chat-stream' | 'prompt-to-image' | 'article-to-illustrated' | 'form-submit';

/** 智能体能力契约（后端 capabilities 接口下发，systemPrompt / appCaller 不下发） */
export interface AgentCapability {
  agentKey: string;
  name: string;
  description: string;
  icon: string;
  accent: string;
  inputs: AgentDataKind[];
  outputs: AgentDataKind[];
  invokeMode: AgentInvokeMode;
  interaction: AgentInteraction;
  defaultAction: string;
  inputHint: string;
  actionLabel: string;
}

/** 调用产出的成果物（目前主要是图片） */
export interface AgentArtifact {
  kind: string;          // 'image' | 'markdown' | 'json' | ...
  url?: string | null;
  name?: string | null;
  mimeType?: string | null;
  content?: string | null;
}

export interface AgentInvokeHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentInvokeTokenInfo {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * 拉取智能体能力契约清单。前端据此渲染选择器与对应交互形态。
 */
export async function listAgentCapabilities(): Promise<ApiResponse<{ capabilities: AgentCapability[] }>> {
  return await apiRequest(api.agentUniverse.capabilities(), { method: 'GET' });
}

/**
 * 统一调用信封（SSE 流式）。无论文本还是生图，调用方只认这一套回调。
 * 返回中止函数。
 */
export function invokeAgent(options: {
  agentKey: string;
  text: string;
  action?: string;
  documentContent?: string;
  imageUrls?: string[];
  history?: AgentInvokeHistoryItem[];
  onStart?: (info: { agentKey?: string; invokeMode?: string; model?: string; platform?: string }) => void;
  onText: (content: string) => void;
  onThinking?: (content: string) => void;
  onArtifact?: (artifact: AgentArtifact) => void;
  onError?: (error: string) => void;
  onDone?: (tokenInfo?: AgentInvokeTokenInfo) => void;
}): () => void {
  const token = useAuthStore.getState().token;
  const url = api.agentUniverse.invoke();
  const abortController = new AbortController();

  (async () => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };
      if (token) headers.Authorization = `Bearer ${token}`;

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          agentKey: options.agentKey,
          text: options.text,
          action: options.action,
          documentContent: options.documentContent,
          imageUrls: options.imageUrls,
          history: options.history,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      let currentData = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            currentData = line.slice(5).trim();
          } else if (line === '' && currentEvent && currentData) {
            try {
              const data = JSON.parse(currentData);
              if (currentEvent === 'start') {
                options.onStart?.({
                  agentKey: data.agentKey,
                  invokeMode: data.invokeMode,
                  model: data.model,
                  platform: data.platform,
                });
              } else if (currentEvent === 'thinking' && data.content) {
                options.onThinking?.(data.content);
              } else if (currentEvent === 'text' && data.content) {
                options.onText(data.content);
              } else if (currentEvent === 'artifact') {
                options.onArtifact?.({
                  kind: data.kind,
                  url: data.url,
                  name: data.name,
                  mimeType: data.mimeType,
                  content: data.content,
                });
              } else if (currentEvent === 'error') {
                options.onError?.(data.message || '调用失败');
                return;
              } else if (currentEvent === 'done') {
                const tokenInfo: AgentInvokeTokenInfo | undefined =
                  data.totalTokens != null
                    ? {
                        promptTokens: data.promptTokens,
                        completionTokens: data.completionTokens,
                        totalTokens: data.totalTokens,
                      }
                    : undefined;
                options.onDone?.(tokenInfo);
                return;
              }
            } catch (e) {
              console.error('解析 Agent Universe SSE 事件失败:', e);
            }
            currentEvent = '';
            currentData = '';
          }
        }
      }

      options.onDone?.();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.error('Agent Universe invoke SSE error:', e);
        options.onError?.((e as Error).message);
      }
    }
  })();

  return () => {
    abortController.abort();
  };
}
