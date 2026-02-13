import type { ApiResponse } from '@/types/api';

// ─────────────────────────────────────────────
// Models
// ─────────────────────────────────────────────

export interface WorkflowNode {
  nodeId: string;
  name: string;
  nodeType: string;
  config: Record<string, unknown>;
  inputSlots: ArtifactSlot[];
  outputSlots: ArtifactSlot[];
  position?: NodePosition;
  retry?: RetryPolicy;
}

export interface ArtifactSlot {
  slotId: string;
  name: string;
  dataType: string;
  required: boolean;
  description?: string;
}

export interface NodePosition {
  x: number;
  y: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  delaySeconds: number;
}

export interface WorkflowEdge {
  edgeId: string;
  sourceNodeId: string;
  sourceSlotId: string;
  targetNodeId: string;
  targetSlotId: string;
}

export interface WorkflowVariable {
  key: string;
  label: string;
  type: string;
  defaultValue?: string;
  options?: string[];
  required: boolean;
  isSecret: boolean;
}

export interface WorkflowTrigger {
  triggerId: string;
  type: string;
  cronExpression?: string;
  timezone: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  tags: string[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables: WorkflowVariable[];
  triggers: WorkflowTrigger[];
  isEnabled: boolean;
  executionCount: number;
  lastExecutedAt?: string;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NodeExecution {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  attemptCount: number;
  errorMessage?: string;
  logs?: string;
  inputArtifactRefs: ArtifactRef[];
  outputArtifacts: ExecutionArtifact[];
}

export interface ArtifactRef {
  sourceNodeId: string;
  sourceSlotId: string;
  artifactId: string;
}

export interface ExecutionArtifact {
  artifactId: string;
  slotId?: string;
  name: string;
  mimeType: string;
  inlineContent?: string;
  cosKey?: string;
  cosUrl?: string;
  sizeBytes: number;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflowName: string;
  triggerType: string;
  triggeredBy: string;
  triggeredByName?: string;
  status: string;
  variables: Record<string, string>;
  nodeSnapshot: WorkflowNode[];
  edgeSnapshot: WorkflowEdge[];
  nodeExecutions: NodeExecution[];
  finalArtifacts: ExecutionArtifact[];
  shareLinkIds: string[];
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  lastSeq: number;
  createdAt: string;
}

export interface ShareArtifactRef {
  artifactId: string;
  name: string;
  mimeType: string;
  url?: string;
}

export interface ShareLink {
  id: string;
  token: string;
  resourceType: string;
  resourceId: string;
  accessLevel: string;
  title?: string;
  previewHtml?: string;
  artifacts: ShareArtifactRef[];
  isRevoked: boolean;
  viewCount: number;
  lastViewedAt?: string;
  expiresAt?: string;
  createdBy: string;
  createdAt: string;
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

export const WorkflowNodeTypes = {
  DataCollector: 'data-collector',
  ScriptExecutor: 'script-executor',
  LlmAnalyzer: 'llm-analyzer',
  LlmCodeExecutor: 'llm-code-executor',
  Renderer: 'renderer',
} as const;

export const NodeTypeLabels: Record<string, string> = {
  // 旧类型（兼容）
  'data-collector': '数据采集',
  'script-executor': '代码脚本',
  'llm-analyzer': 'LLM 分析',
  'llm-code-executor': 'LLM 代码执行',
  'renderer': '渲染输出',
  // 舱类型 — 触发
  'timer': '定时器',
  'webhook-receiver': 'Webhook 接收',
  'manual-trigger': '手动触发',
  'file-upload': '文件上传',
  // 舱类型 — 处理
  'tapd-collector': 'TAPD 采集',
  'http-request': 'HTTP 请求',
  'smart-http': '智能 HTTP',
  'data-extractor': '数据提取',
  'data-merger': '数据合并',
  // 舱类型 — 输出
  'report-generator': '报告生成',
  'file-exporter': '文件导出',
  'webhook-sender': 'Webhook 发送',
  'notification-sender': '站内通知',
};

export const ExecutionStatus = {
  Queued: 'queued',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export const ExecutionStatusLabels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const NodeExecutionStatus = {
  Pending: 'pending',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
  Skipped: 'skipped',
} as const;

// ─────────────────────────────────────────────
// Contracts
// ─────────────────────────────────────────────

export type ListWorkflowsContract = (input?: {
  tag?: string;
  page?: number;
  pageSize?: number;
}) => Promise<ApiResponse<{ items: Workflow[]; total: number }>>;

export type CreateWorkflowContract = (input: {
  name?: string;
  description?: string;
  icon?: string;
  tags?: string[];
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  variables?: WorkflowVariable[];
  triggers?: WorkflowTrigger[];
}) => Promise<ApiResponse<{ workflow: Workflow }>>;

export type GetWorkflowContract = (id: string) => Promise<ApiResponse<{ workflow: Workflow }>>;

export type UpdateWorkflowContract = (input: {
  id: string;
  name?: string;
  description?: string;
  icon?: string;
  tags?: string[];
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  variables?: WorkflowVariable[];
  triggers?: WorkflowTrigger[];
  isEnabled?: boolean;
}) => Promise<ApiResponse<{ workflow: Workflow }>>;

export type DeleteWorkflowContract = (id: string) => Promise<ApiResponse<{ deleted: boolean }>>;

export type ExecuteWorkflowContract = (input: {
  id: string;
  variables?: Record<string, string>;
}) => Promise<ApiResponse<{ execution: WorkflowExecution }>>;

export type ListExecutionsContract = (input?: {
  workflowId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}) => Promise<ApiResponse<{ items: WorkflowExecution[]; total: number }>>;

export type GetExecutionContract = (id: string) => Promise<ApiResponse<{ execution: WorkflowExecution }>>;

export type CancelExecutionContract = (id: string) => Promise<ApiResponse<{ cancelled: boolean }>>;

export type ResumeFromNodeContract = (input: {
  executionId: string;
  nodeId: string;
}) => Promise<ApiResponse<{ execution: WorkflowExecution }>>;

export type GetNodeLogsContract = (input: {
  executionId: string;
  nodeId: string;
}) => Promise<ApiResponse<{
  nodeId: string;
  nodeName: string;
  status: string;
  logs?: string;
  errorMessage?: string;
  artifacts: ExecutionArtifact[];
}>>;

export type CreateShareLinkContract = (input: {
  executionId: string;
  accessLevel?: string;
  expiresInDays?: number;
}) => Promise<ApiResponse<{ shareLink: ShareLink; url: string }>>;

export type ListShareLinksContract = () => Promise<ApiResponse<{ items: ShareLink[] }>>;

export type RevokeShareContract = (shareId: string) => Promise<ApiResponse<{ revoked: boolean }>>;

// ─────────────────────────────────────────────
// 舱类型注册表 Models
// ─────────────────────────────────────────────

export interface CapsuleConfigField {
  key: string;
  label: string;
  fieldType: string;
  placeholder?: string;
  helpTip?: string;
  required: boolean;
  defaultValue?: string;
  options?: { value: string; label: string }[];
}

export interface CapsuleTypeMeta {
  typeKey: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  accentHue: number;
  configSchema: CapsuleConfigField[];
  defaultInputSlots: ArtifactSlot[];
  defaultOutputSlots: ArtifactSlot[];
  testable: boolean;
}

export interface CapsuleCategoryInfo {
  key: string;
  label: string;
  description: string;
}

export interface CapsuleTestRunResult {
  typeKey: string;
  typeName: string;
  status: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  configValidation: {
    key: string;
    label: string;
    provided: boolean;
    required: boolean;
    valid: boolean;
    validationMessage?: string;
  }[];
  mockOutput: Record<string, unknown>;
  errorMessage?: string;
}

// ─────────────────────────────────────────────
// 舱类型 Contracts
// ─────────────────────────────────────────────

export type ListCapsuleTypesContract = (input?: {
  category?: string;
}) => Promise<ApiResponse<{
  items: CapsuleTypeMeta[];
  categories: CapsuleCategoryInfo[];
}>>;

export type GetCapsuleTypeContract = (typeKey: string) => Promise<ApiResponse<{
  capsuleType: CapsuleTypeMeta;
}>>;

export type TestRunCapsuleContract = (input: {
  typeKey: string;
  config?: Record<string, unknown>;
  mockInput?: unknown;
}) => Promise<ApiResponse<{
  result: CapsuleTestRunResult;
}>>;
