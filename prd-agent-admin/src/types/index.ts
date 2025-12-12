// LLM平台类型
export interface LLMPlatform {
  id: string;
  name: string;
  platformType: string;
  apiUrl: string;
  apiKeyMasked?: string;
  enabled: boolean;
  maxConcurrency: number;
  remark?: string;
  createdAt: string;
  updatedAt: string;
}

// LLM模型类型
export interface LLMModel {
  id: string;
  name: string;
  modelName: string;
  apiUrl?: string;
  apiKeyMasked?: string;
  platformId?: string;
  platformName?: string;
  group?: string;
  timeout: number;
  maxRetries: number;
  maxConcurrency: number;
  enabled: boolean;
  priority: number;
  isMain: boolean;
  remark?: string;
  callCount: number;
  totalDuration: number;
  successCount: number;
  failCount: number;
  averageDuration: number;
  successRate: number;
  createdAt: string;
  updatedAt: string;
}

// 可用模型类型
export interface AvailableModel {
  modelName: string;
  displayName: string;
  group: string;
}

// 平台类型选项
export const PLATFORM_TYPES = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google' },
  { value: 'qwen', label: '通义千问' },
  { value: 'zhipu', label: '智谱AI' },
  { value: 'baidu', label: '百度文心' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'other', label: '其他' },
] as const;

// API响应类型
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: {
    code: string;
    message: string;
  };
}

// ========== PRD Agent 相关类型 ==========
export type UserRole = 'PM' | 'DEV' | 'QA' | 'ADMIN';
export type InteractionMode = 'QA' | 'Guided';
export type MessageRole = 'User' | 'Assistant';

export interface PrdDocument {
  id: string;
  title: string;
  charCount: number;
  tokenEstimate: number;
}

export interface PrdSession {
  sessionId: string;
  groupId?: string;
  documentId: string;
  currentRole: UserRole;
  mode: InteractionMode;
  guideStep?: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  viewRole?: UserRole;
  timestamp: Date;
  senderId?: string;
  senderName?: string;
}

export interface UploadDocumentResponse {
  sessionId: string;
  document: PrdDocument;
}

