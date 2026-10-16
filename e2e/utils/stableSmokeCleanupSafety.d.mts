export const sharedCleanupSafetyPath: string;
export function readCleanupBlocker(options: { outputDirectory: string; environment: string; sharedPath?: string }): { reason: string; resourceIds: string[] } | undefined;
export function isCleanupReadOnlyJourney(title: string): boolean;
export function cleanupFailureFromAttachments(attachments: Array<{ name: string; body?: Buffer | string }>, inspectionRunId: string): { resourceIds: string[]; reason: string } | undefined;
export function writeCleanupBlocker(outputDirectory: string, circuit: { environment: string; inspectionRunId: string; resourceIds: string[]; reason: string; sharedPath?: string }): void;
