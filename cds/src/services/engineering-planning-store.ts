import {
  FileProjectRevisionStore, MongoProjectRevisionStore, type ProjectRevisionAsset, type ProjectRevisionStore,
} from './project-revision-store.js';
import type {
  PlanningDebt, PlanningDecision, PlanningEvent, PlanningPlan, PlanningProposal, PlanningReceipt,
} from '../shared/engineering-planning.js';
import type { PlanningPullRequestSnapshot } from './engineering-planning-pull-requests.js';
import type { PlanningNoticeRecord } from './engineering-planning-checkup.js';

export type PlanningEvidenceAsset = ProjectRevisionAsset;
export type EngineeringPlanningCommandRequest = { key: string; fingerprint: string; receipt: PlanningReceipt };

export interface EngineeringPlanningCommit {
  projectId: string;
  revision: number;
  request?: EngineeringPlanningCommandRequest | { key: string; internal: true };
  debts: PlanningDebt[];
  decisions: PlanningDecision[];
  plans: PlanningPlan[];
  proposals: PlanningProposal[];
  events: PlanningEvent[];
  assets?: PlanningEvidenceAsset[];
  pullRequests?: PlanningPullRequestSnapshot[];
  notices?: PlanningNoticeRecord[];
  duplicateBaselineRevision?: number;
  reportedDuplicatePairs?: string[];
}

/** A revision publishes a command receipt or a GitHub observation together with changes. */
export type EngineeringPlanningStore = ProjectRevisionStore<EngineeringPlanningCommit>;

export class FileEngineeringPlanningStore extends FileProjectRevisionStore<EngineeringPlanningCommit> {}

export class MongoEngineeringPlanningStore extends MongoProjectRevisionStore<EngineeringPlanningCommit> {
  constructor(uri: string, database: string) {
    super(uri, database, 'cds_engineering_planning_commits');
  }
}
