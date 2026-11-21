import type { DesignVerdict, DesignCellStatus } from '../services/design-acceptance.js';

export const designSlots = ['desktop-light', 'desktop-dark', 'phone-light', 'phone-dark'] as const;
export type DesignSlot = typeof designSlots[number];
export type DesignTheme = 'light' | 'dark';
export const designViewports = { desktop: { width: 1280, height: 800 }, phone: { width: 375, height: 812 } } as const;
export type DesignScreen = {
  id: string; name: string; route: string; viewport: 'desktop' | 'phone'; themes: DesignTheme[]; impl: string | null;
  readySelector?: string;
};
export type DesignRule = {
  id: string; rule: string; how: 'measure' | 'screenshot' | 'human'; priority: 'high' | 'normal';
  slots: readonly DesignSlot[]; screenId?: string; expected?: string;
  probe?: { type: 'horizontal-overflow'; tolerance?: number };
};
export type DesignMaterial = { tokens?: Record<string, unknown>; rules?: string; components?: string; skeleton?: string };
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

export type DesignVersion = {
  version: number; title: string; sourceCommit: string; sha256: string; prototypeId: string; createdAt: string;
  sourcePath?: string; sourceVerification?: 'git' | 'declared'; prototypeSha256?: string;
  publisher: { id: string; label: string }; note?: string; screens: DesignScreen[]; acceptance: DesignRule[];
  rationale: string; spec: DesignMaterial; checks?: Record<string, unknown>; framework?: string; frameworkVersion?: number;
  frameworkCheck?: DesignFrameworkCheck;
  group?: string; tags: string[]; decisionIds: string[]; resolves: Record<string, string>;
  renders?: Record<string, Partial<Record<DesignTheme, { id: string; sha256: string }>>>;
};
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
  id: string; version: number; pullRequest: number; commit: string; createdAt: string;
  cells: DesignCell[]; verdict: DesignVerdict; previewUrl: string;
  signed?: { by: string; at: string; verdict: 'passed' | 'conditional' };
  issues: Record<string, { id: string; pending: boolean }>;
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
export type DesignEntry = {
  id: string; projectId: string; versions: DesignVersion[]; frozen?: number; pullRequest?: number;
  comments: DesignComment[]; runs: DesignRun[]; reviewRequested?: boolean;
  currentSignoffRunId?: string | null;
  reviewers?: DesignReviewer[];
  sharePreparations?: DesignSharePreparation[];
  freezes?: Array<{ version: number; by: string; at: string }>;
};

export function currentDesignRun(entry: DesignEntry): DesignRun | undefined {
  if (!entry.pullRequest || entry.frozen !== entry.versions.at(-1)?.version) return undefined;
  return entry.runs.slice().reverse().find(run => run.version === entry.frozen && run.pullRequest === entry.pullRequest);
}
export type FrameworkRevision = {
  version: number; title: string; sourceCommit: string; at: string; by: string;
  sourcePath?: string; sourceVerification?: 'git' | 'declared';
  from?: { designId: string; version: number }; material: DesignMaterial; note?: string;
};
export type DesignFramework = { id: string; projectId: string; versions: FrameworkRevision[] };
export type DesignWorkspace = {
  projectId: string; designs: DesignEntry[]; frameworks: DesignFramework[];
  permissions: { write: boolean; review: boolean; sign?: boolean; steward: boolean; actorId: string };
};
