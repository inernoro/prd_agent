import type { ApiResponse } from '@/types/api';

// ========== Data Models ==========

export interface ReportTeam {
  id: string;
  name: string;
  parentTeamId?: string;
  leaderUserId: string;
  leaderName?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReportTeamMember {
  id: string;
  teamId: string;
  userId: string;
  userName?: string;
  avatarFileName?: string;
  role: string;
  jobTitle?: string;
  joinedAt: string;
}

export interface ReportTemplate {
  id: string;
  name: string;
  description?: string;
  sections: ReportTemplateSection[];
  teamId?: string;
  jobTitle?: string;
  isDefault: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReportTemplateSection {
  title: string;
  description?: string;
  inputType: string;
  isRequired: boolean;
  sortOrder: number;
  dataSourceHint?: string;
  maxItems?: number;
}

export interface WeeklyReport {
  id: string;
  userId: string;
  userName?: string;
  avatarFileName?: string;
  teamId: string;
  teamName?: string;
  templateId: string;
  weekYear: number;
  weekNumber: number;
  periodStart: string;
  periodEnd: string;
  status: string;
  sections: WeeklyReportSection[];
  submittedAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewedByName?: string;
  returnReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyReportSection {
  templateSection: ReportTemplateSection;
  items: WeeklyReportItem[];
}

export interface WeeklyReportItem {
  content: string;
  source: string;
  sourceRef?: string;
}

export interface ReportUser {
  id: string;
  username: string;
  displayName?: string;
  avatarFileName?: string;
}

export interface TeamDashboardMember {
  userId: string;
  userName?: string;
  avatarFileName?: string;
  role: string;
  jobTitle?: string;
  reportId?: string;
  reportStatus: string;
  submittedAt?: string;
}

export interface TeamDashboardStats {
  total: number;
  submitted: number;
  reviewed: number;
  draft: number;
  notStarted: number;
}

export interface TeamDashboardData {
  team: ReportTeam;
  weekYear: number;
  weekNumber: number;
  periodStart: string;
  periodEnd: string;
  members: TeamDashboardMember[];
  stats: TeamDashboardStats;
}

// ========== Constants ==========

export const WeeklyReportStatus = {
  NotStarted: 'not-started',
  Draft: 'draft',
  Submitted: 'submitted',
  Reviewed: 'reviewed',
  Returned: 'returned',
  Overdue: 'overdue',
} as const;

export const ReportTeamRole = {
  Member: 'member',
  Leader: 'leader',
  Deputy: 'deputy',
} as const;

export const ReportInputType = {
  BulletList: 'bullet-list',
  RichText: 'rich-text',
  KeyValue: 'key-value',
  ProgressTable: 'progress-table',
} as const;

// ========== Contract Types ==========

// --- Teams ---
export type ListReportTeamsContract = () => Promise<ApiResponse<{ items: ReportTeam[] }>>;

export type GetReportTeamContract = (input: { id: string }) => Promise<
  ApiResponse<{ team: ReportTeam; members: ReportTeamMember[] }>
>;

export type CreateReportTeamContract = (input: {
  name: string;
  leaderUserId: string;
  parentTeamId?: string;
  description?: string;
}) => Promise<ApiResponse<{ team: ReportTeam }>>;

export type UpdateReportTeamContract = (input: {
  id: string;
  name?: string;
  leaderUserId?: string;
  description?: string;
}) => Promise<ApiResponse<{ team: ReportTeam }>>;

export type DeleteReportTeamContract = (input: { id: string }) => Promise<ApiResponse<object>>;

// --- Team Members ---
export type AddReportTeamMemberContract = (input: {
  teamId: string;
  userId: string;
  role?: string;
  jobTitle?: string;
}) => Promise<ApiResponse<{ member: ReportTeamMember }>>;

export type RemoveReportTeamMemberContract = (input: {
  teamId: string;
  userId: string;
}) => Promise<ApiResponse<object>>;

export type UpdateReportTeamMemberContract = (input: {
  teamId: string;
  userId: string;
  role?: string;
  jobTitle?: string;
}) => Promise<ApiResponse<{ member: ReportTeamMember }>>;

// --- Users ---
export type ListReportUsersContract = () => Promise<ApiResponse<{ items: ReportUser[] }>>;

// --- Templates ---
export type ListReportTemplatesContract = () => Promise<ApiResponse<{ items: ReportTemplate[] }>>;

export type GetReportTemplateContract = (input: { id: string }) => Promise<
  ApiResponse<{ template: ReportTemplate }>
>;

export type CreateReportTemplateContract = (input: {
  name: string;
  description?: string;
  sections: Partial<ReportTemplateSection>[];
  teamId?: string;
  jobTitle?: string;
  isDefault?: boolean;
}) => Promise<ApiResponse<{ template: ReportTemplate }>>;

export type UpdateReportTemplateContract = (input: {
  id: string;
  name?: string;
  description?: string;
  sections?: Partial<ReportTemplateSection>[];
  teamId?: string;
  jobTitle?: string;
  isDefault?: boolean;
}) => Promise<ApiResponse<{ template: ReportTemplate }>>;

export type DeleteReportTemplateContract = (input: { id: string }) => Promise<ApiResponse<object>>;

// --- Reports ---
export type ListWeeklyReportsContract = (input?: {
  scope?: 'my' | 'team';
  teamId?: string;
  weekYear?: number;
  weekNumber?: number;
}) => Promise<ApiResponse<{ items: WeeklyReport[] }>>;

export type GetWeeklyReportContract = (input: { id: string }) => Promise<
  ApiResponse<{ report: WeeklyReport }>
>;

export type CreateWeeklyReportContract = (input: {
  teamId: string;
  templateId: string;
  weekYear?: number;
  weekNumber?: number;
}) => Promise<ApiResponse<{ report: WeeklyReport }>>;

export type UpdateWeeklyReportContract = (input: {
  id: string;
  sections: { items: { content: string; source?: string; sourceRef?: string }[] }[];
}) => Promise<ApiResponse<{ report: WeeklyReport }>>;

export type DeleteWeeklyReportContract = (input: { id: string }) => Promise<ApiResponse<object>>;

export type SubmitWeeklyReportContract = (input: { id: string }) => Promise<
  ApiResponse<{ report: WeeklyReport }>
>;

export type ReviewWeeklyReportContract = (input: { id: string }) => Promise<
  ApiResponse<{ report: WeeklyReport }>
>;

export type ReturnWeeklyReportContract = (input: {
  id: string;
  reason?: string;
}) => Promise<ApiResponse<{ report: WeeklyReport }>>;

// --- Dashboard ---
export type GetTeamDashboardContract = (input: {
  teamId: string;
  weekYear?: number;
  weekNumber?: number;
}) => Promise<ApiResponse<TeamDashboardData>>;
