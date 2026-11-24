import type { DesignAcceptancePlan, DesignCoverageRecord, DesignDimension, DesignFlow, DesignKnownIssue, DesignMethodId, DesignRegression, DesignSmoke } from './design-methods.js';
import type { DesignVisualRow } from './design-visual.js';
import type { DesignVerdict, DesignCellStatus } from '../services/design-acceptance.js';

export const designSlots = ['desktop-light', 'desktop-dark', 'phone-light', 'phone-dark'] as const;
export type DesignSlot = typeof designSlots[number];
export type DesignTheme = 'light' | 'dark';
export const designViewports = { desktop: { width: 1280, height: 800 }, phone: { width: 375, height: 812 } } as const;
export type DesignScreen = {
  id: string; name: string; route: string; viewport: 'desktop' | 'phone'; themes: DesignTheme[]; impl: string | null;
  readySelector?: string;
  entryActions?: string[];
  entryReadySelector?: string;
  entryTimeoutMs?: number;
};
export type DesignRule = {
  id: string; rule: string; how: 'measure' | 'screenshot' | 'human'; priority: 'high' | 'normal';
  slots: readonly DesignSlot[]; screenId?: string; expected?: string; dimension?: DesignDimension; requirementRef?: string;
  probe?: { type: 'horizontal-overflow'; tolerance?: number };
};
export type DesignMaterial = { tokens?: Record<string, unknown>; rules?: string; components?: string; skeleton?: string };
export const designMaterialKeys = ['tokens', 'rules', 'components', 'skeleton'] as const;
export type DesignMaterialKey = typeof designMaterialKeys[number];
export type FrameworkResolutions = Partial<Record<DesignMaterialKey, 'keep' | 'adopt'>>;

export type DesignFrameworkCharter = {
  status: 'adopted' | 'draft' | 'deprecated';
  intent: string;
  problems: string[];
  nonGoals: string[];
  scope: { system: string; modules: string[] };
  owner: string;
  example?: { designId: string; version: number };
  ruleSources?: Array<{ rule: string; from: string; evidence: string }>;
  moduleDiffs?: Array<{ module: string; diff: string; reason: string; decision: 'module' | 'framework' | 'pending' }>;
};

function comparableMaterial(value: unknown) {
  if (typeof value === 'string') return value.replace(/\r\n/g, '\n').trim();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
  });
}

export function frameworkMaterialCandidates(proposed: DesignMaterial, existing?: DesignMaterial) {
  return designMaterialKeys.flatMap(key => {
    if (proposed[key] === undefined) return [];
    const state = existing?.[key] === undefined ? 'new'
      : comparableMaterial(proposed[key]) === comparableMaterial(existing[key]) ? 'same' : 'conflict';
    return [{ key, state }];
  });
}
export type DesignNestedScroll = { status: 'passed' }
  | { status: 'failed' | 'unverified'; element: string; width: number; contentWidth: number };
export type DesignFrameworkMeasurement = {
  screenId: string; slot: 'phone-light' | 'phone-dark'; width: number; contentWidth: number;
  nestedScroll?: DesignNestedScroll;
};
export type DesignFrameworkCheck = {
  framework: string; frameworkVersion: number; sourceCommit: string;
  items: Array<{
    ruleId: string; name: string; status: 'passed' | 'failed' | 'unverified'; actual: string;
    measurements?: DesignFrameworkMeasurement[];
  }>;
};

export type DesignDeliveryFile = {
  id: string;
  path: string;
  kind: 'manifest' | 'guide' | 'rationale' | 'document' | 'framework' | 'checks' | 'prototype' | 'render' | 'source' | 'attachment';
  size: number;
  sha256: string;
  text: boolean;
  headings?: string[];
};
export type DesignDelivery = {
  archiveId: string;
  archiveRoot: string;
  files: DesignDeliveryFile[];
  source?: string;
  frameworkDraft?: string;
  prototypeVersion?: number;
  date?: string;
  notes?: string;
  warnings: string[];
};
export const designFeedbackCategories = ['reuse', 'implementation', 'gap', 'constraint', 'acceptance'] as const;
export type DesignFeedbackCategory = typeof designFeedbackCategories[number];
type DesignFeedbackAuthor = { id: string; label: string };
export type DesignFeedbackAttachment = {
  id: string; title: string; size: number; sha256: string; author: DesignFeedbackAuthor; at: string;
  version?: number; screenId?: string; slot?: DesignSlot;
};
export type DesignFeedback = {
  id: string;
  version: number;
  screenId?: string;
  category: DesignFeedbackCategory;
  title: string;
  body: string;
  evidence: string[];
  author: DesignFeedbackAuthor;
  createdAt: string;
  status: 'open' | 'responded' | 'closed';
  filePath?: string;
  attachments?: DesignFeedbackAttachment[];
  replies: Array<{ body: string; revision?: number; author: DesignFeedbackAuthor; at: string; supplement?: true }>;
  decisions: Array<{ decision: 'close' | 'reopen'; body: string; author: DesignFeedbackAuthor; at: string }>;
};

export type DesignModuleRef = { systemId: string; moduleId: string };
export type DesignScope = DesignModuleRef & { related?: DesignModuleRef[] };
export type DesignSystem = {
  id: string; name: string; framework?: string;
  modules: Array<{ id: string; name: string; framework?: string; note?: string }>;
};

export type DesignVersion = {
  version: number; title: string; sourceCommit: string; sha256: string; prototypeId: string; createdAt: string;
  sourcePath?: string; sourceVerification?: 'git' | 'declared' | 'private-upload'; prototypeSha256?: string;
  publisher: { id: string; label: string }; note?: string; screens: DesignScreen[]; acceptance: DesignRule[];
  rationale: string; spec: DesignMaterial; checks?: Record<string, unknown>; framework?: string; frameworkVersion?: number;
  frameworkCharter?: DesignFrameworkCharter;
  frameworkCheck?: DesignFrameworkCheck;
  group?: string; scope?: DesignScope; tags: string[]; decisionIds: string[]; resolves: Record<string, string>;
  renders?: Record<string, Partial<Record<DesignTheme, { id: string; sha256: string }>>>;
  acceptancePlan?: DesignAcceptancePlan;
  acceptanceMode?: 'objective';
  risks?: DesignCoverageRecord[];
  delivery?: DesignDelivery;
};

export function designAcceptanceTarget(version: DesignVersion, rule: DesignRule, slot: DesignSlot): DesignScreen | undefined {
  const [viewport, theme] = slot.split('-') as ['desktop' | 'phone', DesignTheme];
  const matches = version.screens.filter(screen => screen.impl && screen.themes.includes(theme)
    && (rule.screenId ? screen.id === rule.screenId : screen.viewport === viewport));
  return new Set(matches.map(screen => JSON.stringify([screen.impl, screen.readySelector ?? null]))).size === 1
    ? matches[0] : undefined;
}
export type DesignComment = {
  id: string; version: number; screenId: string; body: string; x: number; y: number; createdAt: string;
  author: { id: string; label: string }; closed: boolean;
  replies: Array<{ body: string; createdAt: string; author: { id: string; label: string } }>;
  reviews: Array<{ version: number; decision: 'resolved' | 'rejected'; body: string; by: string; at: string }>;
};
export type DesignCell = {
  itemId: string; slot: DesignSlot; status: DesignCellStatus; actual: string; imageId?: string; recordedBy?: string;
  debtId?: string; measured?: { width: number; height: number; theme: DesignTheme; path: string };
};
export type DesignRun = {
  id: string; version: number; pullRequest?: number; target?: 'installed'; commit: string; createdAt: string;
  cells: DesignCell[]; verdict: DesignVerdict; previewUrl: string;
  visual?: Record<`${string}/${DesignSlot}`, DesignVisualRow>;
  flows?: DesignFlow[];
  smoke?: DesignSmoke[];
  coverage?: Partial<Record<DesignDimension, DesignCoverageRecord>>;
  regress?: Record<string, DesignRegression>;
  enabledMethods?: DesignMethodId[];
  upgradeId?: string;
  signed?: { by: string; at: string; verdict: 'passed' | 'conditional' };
  issues: Record<string, { id: string; pending: boolean }>;
};
export type DesignImplementation = {
  screenId: string; path: string; readySelector: string; by: string; at: string;
};
export type DesignReviewer = { id: string; label: string };
export type DesignSharePreparation = {
  id: string; version: number; sourceCommit: string; packageSha256: string;
  audience: 'public' | 'password'; expiresInHours: number;
  state: 'awaiting_human_confirmation'; preparedAt: string; preparedBy: DesignReviewer;
};
export type DesignShareHandoffReceipt = { preparationId: string; destination: string; grant: string; expiresAt: string };
export type DesignReviewNotice = {
  id: string; projectId: string; designId: string; version: number; title: string;
  createdAt: string; updatedAt: string; occurrences: number;
};
export type DesignUpgrade = {
  id: string; fromVersion?: number; targetVersion: number; startedAt: string; startedBy: string;
  status: 'active' | 'completed' | 'cancelled'; completedAt?: string; signoffRunId?: string; reason?: string;
};
export type DesignVersionGap = { direction: 'behind' | 'ahead' | 'aligned'; count: number };

export function designVersionGap(baseline?: number, implemented?: number): DesignVersionGap | undefined {
  if (baseline === undefined || implemented === undefined) return undefined;
  const difference = baseline - implemented;
  return { direction: difference > 0 ? 'behind' : difference < 0 ? 'ahead' : 'aligned', count: Math.abs(difference) };
}

export type DesignEntry = {
  id: string; projectId: string; designKey?: string; versions: DesignVersion[]; frozen?: number; pullRequest?: number;
  scope?: DesignScope;
  comments: DesignComment[]; runs: DesignRun[]; feedback?: DesignFeedback[]; reviewRequested?: boolean;
  currentSignoffRunId?: string | null;
  reviewers?: DesignReviewer[];
  sharePreparations?: DesignSharePreparation[];
  freezes?: Array<{ version: number; by: string; at: string; reason?: string }>;
  unfreezes?: Array<{ version: number; by: string; at: string }>;
  implementations?: Record<number, DesignImplementation[]>;
  implementedVersion?: number;
  versionGap?: DesignVersionGap;
  upgrade?: DesignUpgrade;
  enabledMethods?: Record<number, DesignMethodId[]>;
  knownIssues?: DesignKnownIssue[];
};

export function currentDesignRun(entry: DesignEntry): DesignRun | undefined {
  if (entry.frozen === undefined) return undefined;
  return entry.runs.slice().reverse().find(run => run.version === entry.frozen
    && (run.target === 'installed' || !!entry.pullRequest && run.pullRequest === entry.pullRequest)
    && (entry.upgrade?.status !== 'active' || run.upgradeId === entry.upgrade.id));
}
export type FrameworkRevision = {
  version: number; title: string; sourceCommit: string; at: string; by: string;
  sourcePath?: string; sourceVerification?: 'git' | 'declared';
  from?: { designId: string; version: number }; material: DesignMaterial; note?: string;
  charter?: DesignFrameworkCharter;
  resolutions?: FrameworkResolutions;
};
export type DesignFramework = { id: string; projectId: string; versions: FrameworkRevision[] };

export function frameworkInUse(id: string, revision: FrameworkRevision | undefined, designs: Iterable<DesignEntry>) {
  if (!revision) return false;
  if (revision.charter?.status === 'adopted') return true;
  for (const design of designs) {
    if (design.versions.at(-1)?.framework === id
      || design.versions.find(version => version.version === design.frozen)?.framework === id) return true;
  }
  return false;
}
/** Project members explicitly release one accepted requirement to the design workspace. */
export type DesignRequirement = {
  designKey: string; planId: string; planVersion: number; proposalId: string;
  title: string; requirements: string; sharedAt: string;
  scope?: DesignScope; owner?: DesignReviewer; assignee?: DesignReviewer;
  replies?: Array<{ id: string; author: DesignFeedbackAuthor; body: string; at: string; planVersion: number }>;
};
export type DesignIntake = {
  protocolVersion: 1;
  projectId: string;
  permissions: { write: boolean; feedback?: boolean };
  systems?: DesignSystem[];
  keyFormat: 'module/draft';
  intents: readonly ['create', 'revise'];
  requirements: DesignRequirement[];
  designs: Array<{
    designId: string; designKey?: string; title: string; latestVersion: number;
    sourceCommit: string; sourcePaths: string[]; scope?: DesignScope; canRevise: boolean; openFeedbackCount?: number;
    baselineVersion?: number; implementedVersion?: number; versionGap?: DesignVersionGap; upgrade?: DesignUpgrade;
    versionHistory?: Array<{ version: number; sourceCommit: string }>;
  }>;
  frameworks: Array<{ id: string; title: string; latestVersion: number; adoptedVersion?: number }>;
};
export type DesignReadMark = { version: number; feedbackAt?: string };
export type DesignViewerState = {
  firstVisitAt?: string; lastVisitAt?: string;
  designs: Record<string, DesignReadMark>;
  briefs: Record<string, string>;
};

export function latestDesignFeedbackAt(entry: DesignEntry): string {
  let latest = '';
  for (const item of entry.feedback ?? []) {
    for (const at of [item.createdAt, item.replies.at(-1)?.at, item.decisions.at(-1)?.at, item.attachments?.at(-1)?.at]) {
      if (at && at > latest) latest = at;
    }
  }
  return latest;
}

export type DesignWorkspace = {
  projectId: string; designs: DesignEntry[]; frameworks: DesignFramework[];
  requirements?: DesignRequirement[];
  systems?: DesignSystem[];
  viewer?: DesignViewerState;
  permissions: { write: boolean; feedback?: boolean; feedbackSupplement?: boolean; visual?: boolean; review: boolean; sign?: boolean;
    installedAcceptance?: boolean; steward: boolean; actorId: string };
};
