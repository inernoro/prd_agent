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

/** 第三章伙伴：手写名字 + 多行理由（不要求是系统用户） */
export interface MonthlyReportPartner {
  name: string;
  reason: string;
  /** 早期版本选人时存的显示名，仅兼容旧数据 */
  legacyUserName?: string | null;
  /** 后端算好的展示名：name 为空时回退到 legacyUserName */
  displayName: string;
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
  partners: { name: string; reason: string }[];
  suggestionsText: string;
}

export interface MonthlyTeamOverviewItem {
  userId: string;
  userName: string;
  avatarFileName?: string | null;
  role: string;
  isExcused: boolean;
  /** 负责人与请假成员免交（交了照样计入已提交） */
  isExempt: boolean;
  /** not-started / draft / submitted / viewed */
  status: string;
  /** 草稿与未开始为 null（草稿只有作者可见） */
  reportId: string | null;
  submittedAt: string | null;
  weeklyLinkCount: number;
}

export interface MonthlyTeamOverview {
  teamId: string;
  teamName: string;
  year: number;
  month: number;
  memberCount: number;
  submittedCount: number;
  /** 非免交且还没提交的人数 */
  pendingCount: number;
  items: MonthlyTeamOverviewItem[];
}
