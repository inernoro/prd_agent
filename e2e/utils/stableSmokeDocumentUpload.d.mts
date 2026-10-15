import type { Locator, Page } from '@playwright/test';
type Phase = 'uploading' | 'parsing';
export function findDocumentUploadCard(page: Page, options: { fileName: string; phase: Phase; timeout?: number }): Promise<Locator>;
export function readDocumentUploadView(card: Locator, options: { fileName: string; phase: Phase }): Promise<{ phase: Phase; percent?: number; parsingSeconds?: number }>;
type PhaseFailure = { message: string; stack: string };
export function observeDocumentUploadPhases(options: { observe: () => Promise<void>; releaseResponse: () => Promise<void>; onFailure?: (failure: PhaseFailure) => Promise<void> }): Promise<{ status: 'pass' | 'fail'; failure: PhaseFailure | null; evidenceFailure: string | null; controlledWait: string }>;
export function releaseDocumentUploadResponse(page: Page): Promise<void>;
