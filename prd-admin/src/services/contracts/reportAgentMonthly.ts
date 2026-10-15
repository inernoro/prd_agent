import type { ReportVersionEntry } from './reportAgent';

/** 月报状态：草稿 → 已提交 → 已查看（负责人打开后自动标记） */
export type MonthlyReportStatus = 'draft' | 'submitted' | 'viewed';

export interface MonthlyReportWeeklyLink {
  weeklyReportId: string;
  weekYear: number;
  weekNumber: number;
  periodStart: string;
  periodEnd: string;
}

export interface MonthlyReportPartner {
  userId: string;
  userName?: string;
  avatarFileName?: string;
  reason: string;
}

export interface MonthlyReport {
  id: string;
  userId: string;
  userName?: string;
  avatarFileName?: string;
  teamId: string;
  teamName?: string;
  year: number;
  month: number;
  status: MonthlyReportStatus;
  weeklyLinks: MonthlyReportWeeklyLink[];
  achievementsText: string;
  problemsText?: string | null;
  partners: MonthlyReportPartner[];
  suggestionsText?: string | null;
  submittedAt?: string | null;
  viewedAt?: string | null;
  versionHistory?: ReportVersionEntry[];
  createdAt: string;
  updatedAt: string;
}

/** 关联周报的实时状态：周报被删除时 exists=false */
export interface MonthlyLinkedWeekly extends MonthlyReportWeeklyLink {
  exists: boolean;
  status?: string | null;
}

/** 后端按提交规则算出的未完成项（chapter 为章节序号 0-3，-1 为整份） */
export interface MonthlySubmitIssue {
  chapter: number;
  message: string;
}

export interface MonthlyReportDetail {
  report: MonthlyReport;
  linkedWeeklies: MonthlyLinkedWeekly[];
  canEdit: boolean;
  /** 仅作者可见；为空数组表示可以提交 */
  submitIssues: MonthlySubmitIssue[] | null;
  /** 章节标题（后端 SSOT） */
  chapterTitles: string[];
}

export type WeeklyCandidateGroup = 'current' | 'adjacent' | 'other';

export interface MonthlyWeeklyCandidate extends MonthlyReportWeeklyLink {
  status: string;
  attributedYear: number;
  attributedMonth: number;
  group: WeeklyCandidateGroup;
  linkable: boolean;
}

export interface UpdateMonthlyReportInput {
  id: string;
  weeklyReportIds: string[];
  achievementsText: string;
  problemsText: string;
  partners: { userId: string; reason: string }[];
  suggestionsText: string;
}
