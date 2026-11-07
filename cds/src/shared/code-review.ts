/** Public review task contract. Source contents and engine credentials never leave the service. */
export const CODE_REVIEW_MCP_TOOLS = ['cds_code_review_submit', 'cds_code_review_get', 'cds_code_review_list', 'cds_code_review_report_upload'] as const;
export type CodeReviewStatus = 'queued' | 'preparing' | 'running' | 'archiving' | 'completed' | 'failed' | 'cancelled';
export interface CodeReviewTask {
  id: string;
  projectId: string;
  title: string;
  sourceType: 'github' | 'zip' | 'report';
  sourceName: string;
  githubUrl?: string;
  ref?: string;
  commitSha?: string;
  sourceHash?: string;
  inputSkippedFiles?: number;
  excludePatterns: string[];
  status: CodeReviewStatus;
  phase: string;
  progress: { totalFiles: number; scannedFiles: number };
  engineTaskId?: string;
  engineCompleted?: boolean;
  /** Internal persisted intent: only an explicit user retry may resume a failed upstream scan. */
  engineRetryRequested?: boolean;
  reportId?: string;
  findingsSummary?: Record<string, number>;
  error?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  delivery: { status: 'not_requested' | 'pending' | 'sending' | 'sent' | 'failed'; email?: string; error?: string; attempts?: number };
  /** Stable deployment scope, preventing preview workers from claiming another deployment's tasks. */
  ownerScope: string;
  idempotencyKey?: string;
  /** 上传回执只保存键和请求的摘要，不向客户端暴露或参与扫描调度。 */
  reportImportReceipts?: Array<{ key: string; requestHash: string }>;
  inputKey?: string;
  audit?: Array<Record<string, unknown>>;
  auditHeadKey?: string;
  auditCount?: number;
}
export type PublicCodeReviewTask = Omit<CodeReviewTask, 'inputKey' | 'ownerScope' | 'idempotencyKey' | 'reportImportReceipts' | 'audit' | 'auditHeadKey' | 'auditCount' | 'engineRetryRequested'>;
export function publicCodeReviewTask(task: CodeReviewTask): PublicCodeReviewTask {
  const { inputKey: _i, ownerScope: _o, idempotencyKey: _k, reportImportReceipts: _receipts, audit: _a, auditHeadKey: _h, auditCount: _c, engineRetryRequested: _r, ...visible } = task;
  return visible;
}
