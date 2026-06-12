import type { ApiResponse } from '@/types/api';

export interface TapdBugDraft {
  title: string;
  module: string;
  severity: 'fatal' | 'serious' | 'normal' | 'minor';
  priority: 'urgent' | 'high' | 'medium' | 'low';
  bugType: '逻辑错误' | '界面展示' | '兼容性' | '性能' | '需求不符';
  currentOwner: string;
  versionReport: string;
  preconditions: string[];
  steps: string[];
  actualResult: string[];
  expectedResult: string[];
  missingFields: string[];
}

export interface TapdBugPreviewInput {
  naturalText: string;
  overrides?: TapdBugDraft;
}

export interface TapdBugSubmitInput {
  cookie: string;
  workspaceId: string;
  addBugToken?: string;
  dscToken?: string;
  confirmed: true;
  draft: TapdBugDraft;
}

export interface TapdBugSubmitResult {
  success: boolean;
  bugId?: string | null;
  bugUrl?: string | null;
  title: string;
  statusCode: number;
  error?: string | null;
}

export interface TapdBugPreviewHandlers {
  onStage?: (stage: string, message: string) => void;
  onThinking?: (text: string) => void;
  onTyping?: (text: string) => void;
  onModel?: (model: string, platform?: string) => void;
  onDraft?: (draft: TapdBugDraft) => void;
}

export type StreamTapdBugPreviewContract = (
  input: TapdBugPreviewInput,
  handlers?: TapdBugPreviewHandlers,
  signal?: AbortSignal
) => Promise<TapdBugDraft>;

export type SubmitTapdBugContract = (
  input: TapdBugSubmitInput
) => Promise<ApiResponse<{ result: TapdBugSubmitResult }>>;
