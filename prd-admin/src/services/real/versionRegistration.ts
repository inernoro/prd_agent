import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';

export type VersionRegistrationKind = 'internal' | 'formal';
export type VersionRegistrationSourceType = 'review_submission' | 'internal_registration' | 'manual_t' | 'history_import';

export interface VersionRegistration {
  id: string;
  systemId?: string | null;
  systemName?: string | null;
  applicationId?: string | null;
  applicationName?: string | null;
  kind: VersionRegistrationKind;
  code: string;
  tCode?: string | null;
  sourceType: VersionRegistrationSourceType;
  reviewSubmissionId?: string | null;
  sourceInternalRegistrationId?: string | null;
  projectType: 'standard' | 'custom';
  versionType: 'major' | 'medium' | 'minor';
  needUiDesign?: boolean | null;
  isAiPoc?: boolean | null;
  isGlobalOpen?: boolean | null;
  demandSource?: string | null;
  planName?: string | null;
  planUrl?: string | null;
  requirementDescription?: string | null;
  departmentName?: string | null;
  ownerName?: string | null;
  projectMemberNames: string[];
  plannedProjectAt?: string | null;
  plannedReleaseAt?: string | null;
  contractParty?: string | null;
  developmentStatus?: string | null;
  remark?: string | null;
  status: 'completed';
  createdBy: string;
  createdByName?: string | null;
  sourceSnapshotId?: string | null;
  createdAt: string;
}

export interface VersionRegistrationReviewSource {
  id: string;
  title: string;
  fileName: string;
  isPassed?: boolean | null;
  completedAt?: string | null;
}

export interface VersionRegistrationSnapshotSummary {
  id: string;
  name: string;
  sourceType: 'history_import' | 'current_registry';
  sourceFileName?: string | null;
  importedCount: number;
  skippedCount: number;
  recordCount: number;
  createdAt: string;
  createdByName?: string | null;
}

export interface VersionRegistrationFields {
  applicationId?: string;
  projectType?: 'standard' | 'custom';
  versionType?: 'major' | 'medium' | 'minor';
  needUiDesign?: boolean | null;
  isAiPoc?: boolean | null;
  demandSource?: string;
  planName?: string;
  planUrl?: string;
  requirementDescription?: string;
  departmentName?: string;
  ownerName?: string;
  projectMemberNames?: string[];
  plannedProjectAt?: string;
  developmentStatus?: string;
  remark?: string;
}

export interface VersionRegistrationImportRow extends VersionRegistrationFields {
  systemName?: string;
  applicationName?: string;
  kind: VersionRegistrationKind;
  code?: string;
  tCode?: string;
  isGlobalOpen?: boolean | null;
  plannedReleaseAt?: string;
  contractParty?: string;
  sourceRow: number;
}

export interface VersionRegistrationMessageParseResult extends VersionRegistrationFields {
  isGlobalOpen?: boolean | null;
  plannedReleaseAt?: string;
  tCode?: string;
  matchedFields: string[];
}

export interface VersionRegistryApplication {
  id: string;
  name: string;
  systemId: string;
  systemName: string;
  internalBaselineCode?: string | null;
  formalBaselineCode?: string | null;
  source: 'history_seed' | 'manual';
  createdAt: string;
  updatedAt: string;
}

export interface VersionRegistrySystem {
  id: string;
  name: string;
  source: 'history_seed' | 'manual';
  applications: VersionRegistryApplication[];
}

export interface VersionRegistryMatch {
  id: string;
  name: string;
  systemId: string;
  systemName: string;
}

export interface PublicVersionRegistrationFilters {
  kind?: VersionRegistrationKind;
  systemId?: string;
  applicationId?: string;
  person?: string;
  planName?: string;
}

export function getVersionRegistrationReviewSources(): Promise<ApiResponse<{ items: VersionRegistrationReviewSource[] }>> {
  return apiRequest('/api/review-agent/version-registrations/review-sources');
}

export function getVersionRegistrationInternalSources(applicationId?: string): Promise<ApiResponse<{ items: VersionRegistration[] }>> {
  const query = applicationId ? `?applicationId=${encodeURIComponent(applicationId)}` : '';
  return apiRequest(`/api/review-agent/version-registrations/internal-sources${query}`);
}

export function getVersionRegistry(): Promise<ApiResponse<{ systems: VersionRegistrySystem[] }>> {
  return apiRequest('/api/review-agent/version-registrations/registry');
}

export function findVersionRegistryMatches(planName: string): Promise<ApiResponse<{ items: VersionRegistryMatch[] }>> {
  return apiRequest(`/api/review-agent/version-registrations/registry/matches?planName=${encodeURIComponent(planName)}`);
}

export function createVersionRegistrySystem(name: string): Promise<ApiResponse<{ system: VersionRegistrySystem; reused: boolean }>> {
  return apiRequest('/api/review-agent/version-registrations/registry/systems', { method: 'POST', body: { name } });
}

export function createVersionRegistryApplication(input: { systemId: string; name: string }): Promise<ApiResponse<{ application: VersionRegistryApplication; reused: boolean }>> {
  return apiRequest('/api/review-agent/version-registrations/registry/applications', { method: 'POST', body: input });
}

export function getPublicVersionRegistrations(filters: PublicVersionRegistrationFilters = {}): Promise<ApiResponse<{ items: VersionRegistration[] }>> {
  const params = new URLSearchParams({ limit: '200' });
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.systemId) params.set('systemId', filters.systemId);
  if (filters.applicationId) params.set('applicationId', filters.applicationId);
  if (filters.person?.trim()) params.set('person', filters.person.trim());
  if (filters.planName?.trim()) params.set('planName', filters.planName.trim());
  return apiRequest(`/api/review-agent/version-registrations/public?${params.toString()}`);
}

export function getVersionRegistrations(): Promise<ApiResponse<{ items: VersionRegistration[]; canViewAll: boolean }>> {
  return apiRequest('/api/review-agent/version-registrations');
}

export function getVersionRegistrationSnapshots(): Promise<ApiResponse<{ items: VersionRegistrationSnapshotSummary[]; canViewAll: boolean }>> {
  return apiRequest('/api/review-agent/version-registrations/snapshots');
}

export function parseVersionRegistrationMessage(input: {
  kind: VersionRegistrationKind;
  text: string;
}): Promise<ApiResponse<{ result: VersionRegistrationMessageParseResult }>> {
  return apiRequest('/api/review-agent/version-registrations/parse-message', { method: 'POST', body: input });
}

export function createInternalVersionRegistration(
  input: VersionRegistrationFields & { reviewSubmissionId: string },
): Promise<ApiResponse<{ record: VersionRegistration }>> {
  return apiRequest('/api/review-agent/version-registrations/internal', { method: 'POST', body: input });
}

export function createFormalVersionRegistration(
  input: VersionRegistrationFields & {
    sourceMode: 'manual_t' | 'internal_registration';
    sourceInternalRegistrationId?: string;
    tCode?: string;
    isGlobalOpen?: boolean | null;
    plannedReleaseAt?: string;
    contractParty?: string;
  },
): Promise<ApiResponse<{ record: VersionRegistration }>> {
  return apiRequest('/api/review-agent/version-registrations/formal', { method: 'POST', body: input });
}

export function importVersionRegistrations(input: {
  snapshotName?: string;
  sourceAttachmentId: string;
  sourceFileName: string;
  rows: VersionRegistrationImportRow[];
}): Promise<ApiResponse<{ created: number; skipped: number }>> {
  return apiRequest('/api/review-agent/version-registrations/import', { method: 'POST', body: input });
}

export function createCurrentVersionRegistrationSnapshot(name?: string): Promise<ApiResponse<{ snapshot: VersionRegistrationSnapshotSummary }>> {
  return apiRequest('/api/review-agent/version-registrations/snapshots/current', { method: 'POST', body: { name } });
}
