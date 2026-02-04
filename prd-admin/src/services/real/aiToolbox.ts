import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';

// ============ Types ============

export interface ToolboxItem {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'builtin' | 'custom';
  type: 'builtin' | 'custom';
  agentKey?: string;
  prompt?: string;
  modelId?: string;
  isPublic?: boolean;
  createdBy?: string;
  createdByName?: string;
  usageCount: number;
  tags: string[];
  createdAt: string;
  updatedAt?: string;
}

export interface ToolboxItemRun {
  runId: string;
  itemId: string;
  status: string;
  output?: string;
}

export interface AgentInfo {
  agentKey: string;
  displayName: string;
  description: string;
}

export interface ToolboxRunEvent {
  type: string;
  stepId?: string;
  content?: string;
  runStatus?: string;
  errorMessage?: string;
  seq: number;
  timestamp: string;
}

// Legacy types for backward compatibility
export interface IntentResult {
  primaryIntent: string;
  secondaryIntents: string[];
  entities: Record<string, unknown>;
  confidence: number;
  reasoning?: string;
  suggestedAgents: string[];
}

export interface ToolboxArtifact {
  id: string;
  type: string;
  name: string;
  mimeType: string;
  content?: string;
  url?: string;
  sourceStepId?: string;
  createdAt: string;
}

export interface ToolboxRun {
  id: string;
  userId: string;
  sessionId?: string;
  userMessage: string;
  intent?: IntentResult;
  plannedAgents: string[];
  steps: ToolboxRunStep[];
  status: string;
  errorMessage?: string;
  artifacts: ToolboxArtifact[];
  finalResponse?: string;
  lastSeq: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ToolboxRunStep {
  stepId: string;
  index: number;
  agentKey: string;
  agentDisplayName: string;
  action: string;
  status: string;
  output?: string;
  artifactIds: string[];
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
}

// ============ Toolbox Items API ============

/**
 * 获取工具列表
 */
export async function listToolboxItems(
  params?: { category?: string; keyword?: string }
): Promise<ApiResponse<{ items: ToolboxItem[] }>> {
  const query = new URLSearchParams();
  if (params?.category) query.set('category', params.category);
  if (params?.keyword) query.set('keyword', params.keyword);
  const queryStr = query.toString();
  return await apiRequest(
    `${api.aiToolbox.items()}${queryStr ? `?${queryStr}` : ''}`,
    { method: 'GET' }
  );
}

/**
 * 获取工具详情
 */
export async function getToolboxItem(id: string): Promise<ApiResponse<ToolboxItem>> {
  return await apiRequest(
    api.aiToolbox.item(id),
    { method: 'GET' }
  );
}

/**
 * 创建自定义工具
 */
export async function createToolboxItem(
  item: Partial<ToolboxItem>
): Promise<ApiResponse<ToolboxItem>> {
  return await apiRequest(
    api.aiToolbox.items(),
    {
      method: 'POST',
      body: item,
    }
  );
}

/**
 * 更新工具
 */
export async function updateToolboxItem(
  id: string,
  item: Partial<ToolboxItem>
): Promise<ApiResponse<ToolboxItem>> {
  return await apiRequest(
    api.aiToolbox.item(id),
    {
      method: 'PUT',
      body: item,
    }
  );
}

/**
 * 删除工具
 */
export async function deleteToolboxItem(id: string): Promise<ApiResponse<void>> {
  return await apiRequest(
    api.aiToolbox.item(id),
    { method: 'DELETE' }
  );
}

/**
 * 运行工具
 */
export async function runToolboxItem(
  itemId: string,
  input: string
): Promise<ApiResponse<ToolboxItemRun>> {
  return await apiRequest(
    api.aiToolbox.runItem(itemId),
    {
      method: 'POST',
      body: { input },
    }
  );
}

/**
 * 获取可用的 Agent 列表
 */
export async function listToolboxAgents(): Promise<ApiResponse<{ agents: AgentInfo[] }>> {
  return await apiRequest(
    api.aiToolbox.agents(),
    { method: 'GET' }
  );
}

// ============ Legacy API Functions (for backward compatibility) ============

/**
 * 获取运行记录详情
 */
export async function getToolboxRun(runId: string): Promise<ApiResponse<ToolboxRun>> {
  return await apiRequest<ToolboxRun>(
    api.aiToolbox.run(runId),
    { method: 'GET' }
  );
}

/**
 * 获取运行历史列表
 */
export async function listToolboxRuns(
  page = 1,
  pageSize = 20
): Promise<ApiResponse<{ items: ToolboxRun[]; total: number; page: number; pageSize: number }>> {
  return await apiRequest(
    `${api.aiToolbox.runs()}?page=${page}&pageSize=${pageSize}`,
    { method: 'GET' }
  );
}

/**
 * 订阅运行事件流（SSE）- 使用 fetch 支持 JWT 认证
 */
export function subscribeToolboxRunEvents(
  runId: string,
  options: {
    afterSeq?: number;
    onEvent: (event: ToolboxRunEvent & { eventType: string }) => void;
    onError?: (error: Error) => void;
    onDone?: () => void;
  }
): () => void {
  const token = useAuthStore.getState().token;
  const url = `${api.aiToolbox.stream(runId)}${options.afterSeq ? `?afterSeq=${options.afterSeq}` : ''}`;
  const abortController = new AbortController();

  (async () => {
    try {
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        let currentData = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            currentData = line.slice(5).trim();
          } else if (line === '' && currentEvent && currentData) {
            try {
              const data = JSON.parse(currentData);
              options.onEvent({ ...data, eventType: currentEvent });

              if (currentEvent === 'done' || currentEvent === 'run_completed' || currentEvent === 'run_failed') {
                options.onDone?.();
                return;
              }
            } catch (e) {
              console.error('解析事件失败:', e);
            }
            currentEvent = '';
            currentData = '';
          }
        }
      }

      options.onDone?.();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.error('SSE 连接错误:', e);
        options.onError?.(e as Error);
      }
    }
  })();

  return () => {
    abortController.abort();
  };
}
