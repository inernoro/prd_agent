import type { APIRequestContext } from '@playwright/test';

export type LiteraryMarkerProof = { fullText: string; eventTypes: string[]; markerCount: number };
export function assertRealLiteraryMarkerStream(stream: string, article: string): LiteraryMarkerProof;
export function assertLiteraryWorkspacePersisted(detail: unknown, expected: {
  workspaceId: string; title: string; article: string; fullText: string;
}): unknown;
export function deleteAndVerifyLiteraryWorkspace(request: APIRequestContext, options: {
  workspaceId: string; headers: Record<string, string>; timeout: number;
}): Promise<{ workspaceId: string; deleted: true; detailStatus: 404 }>;
