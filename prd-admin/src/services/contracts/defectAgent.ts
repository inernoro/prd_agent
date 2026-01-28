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
  /** 是否系统自动生成（日志类附件不可删除、不可下载） */
  isSystemGenerated?: boolean;
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
  requiredFields: DefectTemplateField[];
  aiSystemPrompt?: string;
  isDefault?: boolean;
}) => Promise<ApiResponse<{ template: DefectTemplate }>>;

export type UpdateDefectTemplateContract = (input: {
  id: string;
  name?: string;
  description?: string;
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
}) => Promise<ApiResponse<{ attachment: DefectAttachment }>>;

export type DeleteDefectAttachmentContract = (input: {
  id: string;
  attachmentId: string;
}) => Promise<ApiResponse<{ deleted: boolean }>>;

export type PolishDefectContract = (input: {
  content: string;
  templateId?: string;
}) => Promise<ApiResponse<{ content: string }>>;

export type GetDefectStatsContract = () => Promise<ApiResponse<DefectStats>>;

export type GetDefectUsersContract = () => Promise<ApiResponse<{ items: DefectUser[] }>>;

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
