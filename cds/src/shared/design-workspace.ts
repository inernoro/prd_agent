import type { DesignVerdict, DesignCellStatus } from '../services/design-acceptance.js';

export const designSlots = ['desktop-light', 'desktop-dark', 'phone-light', 'phone-dark'] as const;
export type DesignSlot = typeof designSlots[number];
export type DesignTheme = 'light' | 'dark';
export const designViewports = { desktop: { width: 1280, height: 800 }, phone: { width: 375, height: 812 } } as const;
export type DesignScreen = {
  id: string; name: string; route: string; viewport: 'desktop' | 'phone'; themes: DesignTheme[]; impl: string | null;
};
export type DesignRule = {
  id: string; rule: string; how: 'measure' | 'screenshot' | 'human'; priority: 'high' | 'normal';
  slots: readonly DesignSlot[]; screenId?: string; expected?: string;
  probe?: { type: 'horizontal-overflow'; tolerance?: number };
};
export type DesignMaterial = { tokens?: Record<string, unknown>; rules?: string; components?: string; skeleton?: string };

export type DesignVersion = {
  version: number; title: string; sourceCommit: string; sha256: string; prototypeId: string; createdAt: string;
  sourcePath?: string; sourceVerification?: 'git' | 'declared';
  publisher: { id: string; label: string }; note?: string; screens: DesignScreen[]; acceptance: DesignRule[];
  rationale: string; spec: DesignMaterial; checks?: Record<string, unknown>; framework?: string; frameworkVersion?: number;
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
export type DesignEntry = {
  id: string; projectId: string; versions: DesignVersion[]; frozen?: number; pullRequest?: number;
  comments: DesignComment[]; runs: DesignRun[]; reviewRequested?: boolean;
  freezes?: Array<{ version: number; by: string; at: string }>;
};
export type FrameworkRevision = {
  version: number; title: string; sourceCommit: string; at: string; by: string;
  sourcePath?: string; sourceVerification?: 'git' | 'declared';
  from?: { designId: string; version: number }; material: DesignMaterial; note?: string;
};
export type DesignFramework = { id: string; projectId: string; versions: FrameworkRevision[] };
export type DesignWorkspace = {
  projectId: string; designs: DesignEntry[]; frameworks: DesignFramework[];
  permissions: { write: boolean; review: boolean; steward: boolean; actorId: string };
};
