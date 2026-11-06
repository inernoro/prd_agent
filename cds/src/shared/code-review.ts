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
  inputKey?: string;
  audit?: Array<Record<string, unknown>>;
  auditHeadKey?: string;
  auditCount?: number;
}
export type PublicCodeReviewTask = Omit<CodeReviewTask, 'inputKey' | 'ownerScope' | 'idempotencyKey' | 'audit' | 'auditHeadKey' | 'auditCount'>;
export function publicCodeReviewTask(task: CodeReviewTask): PublicCodeReviewTask {
  const { inputKey: _i, ownerScope: _o, idempotencyKey: _k, audit: _a, auditHeadKey: _h, auditCount: _c, ...visible } = task;
  return visible;
}
