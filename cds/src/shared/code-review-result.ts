/** Persisted analysis data shared by the reader and the project-scoped MCP. */
export interface CodeReviewFinding {
  id?: string;
  title?: string;
  filePath: string;
  line?: number;
  endLine?: number;
  category: 'bug' | 'security' | 'performance' | 'style' | 'maintainability';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  message: string;
  suggestion?: string;
  codeSnippet?: string;
  aiExplanation?: string;
  verified: false;
  tool: string;
}

export interface CodeReviewResult {
  version: 1;
  taskId: string;
  projectId: string;
  sourceHash?: string;
  commitSha?: string;
  origin: 'analysis' | 'archived-markdown';
  findings: CodeReviewFinding[];
  notes: string[];
}

export interface CodeReviewResultPage extends Omit<CodeReviewResult, 'findings'> {
  findings: Array<CodeReviewFinding & { index: number }>;
  summary: Record<CodeReviewFinding['severity'], number>;
  coverage: { totalFiles: number; scannedFiles: number; unfinishedFiles: number; inputSkippedFiles: number; complete: boolean };
  page: { offset: number; limit: number; total: number; nextOffset: number | null };
}

export const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const REVIEW_CATEGORIES = { bug: 'Bug', security: '安全', performance: '性能', style: '风格', maintainability: '可维护性' } as const;
export const REVIEW_SEVERITY_LABELS = { critical: '严重', high: '高风险', medium: '中风险', low: '低风险', info: '提示' } as const;
