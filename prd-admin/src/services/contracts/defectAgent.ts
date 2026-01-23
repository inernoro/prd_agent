import type { ApiResponse } from '@/types/api';

// ============ Data Models ============

export type DefectStatus =
  | 'Draft'
  | 'Submitted'
  | 'Reviewing'
  | 'Analyzed'
  | 'Rejected'
  | 'Fixing'
  | 'PrCreated'
  | 'Merged'
  | 'Verified'
  | 'Closed';

export type DefectPriority = 'P0_Blocker' | 'P1_Critical' | 'P2_Normal' | 'P3_Minor';
export type DefectImpact = 'CoreFunction' | 'EdgeFunction' | 'UiCosmetic' | 'Performance' | 'Security';
export type ReproConfidence = 'High' | 'Medium' | 'Low' | 'Unknown';
export type ReviewPhase = 'Triage' | 'Analysis' | 'Fix' | 'Verify';
export type ReviewVerdict = 'Pass' | 'NeedInfo' | 'Duplicate' | 'Invalid' | 'CanAutoFix' | 'NeedManualFix' | 'MajorChange';
export type FixLevel = 'Auto' | 'SemiAuto' | 'Manual';
export type FixStatus = 'Pending' | 'InProgress' | 'PrCreated' | 'Merged' | 'Rejected' | 'Failed';
export type GitHubAuthMethod = 'GitHubApp' | 'PersonalAccessToken' | 'OAuth';

export type DefectEnvironment = {
  browser?: string;
  os?: string;
  appVersion?: string;
  screenResolution?: string;
  customFields?: Record<string, string>;
};

export type DefectReport = {
  id: string;
  ownerUserId: string;
  title: string;
  description: string;
  reproSteps: string[];
  expectedBehavior?: string;
  actualBehavior?: string;
  environment?: DefectEnvironment;
  attachmentIds: string[];
  status: DefectStatus;
  priority?: DefectPriority;
  impact?: DefectImpact;
  reproConfidence?: ReproConfidence;
  repoConfigId?: string;
  productId?: string;
  moduleId?: string;
  githubIssueNumber?: number;
  githubPrNumber?: number;
  assigneeUserId?: string;
  tags: string[];
  duplicateOfId?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
};

export type CodeLocation = {
  filePath: string;
  startLine?: number;
  endLine?: number;
  reason?: string;
  confidence: number;
};

export type FixSuggestion = {
  level: FixLevel;
  patchContent?: string;
  pseudoCode?: string;
  analysisReport?: string;
  affectedFiles?: string[];
  riskAssessment?: string;
};

export type DefectReview = {
  id: string;
  defectId: string;
  phase: ReviewPhase;
  verdict: ReviewVerdict;
  content: string;
  locatedFiles?: CodeLocation[];
  suggestion?: FixSuggestion;
  llmRequestId?: string;
  createdAt: string;
};

export type DefectFix = {
  id: string;
  defectId: string;
  reviewId?: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  status: FixStatus;
  commitSha?: string;
  changes?: FileChange[];
  createdAt: string;
  mergedAt?: string;
};

export type FileChange = {
  filePath: string;
  changeType: string;
  linesAdded: number;
  linesRemoved: number;
};

export type DefectRepoConfig = {
  id: string;
  ownerUserId: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  prBranchPrefix: string;
  defaultReviewers: string[];
  defaultLabels: string[];
  authMethod: GitHubAuthMethod;
  installationId?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DefectStats = {
  total: number;
  open: number;
  fixed: number;
};

// ============ Request Types ============

export type CreateDefectInput = {
  title: string;
  description?: string;
  reproSteps?: string[];
  expectedBehavior?: string;
  actualBehavior?: string;
  environment?: DefectEnvironment;
  attachmentIds?: string[];
  repoConfigId?: string;
  productId?: string;
  moduleId?: string;
  tags?: string[];
};

export type UpdateDefectInput = {
  title?: string;
  description?: string;
  reproSteps?: string[];
  expectedBehavior?: string;
  actualBehavior?: string;
  environment?: DefectEnvironment;
  attachmentIds?: string[];
  tags?: string[];
  repoConfigId?: string;
};

export type CreateRepoConfigInput = {
  repoOwner: string;
  repoName: string;
  defaultBranch?: string;
  prBranchPrefix?: string;
  defaultReviewers?: string[];
  defaultLabels?: string[];
  authMethod: GitHubAuthMethod;
  installationId?: string;
};

export type UpdateRepoConfigInput = {
  defaultBranch?: string;
  prBranchPrefix?: string;
  defaultReviewers?: string[];
  defaultLabels?: string[];
  isActive?: boolean;
};

// ============ Contract Types ============

export type ListDefectsContract = (params?: {
  status?: string;
  priority?: string;
  limit?: number;
  offset?: number;
}) => Promise<ApiResponse<{ items: DefectReport[]; total: number }>>;

export type GetDefectContract = (id: string) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type CreateDefectContract = (input: CreateDefectInput) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type UpdateDefectContract = (id: string, input: UpdateDefectInput) => Promise<ApiResponse<{ defect: DefectReport }>>;

export type DeleteDefectContract = (id: string) => Promise<ApiResponse<{ deleted: boolean }>>;

export type SubmitDefectContract = (id: string) => Promise<ApiResponse<{ runId: string }>>;

export type TriggerFixContract = (id: string) => Promise<ApiResponse<{ runId: string }>>;

export type VerifyFixContract = (id: string) => Promise<ApiResponse<{ verified: boolean }>>;

export type CloseDefectContract = (id: string) => Promise<ApiResponse<{ closed: boolean }>>;

export type ReopenDefectContract = (id: string) => Promise<ApiResponse<{ reopened: boolean }>>;

export type GetReviewsContract = (defectId: string) => Promise<ApiResponse<{ reviews: DefectReview[] }>>;

export type GetFixesContract = (defectId: string) => Promise<ApiResponse<{ fixes: DefectFix[] }>>;

export type ListRepoConfigsContract = () => Promise<ApiResponse<{ configs: DefectRepoConfig[] }>>;

export type CreateRepoConfigContract = (input: CreateRepoConfigInput) => Promise<ApiResponse<{ config: DefectRepoConfig }>>;

export type UpdateRepoConfigContract = (id: string, input: UpdateRepoConfigInput) => Promise<ApiResponse<{ config: DefectRepoConfig }>>;

export type DeleteRepoConfigContract = (id: string) => Promise<ApiResponse<{ deleted: boolean }>>;

export type GetDefectStatsContract = () => Promise<ApiResponse<DefectStats>>;
