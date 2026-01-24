import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import type {
  ListWeeklyPlanTemplatesContract,
  CreateWeeklyPlanTemplateContract,
  UpdateWeeklyPlanTemplateContract,
  DeleteWeeklyPlanTemplateContract,
  InitWeeklyPlanTemplatesContract,
  ListWeeklyPlansContract,
  ListTeamPlansContract,
  GetWeeklyPlanContract,
  CreateWeeklyPlanContract,
  UpdateWeeklyPlanContract,
  SubmitWeeklyPlanContract,
  WithdrawWeeklyPlanContract,
  ReviewWeeklyPlanContract,
  DeleteWeeklyPlanContract,
  GetWeeklyPlanStatsContract,
  WeeklyPlanTemplate,
  WeeklyPlanSubmission,
  WeeklyPlanStats,
} from '../contracts/weeklyPlan';

// ===== Template APIs =====

export const listWeeklyPlanTemplatesReal: ListWeeklyPlanTemplatesContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.activeOnly) qs.set('activeOnly', 'true');
  const q = qs.toString();
  return await apiRequest<{ items: WeeklyPlanTemplate[] }>(
    `${api.weeklyPlanAgent.templates.list()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const createWeeklyPlanTemplateReal: CreateWeeklyPlanTemplateContract = async (input) => {
  return await apiRequest<{ template: WeeklyPlanTemplate }>(api.weeklyPlanAgent.templates.list(), {
    method: 'POST',
    body: {
      name: input.name,
      description: input.description,
      sections: input.sections,
      submitDeadline: input.submitDeadline,
    },
  });
};

export const updateWeeklyPlanTemplateReal: UpdateWeeklyPlanTemplateContract = async (input) => {
  return await apiRequest<{ template: WeeklyPlanTemplate }>(
    api.weeklyPlanAgent.templates.byId(encodeURIComponent(input.id)),
    {
      method: 'PUT',
      body: {
        name: input.name,
        description: input.description,
        sections: input.sections,
        isActive: input.isActive,
        submitDeadline: input.submitDeadline,
      },
    }
  );
};

export const deleteWeeklyPlanTemplateReal: DeleteWeeklyPlanTemplateContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    api.weeklyPlanAgent.templates.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

export const initWeeklyPlanTemplatesReal: InitWeeklyPlanTemplatesContract = async () => {
  return await apiRequest<{ message: string; count: number }>(api.weeklyPlanAgent.templates.init(), {
    method: 'POST',
  });
};

// ===== Plan APIs =====

export const listWeeklyPlansReal: ListWeeklyPlansContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.status) qs.set('status', input.status);
  if (input.page) qs.set('page', String(input.page));
  if (input.pageSize) qs.set('pageSize', String(input.pageSize));
  const q = qs.toString();
  return await apiRequest<{ items: WeeklyPlanSubmission[]; total: number; page: number; pageSize: number }>(
    `${api.weeklyPlanAgent.plans.list()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const listTeamPlansReal: ListTeamPlansContract = async (input) => {
  const qs = new URLSearchParams();
  if (input.periodStart) qs.set('periodStart', input.periodStart);
  if (input.status) qs.set('status', input.status);
  if (input.userId) qs.set('userId', input.userId);
  if (input.page) qs.set('page', String(input.page));
  if (input.pageSize) qs.set('pageSize', String(input.pageSize));
  const q = qs.toString();
  return await apiRequest<{ items: WeeklyPlanSubmission[]; total: number; page: number; pageSize: number }>(
    `${api.weeklyPlanAgent.plans.team()}${q ? `?${q}` : ''}`,
    { method: 'GET' }
  );
};

export const getWeeklyPlanReal: GetWeeklyPlanContract = async (input) => {
  return await apiRequest<{ plan: WeeklyPlanSubmission }>(
    api.weeklyPlanAgent.plans.byId(encodeURIComponent(input.id)),
    { method: 'GET' }
  );
};

export const createWeeklyPlanReal: CreateWeeklyPlanContract = async (input) => {
  return await apiRequest<{ plan: WeeklyPlanSubmission }>(api.weeklyPlanAgent.plans.list(), {
    method: 'POST',
    body: {
      templateId: input.templateId,
      periodStart: input.periodStart,
      entries: input.entries,
    },
  });
};

export const updateWeeklyPlanReal: UpdateWeeklyPlanContract = async (input) => {
  return await apiRequest<{ plan: WeeklyPlanSubmission }>(
    api.weeklyPlanAgent.plans.byId(encodeURIComponent(input.id)),
    {
      method: 'PUT',
      body: { entries: input.entries },
    }
  );
};

export const submitWeeklyPlanReal: SubmitWeeklyPlanContract = async (input) => {
  return await apiRequest<{ plan: WeeklyPlanSubmission }>(
    api.weeklyPlanAgent.plans.submit(encodeURIComponent(input.id)),
    {
      method: 'PUT',
      body: { entries: input.entries },
    }
  );
};

export const withdrawWeeklyPlanReal: WithdrawWeeklyPlanContract = async (input) => {
  return await apiRequest<{ plan: WeeklyPlanSubmission }>(
    api.weeklyPlanAgent.plans.withdraw(encodeURIComponent(input.id)),
    { method: 'PUT', body: {} }
  );
};

export const reviewWeeklyPlanReal: ReviewWeeklyPlanContract = async (input) => {
  return await apiRequest<{ plan: WeeklyPlanSubmission }>(
    api.weeklyPlanAgent.plans.review(encodeURIComponent(input.id)),
    {
      method: 'PUT',
      body: { comment: input.comment },
    }
  );
};

export const deleteWeeklyPlanReal: DeleteWeeklyPlanContract = async (input) => {
  return await apiRequest<{ deleted: boolean }>(
    api.weeklyPlanAgent.plans.byId(encodeURIComponent(input.id)),
    { method: 'DELETE' }
  );
};

export const getWeeklyPlanStatsReal: GetWeeklyPlanStatsContract = async () => {
  return await apiRequest<WeeklyPlanStats>(api.weeklyPlanAgent.plans.stats(), { method: 'GET' });
};
