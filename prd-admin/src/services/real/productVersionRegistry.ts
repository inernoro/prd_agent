import type { ProductInitiation } from '@/pages/product-agent/types';

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
  plannedTrainingMinutes?: number | null;
  contractParty?: string | null;
  developmentStatus?: string | null;
  remark?: string | null;
  status: 'completed' | 'voided';
  voidReason?: string | null;
  voidedBy?: string | null;
  voidedAt?: string | null;
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
  updatedCount: number;
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
  plannedTrainingMinutes?: number;
  contractParty?: string;
  sourceRow: number;
}

export interface VersionRegistrationMessageParseResult extends VersionRegistrationFields {
  isGlobalOpen?: boolean | null;
  plannedReleaseAt?: string;
  plannedTrainingMinutes?: number;
  matchedApplicationId?: string;
  matchedInitiationId?: string;
  candidateInitiationIds?: string[];
  initiationCandidates?: ProductInitiation[];
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
