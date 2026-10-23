import type { Locator, Page } from '@playwright/test';

export const invalidShortVideoText: '这不是链接';
export type InvalidShortVideoScope = {
  snapshot(): { inspectionRunId: string; blockedRequests: Array<{ method: string; path: string }>; runCreateRequests: number };
  assertNoRunRequests(): void;
  dispose(): Promise<void>;
};
export function installInvalidShortVideoRunGuard(page: Page, inspectionRunId: string): Promise<InvalidShortVideoScope>;
export function observeInvalidShortVideoInput(options: {
  input: Locator;
  submit: Locator;
  errorTitle: Locator;
  errorDetail: Locator;
  scope: InvalidShortVideoScope;
}): Promise<{ inputValue: string; title: string; detail: string; inspectionRunId: string; blockedRequests: Array<{ method: string; path: string }>; runCreateRequests: number; proofBoundary: string }>;
