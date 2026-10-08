import type { Locator, Page, TestInfo } from '@playwright/test';

export type StableSmokeVisualEvidenceInput = {
  slotId: string;
  target?: Locator;
  themeTarget?: Locator;
  caption?: string;
  expectText?: string | RegExp;
  overviewJustification?: string;
  status?: '通过' | '不通过' | '部分通过' | '未执行' | '需干预';
  failureEvidence?: boolean;
  failureReason?: string;
  allowBlockingOverlay?: boolean;
  skipReady?: boolean;
  timeout?: number;
};

export type StableSmokeVisualEvidenceResult =
  | { captured: false; reason: 'visual-evidence-disabled' }
  | { captured: true; record: Record<string, unknown>; manifestPath: string };

export function captureStableSmokeVisualEvidence(
  page: Page,
  testInfo: TestInfo | undefined,
  input: StableSmokeVisualEvidenceInput,
): Promise<StableSmokeVisualEvidenceResult>;

export function createStableSmokeVisualEvidence(options?: {
  environment?: Record<string, string | undefined>;
  harnessLoader?: () => Promise<Record<string, (...args: unknown[]) => unknown>>;
}): typeof captureStableSmokeVisualEvidence;
