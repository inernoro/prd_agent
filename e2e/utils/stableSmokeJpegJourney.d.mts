import type { Page } from '@playwright/test';
type DefaultPool = { isDefault?: boolean; code: string; name: string };
type JpegReference = { sha256: string; bytes: number; mime: string; extension: string };
export const jpegReferencePrompt: string;
export function assertDefaultJpegPrimary(input: { pool?: DefaultPool; logicalModelPublicId?: string; primaryProtocol?: string }): void;
export function assertJpegUploadRequest(input: { jpegBytes: Uint8Array; request: { data?: string }; asset: { sha256?: string; url?: string } }): JpegReference;
export function assertDefaultJpegRequest(input: { pool: DefaultPool; selectedLabel: string; request: Record<string, unknown>; referenceSha256: string }): void;
type JpegProof = { runId: string; targetKey: string; selectedLabel: string; reference: JpegReference; request: Record<string, unknown> };
export function submitDefaultJpegThroughUi(page: Page, options: { workspaceId: string; pool: DefaultPool; jpegBytes: Buffer; onCreated: (runId: string) => void; onUploaded?: (reference: JpegReference) => Promise<void>; onSubmitted?: (proof: JpegProof) => Promise<void>; onMissingReferenceDeclaration?: (proof: JpegProof) => Promise<void> }): Promise<JpegProof>;
