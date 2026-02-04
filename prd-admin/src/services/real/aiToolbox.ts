import { apiRequest, apiRequestSse } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

// ============ Types ============

export interface IntentResult {
  primaryIntent: string;
  secondaryIntents: string[];
  entities: Record<string, unknown>;
  confidence: number;
  reasoning?: string;
  suggestedAgents: string[];
}

export interface AgentInfo {
  agentKey: string;
  displayName: string;
  description: string;
}

export interface StepInfo {
  stepId: string;
  index: number;
  agentKey: string;
  agentDisplayName: string;
  action: string;
  status: string;
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

export interface ChatResponse {
  runId: string;
  intent: IntentResult;
  plannedAgents: AgentInfo[];
  steps: StepInfo[];
  status: string;
  sseUrl: string;
}

export interface ToolboxRunEvent {
  type: string;
  stepId?: string;
  stepIndex?: number;
  agentKey?: string;
  content?: string;
  artifact?: ToolboxArtifact;
  runStatus?: string;
  stepStatus?: string;
  errorMessage?: string;
  seq: number;
  timestamp: string;
}

// ============ API Functions ============

/**
 * 发送消息到百宝箱（意图识别 + 自动执行）
 */
export async function sendToolboxMessage(
  message: string,
  options?: { autoExecute?: boolean; sessionId?: string }
): Promise<ApiResponse<ChatResponse>> {
  return await apiRequest<ChatResponse>(
    api.aiToolbox.chat(),
    {
      method: 'POST',
      body: {
        message,
        sessionId: options?.sessionId,
        options: {
          autoExecute: options?.autoExecute ?? true,
        },
      },
    }
  );
}

/**
 * 仅进行意图识别
 */
export async function analyzeIntent(message: string): Promise<ApiResponse<IntentResult>> {
  return await apiRequest<IntentResult>(
    api.aiToolbox.analyze(),
    {
      method: 'POST',
      body: { message },
    }
  );
}

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
 * 获取可用的 Agent 列表
 */
export async function listToolboxAgents(): Promise<ApiResponse<{ agents: AgentInfo[] }>> {
  return await apiRequest(
    api.aiToolbox.agents(),
    { method: 'GET' }
  );
}

/**
 * 手动触发执行
 */
export async function executeToolboxRun(runId: string): Promise<ApiResponse<{ message: string }>> {
  return await apiRequest(
    api.aiToolbox.execute(runId),
    { method: 'POST' }
  );
}

/**
 * 订阅运行事件流（SSE）
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
  const url = `${api.aiToolbox.stream(runId)}${options.afterSeq ? `?afterSeq=${options.afterSeq}` : ''}`;

  const eventSource = new EventSource(url, { withCredentials: true });

  // 处理各种事件类型
  const eventTypes = [
    'run_started',
    'step_started',
    'step_progress',
    'step_artifact',
    'step_completed',
    'step_failed',
    'run_completed',
    'run_failed',
    'ping',
    'done',
    'error',
  ];

  eventTypes.forEach((type) => {
    eventSource.addEventListener(type, (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        options.onEvent({ ...data, eventType: type });

        if (type === 'done' || type === 'run_completed' || type === 'run_failed') {
          eventSource.close();
          options.onDone?.();
        }
      } catch (e) {
        console.error('解析事件失败:', e);
      }
    });
  });

  eventSource.onerror = (e) => {
    console.error('SSE 连接错误:', e);
    options.onError?.(new Error('SSE 连接错误'));
    eventSource.close();
  };

  // 返回取消订阅函数
  return () => {
    eventSource.close();
  };
}
