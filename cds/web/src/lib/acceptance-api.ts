import { apiRequest } from './api';
import type { AcceptanceReport, ReportVerdict } from './api';

export type AcceptanceEnvironment = 'production' | 'cds';
export type AcceptanceCaseStatus = 'pass' | 'fail' | 'blocked' | 'not-run';
export type AcceptanceView = 'templates' | 'tasks' | 'matrix' | 'reports';

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

/** Lists include immutable history; editable cards and new tasks must use the newest revision of each identity. */
export function latestAcceptanceTemplates(templates: AcceptanceTemplate[]): AcceptanceTemplate[] {
  const latest = new Map<string, AcceptanceTemplate>();
  for (const template of templates) {
    const previous = latest.get(template.id);
    if (!previous || template.version > previous.version) latest.set(template.id, template);
  }
  return [...latest.values()];
}

export interface AcceptanceEvidence {
  kind: 'image' | 'artifact' | 'trace';
  url: string;
  caption: string;
}

export interface AcceptanceSubmission {
  status: AcceptanceCaseStatus;
  actual: string;
  assertions: Array<{ id: string; passed: boolean; actual: string }>;
  evidence: AcceptanceEvidence[];
  cleanup: { status: 'pass' | 'fail' | 'not-required'; details: string };
}

export interface AcceptanceResult extends AcceptanceSubmission {
  caseId: string;
  attempts: Array<AcceptanceSubmission & { submittedAt: string }>;
  flaky: boolean;
  submittedAt: string;
}

export interface AcceptanceSummary {
  planned: number;
  executed: number;
  pass: number;
  fail: number;
  blocked: number;
  notRun: number;
  flaky: number;
  gate: 'pass' | 'fail';
}

export interface AcceptanceTask {
  id: string;
  projectId: string;
  templateId: string;
  templateVersion: number;
  title: string;
  environment: AcceptanceEnvironment;
  templateSnapshot: AcceptanceTemplate;
  cases: AcceptanceCase[];
  results: Record<string, AcceptanceResult>;
  status: 'pending' | 'running' | 'completed' | 'cancelled';
  lease?: { agentName: string; expiresAt: string; generation: number };
  summary: AcceptanceSummary;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  observedVersion?: string;
  report?: { id: string; url: string; verification: 'pending' };
}

export interface AcceptanceMatrix {
  tasks: Array<Pick<AcceptanceTask, 'id' | 'title' | 'environment' | 'summary' | 'createdAt' | 'report'>>;
  rows: Array<Pick<AcceptanceCase, 'caseId' | 'title' | 'module' | 'criticality'> & {
    templateId: string;
    cells: Array<{ taskId: string; status: AcceptanceCaseStatus; flaky: boolean; evidence: AcceptanceEvidence[]; applicable: boolean }>;
  }>;
}

export interface AcceptanceReportDraft {
  title: string;
  format: 'md';
  content: string;
  evidence: AcceptanceEvidence[];
  verification: 'pending';
  sourceId: string;
  verdict: ReportVerdict;
  defectCounts: Record<string, number>;
}

export const ACCEPTANCE_STATUS_LABELS: Record<AcceptanceCaseStatus, string> = {
  pass: '通过', fail: '失败', blocked: '阻塞', 'not-run': '未执行',
};

export function acceptanceView(value: string | null, reportId?: string): AcceptanceView {
  if (reportId) return 'reports';
  return value === 'templates' || value === 'tasks' || value === 'matrix' ? value : 'reports';
}

export function acceptanceTaskLink(projectId: string, taskId: string, caseId?: string): string {
  const query = new URLSearchParams({ project: projectId, view: 'tasks', task: taskId });
  if (caseId) query.set('case', caseId);
  return `/reports?${query.toString()}`;
}

export function acceptanceReportLink(projectId: string, reportId: string): string {
  return `/reports?${new URLSearchParams({ project: projectId, report: reportId }).toString()}`;
}

/** Evidence is online material, never an executable URL or a local draft. */
export function onlineEvidenceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    if (['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

export async function listAcceptanceTemplates(projectId: string): Promise<AcceptanceTemplate[]> {
  const data = await apiRequest<{ templates: AcceptanceTemplate[] }>(`/api/acceptance/templates?${new URLSearchParams({ projectId })}`);
  return data.templates;
}

export async function publishAcceptanceTemplate(body: {
  projectId: string; title: string; description: string; cases: AcceptanceCase[]; templateId?: string; expectedVersion?: number;
}): Promise<AcceptanceTemplate> {
  return (await apiRequest<{ template: AcceptanceTemplate }>('/api/acceptance/templates', { method: 'POST', body })).template;
}

export async function listAcceptanceTasks(projectId: string): Promise<AcceptanceTask[]> {
  return (await apiRequest<{ tasks: AcceptanceTask[] }>(`/api/acceptance/tasks?${new URLSearchParams({ projectId })}`)).tasks;
}

export async function getAcceptanceTask(id: string): Promise<AcceptanceTask> {
  return (await apiRequest<{ task: AcceptanceTask }>(`/api/acceptance/tasks/${encodeURIComponent(id)}`)).task;
}

export async function createAcceptanceTask(body: {
  projectId: string; templateId: string; templateVersion?: number; title?: string; environment: AcceptanceEnvironment; caseIds?: string[];
}): Promise<AcceptanceTask> {
  return (await apiRequest<{ task: AcceptanceTask }>('/api/acceptance/tasks', { method: 'POST', body })).task;
}

export function claimAcceptanceTask(id: string, agentName: string): Promise<{ task: AcceptanceTask; leaseToken: string }> {
  return apiRequest(`/api/acceptance/tasks/${encodeURIComponent(id)}/claim`, { method: 'POST', body: { agentName } });
}

async function leaseAction(id: string, action: 'heartbeat' | 'release' | 'complete', leaseToken: string): Promise<AcceptanceTask> {
  return (await apiRequest<{ task: AcceptanceTask }>(`/api/acceptance/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: { leaseToken } })).task;
}

export const heartbeatAcceptanceTask = (id: string, leaseToken: string): Promise<AcceptanceTask> => leaseAction(id, 'heartbeat', leaseToken);
export const releaseAcceptanceTask = (id: string, leaseToken: string): Promise<AcceptanceTask> => leaseAction(id, 'release', leaseToken);
export const completeAcceptanceTask = (id: string, leaseToken: string): Promise<AcceptanceTask> => leaseAction(id, 'complete', leaseToken);

export async function submitAcceptanceResult(id: string, caseId: string, body: AcceptanceSubmission & { leaseToken: string; submissionId: string }): Promise<AcceptanceTask> {
  return (await apiRequest<{ task: AcceptanceTask }>(`/api/acceptance/tasks/${encodeURIComponent(id)}/results/${encodeURIComponent(caseId)}`, { method: 'POST', body })).task;
}

export function generateAcceptanceReport(id: string): Promise<{ task: AcceptanceTask; report: AcceptanceReportDraft }> {
  return apiRequest(`/api/acceptance/tasks/${encodeURIComponent(id)}/report`, { method: 'POST', body: {} });
}

export async function archiveAcceptanceReport(projectId: string, draft: AcceptanceReportDraft): Promise<AcceptanceReport> {
  return (await apiRequest<{ report: AcceptanceReport }>('/api/reports', {
    method: 'POST', body: { projectId, folderPath: '核心功能巡检', title: draft.title, format: draft.format, content: draft.content, sourceId: draft.sourceId, verdict: draft.verdict, defectCounts: draft.defectCounts },
  })).report;
}

export async function bindAcceptanceReport(id: string, reportId: string): Promise<AcceptanceTask> {
  return (await apiRequest<{ task: AcceptanceTask }>(`/api/acceptance/tasks/${encodeURIComponent(id)}/bind-report`, { method: 'POST', body: { reportId } })).task;
}

export function getAcceptanceMatrix(projectId: string, templateId?: string, environment?: AcceptanceEnvironment): Promise<AcceptanceMatrix> {
  const query = new URLSearchParams({ projectId });
  if (templateId) query.set('templateId', templateId);
  if (environment) query.set('environment', environment);
  return apiRequest(`/api/acceptance/matrix?${query}`);
}
