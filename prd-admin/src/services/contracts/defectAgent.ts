import type { ApiResponse } from '@/types/api';

/**
 * 缺陷模板字段
 */
export interface DefectTemplateField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number';
  required: boolean;
  options?: string[];
  placeholder?: string;
}

/**
 * 缺陷模板
 */
export interface DefectTemplate {
  id: string;
  name: string;
  description?: string;
  exampleContent?: string;
  requiredFields: DefectTemplateField[];
  aiSystemPrompt?: string;
  isDefault: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // 分享相关
  sharedWith?: string[];
  sharedFrom?: string;
}

/**
 * 缺陷附件
 */
export interface DefectAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
  thumbnailUrl?: string;
  uploadedAt: string;
  /**
   * 附件类型：
   * - file: 用户上传的普通文件（默认）
   * - screenshot: 自动截图
   * - log-request: 请求日志
   * - log-error: 错误日志
   */
  type?: string;
  /** 是否系统自动生成（日志类附件不可删除） */
  isSystemGenerated?: boolean;
  /** AI 图片分析描述（Vision 解析结果） */
  description?: string;
}

/**
 * 缺陷附件类型常量
 */
export const DefectAttachmentType = {
  File: 'file',
  Screenshot: 'screenshot',
  LogRequest: 'log-request',
  LogError: 'log-error',
} as const;

/**
 * 缺陷报告
 */
export interface DefectReport {
  id: string;
  defectNo: string;
  templateId?: string;
  title?: string;
  rawContent: string;
  structuredData: Record<string, string>;
  attachments: DefectAttachment[];
  status: string;
  severity: string;
  priority: string;
  // 后端返回 reporterId/assigneeId (非 reporterUserId/assigneeUserId)
  reporterId: string;
  reporterAvatarFileName?: string;
  reporterName?: string;
  assigneeId?: string;
  assigneeAvatarFileName?: string;
  assigneeName?: string;
  reporterUnread?: boolean;
  assigneeUnread?: boolean;
  lastCommentBy?: 'reporter' | 'assignee' | null;
  missingFields?: string[];
  resolution?: string;
  resolvedById?: string;
  resolvedByAvatarFileName?: string;
  resolvedByName?: string;
  /** 是否由 AI Agent 自动解决 */
  isAiResolved?: boolean;
  /** 解决该缺陷的 AI Agent 名称 */
  resolvedByAgentName?: string;
  rejectReason?: string;
  rejectedById?: string;
  rejectedByAvatarFileName?: string;
  rejectedByName?: string;
  resolvedAt?: string;
  closedAt?: string;
  version: number;
  versions?: DefectVersion[];
  createdAt: string;
  updatedAt: string;
  // 软删除相关
  isDeleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
  // 文件夹
  folderId?: string;
  // Phase 1: 项目 + 团队
  projectId?: string;
  projectName?: string;
  teamId?: string;
  teamName?: string;
  // Phase 2: 待验收
  verifiedById?: string;
  verifiedByName?: string;
  verifiedAt?: string;
  verifyFailReason?: string;
  // Phase 3: 催办
  lastEscalatedAt?: string;
  escalationCount?: number;
}

/**
 * 缺陷版本历史
 */
export interface DefectVersion {
  version: number;
  title?: string;
  rawContent: string;
  structuredData?: Record<string, string>;
  modifiedBy: string;
  modifiedByName?: string;
  modifiedAt: string;
  changeNote?: string;
}

/**
 * 缺陷消息
 */
export interface DefectMessage {
  id: string;
  defectId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  userId?: string;
  userName?: string;
  avatarFileName?: string;
  content: string;
  attachmentIds?: string[];
  extractedFields?: Record<string, string>;
  /** 消息来源：human（默认）、ai */
  source?: 'human' | 'ai';
  /** AI Agent 名称（source=ai 时有值） */
  agentName?: string;
  createdAt: string;
}

/**
 * 缺陷状态常量
 */
export const DefectStatus = {
  Draft: 'draft',
  Pending: 'pending',
  Working: 'working',
  Resolved: 'resolved',
  Rejected: 'rejected',
  Closed: 'closed',
  Verifying: 'verifying',
} as const;

/**
 * 缺陷严重程度
 */
export const DefectSeverity = {
  Critical: 'critical',
  Major: 'major',
  Minor: 'minor',
  Trivial: 'trivial',
} as const;

/**
 * 缺陷优先级
 */
export const DefectPriority = {
  Urgent: 'urgent',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
} as const;

/**
 * 缺陷统计
 */
export interface DefectStats {
  total: number;
  byStatus: Record<string, number>;
  bySeverity: Record<string, number>;
  mySubmitted: number;
  myAssigned: number;
}

/**
 * 用户简要信息
 */
export interface DefectUser {
  id: string;
  username: string;
  displayName?: string;
}

/**
 * 缺陷文件夹
 */
export interface DefectFolder {
  id: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  sortOrder: number;
  spaceId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ========== Contract Types ==========

export type ListDefectTemplatesContract = () => Promise<ApiResponse<{ items: DefectTemplate[] }>>;

export type CreateDefectTemplateContract = (input: {
  name: string;
  description?: string;
  exampleContent?: string;
  requiredFields?: DefectTemplateField[];
  aiSystemPrompt?: string;
  isDefault?: boolean;
}) => Promise<ApiResponse<{ template: DefectTemplate }>>;

export type UpdateDefectTemplateContract = (input: {
  id: string;
  name?: string;
  description?: string;
  exampleContent?: string;
  requiredFields?: DefectTemplateField[];
  aiSystemPrompt?: string;
  isDefault?: boolean;
}) => Promise<ApiResponse<{ template: DefectTemplate }>>;

export type DeleteDefectTemplateContract = (input: { id: string }) => Promise<ApiResponse<{ deleted: boolean }>>;

export type ShareDefectTemplateContract = (input: {
  id: string;
  targetUserIds: string[];
}) => Promise<ApiResponse<{ shared: boolean }>>;

export type ListDefectsContract = (input?: {
  filter?: 'submitted' | 'assigned' | 'completed' | 'rejected' | 'all';
  status?: string;
  folderId?: string;
  projectId?: string;
  teamId?: string;
  limit?: number;
  offset?: number;
}) => Promise<ApiResponse<{ items: DefectReport[]; total: number }>>;

export type GetDefectContract = (input: { id: string }) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type CreateDefectContract = (input: {
  templateId?: string;
  title?: string;
  content: string;
  assigneeUserId: string;
  severity?: string;
  priority?: string;
  projectId?: string;
  teamId?: string;
}) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type UpdateDefectContract = (input: {
  id: string;
  title?: string;
  content?: string;
  structuredData?: Record<string, string>;
  severity?: string;
  priority?: string;
  assigneeUserId?: string;
}) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type DeleteDefectContract = (input: { id: string }) => Promise<ApiResponse<{ deleted: boolean }>>;

export type SubmitDefectContract = (input: { id: string }) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type ProcessDefectContract = (input: { id: string }) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type ResolveDefectContract = (input: {
  id: string;
  resolution?: string;
}) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type RejectDefectContract = (input: {
  id: string;
  reason?: string;
}) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type UpdateDefectSeverityContract = (input: {
  id: string;
  severity: string;
}) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type CloseDefectContract = (input: { id: string }) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type ReopenDefectContract = (input: { id: string }) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type GetDefectMessagesContract = (input: {
  id: string;
  afterSeq?: number;
}) => Promise<ApiResponse<{ messages: DefectMessage[] }>>;

export type SendDefectMessageContract = (input: {
  id: string;
  content: string;
  attachmentIds?: string[];
}) => Promise<ApiResponse<{ message: DefectMessage }>>;

export type AddDefectAttachmentContract = (input: {
  id: string;
  file: File;
  /** AI 图片分析描述（Vision 解析结果） */
  description?: string;
}) => Promise<ApiResponse<{ attachment: DefectAttachment }>>;

export type DeleteDefectAttachmentContract = (input: {
  id: string;
  attachmentId: string;
}) => Promise<ApiResponse<{ deleted: boolean }>>;

export type PolishDefectContract = (input: {
  content: string;
  templateId?: string;
  imageDescriptions?: string[];
}) => Promise<ApiResponse<{ content: string }>>;

export type AnalyzeDefectImageContract = (input: {
  base64: string;
  mimeType: string;
}) => Promise<ApiResponse<{ description: string }>>;

export type GetDefectStatsContract = (input?: {
  projectId?: string;
  teamId?: string;
}) => Promise<ApiResponse<DefectStats>>;

export type GetDefectUsersContract = () => Promise<ApiResponse<{ items: DefectUser[] }>>;

// Phase 2: 验收
export type VerifyPassContract = (input: { id: string }) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type VerifyFailContract = (input: {
  id: string;
  reason?: string;
}) => Promise<ApiResponse<{ defect: DefectReport }>>;

// Phase 1: 项目管理
export interface DefectProject {
  id: string;
  name: string;
  key: string;
  description?: string;
  ownerUserId?: string;
  ownerName?: string;
  defaultTemplateId?: string;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ListDefectProjectsContract = (input?: {
  keyword?: string;
}) => Promise<ApiResponse<{ items: DefectProject[] }>>;

export type CreateDefectProjectContract = (input: {
  name: string;
  key: string;
  description?: string;
  defaultTemplateId?: string;
}) => Promise<ApiResponse<{ project: DefectProject }>>;

export type UpdateDefectProjectContract = (input: {
  id: string;
  name?: string;
  description?: string;
  defaultTemplateId?: string;
  ownerUserId?: string;
}) => Promise<ApiResponse<{ project: DefectProject }>>;

export type ArchiveDefectProjectContract = (input: { id: string }) => Promise<ApiResponse<{ archived: boolean }>>;

// 团队查询
export interface DefectTeam {
  id: string;
  name: string;
  leaderUserId?: string;
  leaderName?: string;
  description?: string;
}

export type ListDefectTeamsContract = () => Promise<ApiResponse<{ items: DefectTeam[] }>>;

// Phase 4: 统计看板
export interface DefectStatsOverview {
  total: number;
  openCount: number;
  thisWeekCount: number;
  avgResolutionHours: number;
  statusCounts: Record<string, number>;
  severityCounts: Record<string, number>;
}

export type GetDefectStatsOverviewContract = (input?: {
  projectId?: string;
  teamId?: string;
  from?: string;
  to?: string;
}) => Promise<ApiResponse<DefectStatsOverview>>;

export type GetDefectStatsTrendContract = (input?: {
  projectId?: string;
  teamId?: string;
  from?: string;
  to?: string;
  period?: 'day' | 'week' | 'month';
}) => Promise<ApiResponse<{
  created: Record<string, number>;
  closed: Record<string, number>;
  period: string;
}>>;

export interface UserStatItem {
  userId: string;
  userName: string;
  assignedCount?: number;
  resolvedCount?: number;
  avgResolutionHours?: number;
  submittedCount?: number;
}

export type GetDefectStatsByUserContract = (input?: {
  projectId?: string;
  teamId?: string;
  from?: string;
  to?: string;
}) => Promise<ApiResponse<{
  byAssignee: UserStatItem[];
  byReporter: UserStatItem[];
}>>;

// Phase 5: Webhook 配置
export interface DefectWebhookConfig {
  id: string;
  teamId?: string;
  projectId?: string;
  channel: string;
  webhookUrl: string;
  triggerEvents: string[];
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ListDefectWebhooksContract = () => Promise<ApiResponse<{ items: DefectWebhookConfig[] }>>;

export type CreateDefectWebhookContract = (input: {
  teamId?: string;
  projectId?: string;
  channel?: string;
  webhookUrl: string;
  triggerEvents?: string[];
  isEnabled?: boolean;
}) => Promise<ApiResponse<{ webhook: DefectWebhookConfig }>>;

export type UpdateDefectWebhookContract = (input: {
  id: string;
  teamId?: string;
  projectId?: string;
  channel?: string;
  webhookUrl?: string;
  triggerEvents?: string[];
  isEnabled?: boolean;
}) => Promise<ApiResponse<{ webhook: DefectWebhookConfig }>>;

export type DeleteDefectWebhookContract = (input: { id: string }) => Promise<ApiResponse<{ deleted: boolean }>>;

// 回收站相关
export type ListDeletedDefectsContract = (input?: {
  limit?: number;
  offset?: number;
}) => Promise<ApiResponse<{ items: DefectReport[]; total: number }>>;

export type RestoreDefectContract = (input: { id: string }) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type PermanentDeleteDefectContract = (input: { id: string }) => Promise<ApiResponse<{ deleted: boolean }>>;

// 文件夹相关
export type ListDefectFoldersContract = () => Promise<ApiResponse<{ items: DefectFolder[] }>>;

export type CreateDefectFolderContract = (input: {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  sortOrder?: number;
}) => Promise<ApiResponse<{ folder: DefectFolder }>>;

export type UpdateDefectFolderContract = (input: {
  id: string;
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
  sortOrder?: number;
}) => Promise<ApiResponse<{ folder: DefectFolder }>>;

export type DeleteDefectFolderContract = (input: { id: string }) => Promise<ApiResponse<{ deleted: boolean }>>;

export type MoveDefectToFolderContract = (input: {
  id: string;
  folderId?: string;
}) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type BatchMoveDefectsContract = (input: {
  defectIds: string[];
  folderId?: string;
}) => Promise<ApiResponse<{ movedCount: number }>>;

/**
 * 日志预览项
 */
export interface ApiLogPreviewItem {
  time: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  hasError: boolean;
  errorCode?: string;
  apiSummary?: string;
}

/**
 * 预览将要采集的 API 日志
 */
export type PreviewApiLogsContract = () => Promise<ApiResponse<{
  totalCount: number;
  errorCount: number;
  items: ApiLogPreviewItem[];
}>>;

// ========== 分享链接 ==========

/**
 * 缺陷分享链接
 */
export interface DefectShareLink {
  id: string;
  token: string;
  shareScope: 'single' | 'project' | 'selected';
  defectIds: string[];
  projectId?: string;
  projectName?: string;
  title?: string;
  viewCount: number;
  lastViewedAt?: string;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  expiresAt: string;
  isRevoked: boolean;
  isExpired?: boolean;
  reportCount?: number;
  aiScoreStatus?: 'none' | 'scoring' | 'completed' | 'failed';
  aiScoreCount?: number;
}

/**
 * AI 评分条目
 */
export interface DefectAiScoreItem {
  defectId: string;
  defectNo?: string;
  defectTitle?: string;
  severityScore: number;
  difficultyScore: number;
  impactScore: number;
  overallScore: number;
  reason?: string;
}

/**
 * 修复报告条目
 */
export interface DefectFixReportItem {
  defectId: string;
  defectNo?: string;
  defectTitle?: string;
  confidenceScore: number;
  analysis?: string;
  fixSuggestion?: string;
  acceptStatus: 'pending' | 'accepted' | 'rejected';
  reviewedBy?: string;
  reviewedByName?: string;
  reviewedAt?: string;
  reviewNote?: string;
}

/**
 * Agent 提交的修复报告
 */
export interface DefectFixReport {
  id: string;
  shareLinkId: string;
  shareToken: string;
  agentName?: string;
  agentIdentifier?: string;
  items: DefectFixReportItem[];
  status: 'pending' | 'partial' | 'completed';
  createdAt: string;
  ipAddress?: string;
  userAgent?: string;
}

export type CreateDefectShareContract = (input: {
  shareScope: string;
  defectIds?: string[];
  projectId?: string;
  title?: string;
  expiresInDays?: number;
}) => Promise<ApiResponse<{ shareLink: DefectShareLink; shareUrl: string }>>;

export type ListDefectSharesContract = () => Promise<ApiResponse<{ items: DefectShareLink[] }>>;

export type RevokeDefectShareContract = (input: { id: string }) => Promise<ApiResponse<{ revoked: boolean }>>;

export type ListDefectFixReportsContract = (input: {
  shareId: string;
}) => Promise<ApiResponse<{ items: DefectFixReport[] }>>;

export type AcceptDefectFixItemContract = (input: {
  reportId: string;
  defectId: string;
  reviewNote?: string;
  markResolved?: boolean;
}) => Promise<ApiResponse<{ item: DefectFixReportItem; defect?: DefectReport }>>;

export type RejectDefectFixItemContract = (input: {
  reportId: string;
  defectId: string;
  reviewNote?: string;
}) => Promise<ApiResponse<{ item: DefectFixReportItem }>>;

export type CreateBatchShareContract = (input: {
  projectId?: string;
  folderId?: string;
  title?: string;
  expiresInDays?: number;
  defectIds?: string[];
}) => Promise<ApiResponse<{ shareLink: DefectShareLink; shareUrl: string }>>;

export type GetShareScoresContract = (input: {
  shareId: string;
}) => Promise<ApiResponse<{ aiScoreStatus: string; scores: DefectAiScoreItem[] }>>;
