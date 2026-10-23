import type { APIRequestContext, Locator } from '@playwright/test';

export type LiteraryMarkerProof = { fullText: string; eventTypes: string[]; markerCount: number };
export function assertRealLiteraryMarkerStream(stream: string, article: string): LiteraryMarkerProof;
export function assertLiteraryWorkspacePersisted(detail: unknown, expected: {
  workspaceId: string; title: string; article: string; fullText: string;
}): unknown;
export function readLiterarySingleImagePrompt(detail: unknown, expected: {
  workspaceId: string; title: string; article: string; fullText: string; markerIndex: number;
}): { markerIndex: number; prompt: string; source: 'planItem.prompt' | 'draftText' | 'text' };
export function deleteAndVerifyLiteraryWorkspace(request: APIRequestContext, options: {
  workspaceId: string; headers: Record<string, string>; timeout: number;
}): Promise<{ workspaceId: string; deleted: true; detailStatus: 404 }>;
export function createLiterarySingleImagePolicy(inspectionRunId: string): {
  configure(value: Record<string, unknown>): void;
  inspect(method: string, path: string, body?: unknown): boolean;
  snapshot(): { markerRequests: number; imageRequests: number; violations: string[] };
  assertNoViolations(): void;
};
export function assertLiteraryImageInsertion(detail: unknown, expected: {
  workspaceId: string; title: string; article: string; fullText: string; markerIndex: number; runId: string;
}, placement: { count: number; src: string; width: number; height: number; allText: string; beforeText: string; afterText: string }): {
  assetId: string; url: string; markerIndex: number; runId: string;
};
export function readLiteraryImagePlacement(content: Locator, markerIndex: number): Promise<{
  count: number; src: string; width: number; height: number; allText: string; beforeText: string; afterText: string;
}>;
