import type { ApiResponse } from '@/types/api';

// ===== Template Types =====

export interface TableColumnDef {
  name: string;
  type: 'text' | 'number' | 'select' | 'date' | 'progress';
  options?: string[];
  width?: string;
}

export interface TemplateSectionDef {
  id: string;
  title: string;
  type: 'text' | 'list' | 'table' | 'progress' | 'checklist';
  required: boolean;
  placeholder?: string;
  maxItems?: number;
  columns?: TableColumnDef[];
  order: number;
}

export interface WeeklyPlanTemplate {
  id: string;
  name: string;
  description: string;
  sections: TemplateSectionDef[];
  isBuiltIn: boolean;
  isActive: boolean;
  submitDeadline?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ===== Submission Types =====

export interface PlanSectionEntry {
  sectionId: string;
  value: unknown;
}

export interface ChecklistItem {
  text: string;
  checked: boolean;
}

export interface WeeklyPlanSubmission {
  id: string;
  templateId: string;
  templateName: string;
  userId: string;
  userDisplayName: string;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'submitted' | 'reviewed';
  entries: PlanSectionEntry[];
  submittedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  carryOverFromId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyPlanStats {
  thisWeek: {
    total: number;
    draft: number;
    submitted: number;
    reviewed: number;
  };
  periodStart: string;
  periodEnd: string;
}

// ===== Template Contracts =====

export type ListWeeklyPlanTemplatesContract = (input: {
  activeOnly?: boolean;
}) => Promise<ApiResponse<{ items: WeeklyPlanTemplate[] }>>;

export type CreateWeeklyPlanTemplateContract = (input: {
  name: string;
  description?: string;
  sections: Omit<TemplateSectionDef, 'order'>[];
  submitDeadline?: string;
}) => Promise<ApiResponse<{ template: WeeklyPlanTemplate }>>;

export type UpdateWeeklyPlanTemplateContract = (input: {
  id: string;
  name?: string;
  description?: string;
  sections?: Omit<TemplateSectionDef, 'order'>[];
  isActive?: boolean;
  submitDeadline?: string;
}) => Promise<ApiResponse<{ template: WeeklyPlanTemplate }>>;

export type DeleteWeeklyPlanTemplateContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ deleted: boolean }>>;

export type InitWeeklyPlanTemplatesContract = () => Promise<ApiResponse<{ message: string; count: number }>>;

// ===== Plan Contracts =====

export type ListWeeklyPlansContract = (input: {
  status?: string;
  page?: number;
  pageSize?: number;
}) => Promise<ApiResponse<{ items: WeeklyPlanSubmission[]; total: number; page: number; pageSize: number }>>;

export type ListTeamPlansContract = (input: {
  periodStart?: string;
  status?: string;
  userId?: string;
  page?: number;
  pageSize?: number;
}) => Promise<ApiResponse<{ items: WeeklyPlanSubmission[]; total: number; page: number; pageSize: number }>>;

export type GetWeeklyPlanContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ plan: WeeklyPlanSubmission }>>;

export type CreateWeeklyPlanContract = (input: {
  templateId: string;
  periodStart?: string;
  entries?: PlanSectionEntry[];
}) => Promise<ApiResponse<{ plan: WeeklyPlanSubmission }>>;

export type UpdateWeeklyPlanContract = (input: {
  id: string;
  entries: PlanSectionEntry[];
}) => Promise<ApiResponse<{ plan: WeeklyPlanSubmission }>>;

export type SubmitWeeklyPlanContract = (input: {
  id: string;
  entries?: PlanSectionEntry[];
}) => Promise<ApiResponse<{ plan: WeeklyPlanSubmission }>>;

export type WithdrawWeeklyPlanContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ plan: WeeklyPlanSubmission }>>;

export type ReviewWeeklyPlanContract = (input: {
  id: string;
  comment?: string;
}) => Promise<ApiResponse<{ plan: WeeklyPlanSubmission }>>;

export type DeleteWeeklyPlanContract = (input: {
  id: string;
}) => Promise<ApiResponse<{ deleted: boolean }>>;

export type GetWeeklyPlanStatsContract = () => Promise<ApiResponse<WeeklyPlanStats>>;
