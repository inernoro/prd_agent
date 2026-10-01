/** 结构化验收合同；业务结论与线上报告交付验证分开记录。 */
export type AcceptanceEnvironment = 'production' | 'cds';
export type AcceptanceResultStatus = 'pass' | 'fail' | 'blocked' | 'not-run';

export interface AcceptanceCase {
  caseId: string;
  title: string;
  module: string;
  criticality: 'core' | 'standard';
  environments: AcceptanceEnvironment[];
  breadcrumb: string[];
  entryPath: string;
  preconditions: string[];
  inputs: Array<{ name: string; value: string }>;
  steps: Array<{ id: string; action: string; expected: string }>;
  assertions: Array<{ id: string; description: string }>;
  evidenceRequired: boolean;
  cleanup: 'required' | 'none';
  cleanupInstructions: string;
  owner: string;
}

export interface AcceptanceTemplate {
  id: string;
  projectId: string;
  title: string;
  description: string;
  version: number;
  cases: AcceptanceCase[];
  createdAt: string;
}

export interface AcceptanceEvidence {
  kind: 'image' | 'artifact' | 'trace';
  url: string;
  caption: string;
}

export interface AcceptanceSubmission {
  submissionId: string;
  status: AcceptanceResultStatus;
  actual: string;
  assertions: Array<{ id: string; passed: boolean; actual: string }>;
  evidence: AcceptanceEvidence[];
  cleanup: { status: 'pass' | 'fail' | 'not-required'; details: string };
}

export interface AcceptanceAttempt extends AcceptanceSubmission {
  submittedAt: string;
}

export interface AcceptanceCaseResult extends AcceptanceAttempt {
  caseId: string;
  attempts: AcceptanceAttempt[];
  flaky: boolean;
}

export interface AcceptanceSummary {
  planned: number;
  executed: number;
  pass: number;
  fail: number;
  blocked: number;
  notRun: number;
  flaky: number;
  /** 仅业务结论；不能据此声称报告已归档、verify-open 或允许发布。 */
  gate: 'pass' | 'fail';
}

export interface AcceptanceTask {
  id: string;
  projectId: string;
  templateId: string;
  templateVersion: number;
  title: string;
  environment: AcceptanceEnvironment;
  observedVersion?: string;
  templateSnapshot: AcceptanceTemplate;
  cases: AcceptanceCase[];
  results: Record<string, AcceptanceCaseResult>;
  status: 'pending' | 'running' | 'completed' | 'cancelled';
  lease?: { agentName: string; expiresAt: string; generation: number };
  summary: AcceptanceSummary;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  report?: { id: string; url: string; verification: 'pending' };
}

/** 持久层内部字段；任何 API/SSE 读取均不得暴露。 */
export interface StoredAcceptanceTask extends AcceptanceTask {
  leaseTokenHash?: string;
  leaseGeneration: number;
}

export interface AcceptanceReportSource {
  title: string;
  format: 'md';
  content: string;
  sourceId: string;
  verdict: 'pass' | 'conditional' | 'fail';
  defectCounts: { p0: number; p1: number };
  evidence: AcceptanceEvidence[];
  verification: 'pending';
}
