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
  /** 卡片上显示的 emoji 标识，便于用户快速识别 */
  emoji?: string;
  category: 'builtin' | 'custom';
  type: 'builtin' | 'custom';
  agentKey?: string;
  /** 定制版 Agent 的跳转路由，有此字段则为定制版 */
  routePath?: string;
  prompt?: string;
  /** 后端返回的 systemPrompt 字段 */
  systemPrompt?: string;
  modelId?: string;
  /** 启用的能力工具 */
  enabledTools?: string[];
  /** 绑定的工作流 ID（当 enabledTools 包含 workflowTrigger 时使用） */
  workflowId?: string;
  isPublic?: boolean;
  forkCount?: number;
  forkedFromId?: string;
  knowledgeBaseIds?: string[];
  welcomeMessage?: string;
  conversationStarters?: string[];
  temperature?: number;
  enableMemory?: boolean;
  /** 后端返回的创建者 userId — 与当前登录用户对比判断 ownership */
  createdByUserId?: string;
  /** @deprecated 后端返回字段是 createdByUserId，此字段保留仅为兼容历史调用点 */
  createdBy?: string;
  createdByName?: string;
  /** 创建者头像文件名（后端返回）— 配合 resolveAvatarUrl 拼完整 URL 展示 */
  createdByAvatarFileName?: string | null;
  /**
   * 前端归一化字段（非后端返回）：用于在百宝箱首页区分"我的"vs"别人的"。
   * - 'mine'  : BUILTIN 工具，或我自己创建/Fork 的条目
   * - 'others': 别人创建并公开的条目（来自 /marketplace 合并进来的）
   * 由 toolboxStore 在 loadItems 时按 createdByUserId 打标。
   */
  ownership?: 'mine' | 'others';
  usageCount: number;
  tags: string[];
  createdAt: string;
  updatedAt?: string;
  /** 未正式发布：卡片左下角显示"施工中"徽章 */
  wip?: boolean;
  /**
   * 分类：智能体（AI + 生命周期 + 存储）/ 工具（缺一即为工具）/ 基础设施（平台级能力）。
   * 未指定时在 UI 上按 builtin/custom 兜底显示。
   */
  kind?: 'agent' | 'tool' | 'infra';
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

// ============ Session Management ============

export interface ToolboxSessionInfo {
  id: string;
  itemId: string;
  userId: string;
  title: string;
  messageCount: number;
  isArchived: boolean;
  isPinned: boolean;
  createdAt: string;
  lastActiveAt: string;
}

export interface ToolboxMessageInfo {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  attachmentIds: string[];
  createdAt: string;
}

/**
 * 获取智能体的会话列表
 */
export async function listToolboxSessions(
  itemId: string,
  params?: { search?: string; sortBy?: string; includeArchived?: boolean }
): Promise<ApiResponse<{ sessions: ToolboxSessionInfo[] }>> {
  const query = new URLSearchParams();
  if (params?.search) query.set('search', params.search);
  if (params?.sortBy) query.set('sortBy', params.sortBy);
  if (params?.includeArchived) query.set('includeArchived', 'true');
  const queryStr = query.toString();
  return await apiRequest(
    `${api.aiToolbox.sessions(itemId)}${queryStr ? `?${queryStr}` : ''}`,
    { method: 'GET' }
  );
}

/**
 * 创建新会话
 */
export async function createToolboxSession(
  itemId: string
): Promise<ApiResponse<ToolboxSessionInfo>> {
  return await apiRequest(api.aiToolbox.sessions(itemId), { method: 'POST' });
}

/**
 * 重命名会话
 */
export async function renameToolboxSession(
  sessionId: string,
  title: string
): Promise<ApiResponse<{ title: string }>> {
  return await apiRequest(api.aiToolbox.session(sessionId), {
    method: 'PATCH',
    body: { title },
  });
}

/**
 * 删除会话
 */
export async function deleteToolboxSession(
  sessionId: string
): Promise<ApiResponse<void>> {
  return await apiRequest(api.aiToolbox.session(sessionId), { method: 'DELETE' });
}

/**
 * 切换会话归档状态
 */
export async function toggleSessionArchive(
  sessionId: string
): Promise<ApiResponse<{ isArchived: boolean }>> {
  return await apiRequest(api.aiToolbox.sessionArchive(sessionId), { method: 'PATCH' });
}

/**
 * 切换会话置顶状态
 */
export async function toggleSessionPin(
  sessionId: string
): Promise<ApiResponse<{ isPinned: boolean }>> {
  return await apiRequest(api.aiToolbox.sessionPin(sessionId), { method: 'PATCH' });
}

/**
 * 获取会话消息历史
 */
export async function listToolboxMessages(
  sessionId: string,
  limit = 100
): Promise<ApiResponse<{ messages: ToolboxMessageInfo[] }>> {
  return await apiRequest(
    `${api.aiToolbox.messages(sessionId)}?limit=${limit}`,
    { method: 'GET' }
  );
}

/**
 * 向会话追加消息
 */
export async function appendToolboxMessage(
  sessionId: string,
  message: { role: string; content: string; attachmentIds?: string[] }
): Promise<ApiResponse<ToolboxMessageInfo>> {
  return await apiRequest(api.aiToolbox.messages(sessionId), {
    method: 'POST',
    body: message,
  });
}

// ============ Marketplace ============

/**
 * 获取公开的智能体列表（市场）
 */
export async function listMarketplaceItems(
  params?: { keyword?: string; page?: number; pageSize?: number }
): Promise<ApiResponse<{ items: ToolboxItem[]; total: number }>> {
  const query = new URLSearchParams();
  if (params?.keyword) query.set('keyword', params.keyword);
  if (params?.page) query.set('page', String(params.page));
  if (params?.pageSize) query.set('pageSize', String(params.pageSize));
  const queryStr = query.toString();
  return await apiRequest(
    `${api.aiToolbox.marketplace()}${queryStr ? `?${queryStr}` : ''}`,
    { method: 'GET' }
  );
}

/**
 * Fork 公开的智能体
 */
export async function forkToolboxItem(id: string): Promise<ApiResponse<ToolboxItem>> {
  return await apiRequest(api.aiToolbox.forkItem(id), { method: 'POST' });
}

/**
 * 切换智能体的公开状态
 */
export async function toggleToolboxItemPublish(
  id: string,
  isPublic: boolean
): Promise<ApiResponse<{ isPublic: boolean }>> {
  return await apiRequest(api.aiToolbox.publishItem(id), {
    method: 'PUT',
    body: { isPublic },
  });
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

// ============ Workflow Trigger ============

/**
 * 触发智能体绑定的工作流
 */
export async function triggerAgentWorkflow(
  itemId: string,
  params: { message?: string; variables?: Record<string, string> }
): Promise<ApiResponse<{ executionId: string; workflowId: string; workflowName: string; status: string }>> {
  return await apiRequest(
    api.aiToolbox.triggerWorkflow(itemId),
    {
      method: 'POST',
      body: params,
    }
  );
}

// ============ Attachment Upload ============

export interface UploadedAttachment {
  attachmentId: string;
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
}

/**
 * 上传附件文件（PDF/Word/Excel/PPT/图片等）
 */
export async function uploadAttachment(file: File): Promise<ApiResponse<UploadedAttachment>> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', file);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase ? `${rawBase}/api/v1/attachments` : '/api/v1/attachments';

  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<UploadedAttachment>;
  } catch {
    return { success: false, error: { code: 'PARSE_ERROR', message: text || '上传失败' } } as any;
  }
}

// ============ Message Feedback ============

/**
 * 提交消息反馈（点赞/踩）
 */
export async function submitMessageFeedback(
  messageId: string,
  feedback: 'up' | 'down' | null
): Promise<ApiResponse<{ messageId: string; feedback: string | null }>> {
  return await apiRequest(
    api.aiToolbox.messageFeedback(messageId),
    {
      method: 'POST',
      body: { feedback },
    }
  );
}

// ============ Share ============

/**
 * 创建对话分享链接
 */
export async function createToolboxShareLink(
  messages: { role: string; content: string; createdAt?: string }[],
  title?: string,
  sessionId?: string,
): Promise<ApiResponse<{ shareId: string; url: string }>> {
  return await apiRequest(
    api.aiToolbox.share(),
    {
      method: 'POST',
      body: { messages, title, sessionId },
    }
  );
}

/**
 * 获取分享对话（公开访问）
 */
export async function getToolboxSharedConversation(
  shareId: string
): Promise<ApiResponse<{
  title: string;
  messages: { role: string; content: string; createdAt: string }[];
  createdAt: string;
}>> {
  return await apiRequest(
    api.aiToolbox.sharedConversation(shareId),
    { method: 'GET' }
  );
}

// ============ Direct Chat (SSE Streaming) ============

export interface DirectChatMessage {
  role: 'user' | 'assistant';
  content: string;
  attachmentIds?: string[];
}

export interface TokenInfo {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * 直接对话 SSE 流式调用
 * 用于普通版 Agent 和自定义智能体
 */
export function streamDirectChat(
  options: {
    message: string;
    agentKey?: string;
    itemId?: string;
    sessionId?: string;
    history?: DirectChatMessage[];
    attachmentIds?: string[];
    onText: (content: string) => void;
    onThinking?: (content: string) => void;
    onStart?: (info: { model?: string; platform?: string }) => void;
    onError?: (error: string) => void;
    onDone?: (tokenInfo?: TokenInfo) => void;
  }
): () => void {
  const token = useAuthStore.getState().token;
  const url = api.aiToolbox.directChat();
  const abortController = new AbortController();

  (async () => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: options.message,
          agentKey: options.agentKey,
          itemId: options.itemId,
          sessionId: options.sessionId,
          history: options.history,
          attachmentIds: options.attachmentIds,
        }),
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
                options.onStart?.({ model: data.model, platform: data.platform });
              } else if (currentEvent === 'thinking' && data.content) {
                options.onThinking?.(data.content);
              } else if (currentEvent === 'text' && data.content) {
                options.onText(data.content);
              } else if (currentEvent === 'error') {
                options.onError?.(data.message || '调用失败');
                return;
              } else if (currentEvent === 'done') {
                const tokenInfo: TokenInfo | undefined =
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
              console.error('解析 SSE 事件失败:', e);
            }
            currentEvent = '';
            currentData = '';
          }
        }
      }

      options.onDone?.();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.error('Direct chat SSE error:', e);
        options.onError?.((e as Error).message);
      }
    }
  })();

  return () => {
    abortController.abort();
  };
}

/**
 * 基础能力对话 SSE 流式调用
 */
export function streamCapabilityChat(
  capabilityKey: string,
  options: {
    message: string;
    history?: DirectChatMessage[];
    onText: (content: string) => void;
    onError?: (error: string) => void;
    onDone?: () => void;
  }
): () => void {
  const token = useAuthStore.getState().token;
  const url = api.aiToolbox.capabilityChat(capabilityKey);
  const abortController = new AbortController();

  (async () => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: options.message,
          history: options.history,
        }),
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
              if (currentEvent === 'text' && data.content) {
                options.onText(data.content);
              } else if (currentEvent === 'error') {
                options.onError?.(data.message || '调用失败');
                return;
              } else if (currentEvent === 'done') {
                options.onDone?.();
                return;
              }
            } catch (e) {
              console.error('解析 SSE 事件失败:', e);
            }
            currentEvent = '';
            currentData = '';
          }
        }
      }

      options.onDone?.();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.error('Capability chat SSE error:', e);
        options.onError?.((e as Error).message);
      }
    }
  })();

  return () => {
    abortController.abort();
  };
}
