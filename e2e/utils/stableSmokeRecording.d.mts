import type { Locator } from '@playwright/test';
export function assertRecordingIdempotencyRuns(firstRunId: unknown, secondRunId: unknown): void;
export interface RecordingSettlementSession { sessionId: string; entryId?: string; status: string; archiveStatus?: string }
export interface RecordingSettlementRun { id: string; storeId: string; sourceEntryId: string; kind: string; status: string; automaticRetryNextAt?: string | null }
export function waitForRecordingIdempotencySettlement(options: {
  sessionId: string; storeId: string; entryId: string; runIds: string[];
  readSession: (remainingMs: number) => Promise<RecordingSettlementSession>;
  readRun: (runId: string, remainingMs: number) => Promise<RecordingSettlementRun>;
  timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>;
}): Promise<{ settled: boolean; observations: unknown[]; errors: string[] }>;
export function freezeRecordingCasePlanEnvironment(environment: string, allowedCaseIds: readonly string[]): { STABLE_SMOKE_ALLOWED_CASE_IDS_JSON: string };
export function readRecordingJourneyPlan(env?: Record<string, string | undefined>): Readonly<{ title: string; restyleSelected: boolean }>;
export interface RecordingTranscriptRow { index: number; body: string; timestamp: string }
export interface SpeechReference {
  schemaVersion: number; fixtureId: string; sourceText: string; expectedTranscript: string;
  language: string; mimeType: string; normalization: string; sha256: string; byteLength: number; durationSeconds: number;
  provenance: { engine: string; voice: string; referenceBasis: string; humanListeningVerified: false; [key: string]: unknown };
}
export function readRecordingTranscriptRows(surface: Pick<Locator, 'locator'>): Promise<RecordingTranscriptRow[]>;
export function validateRecordingTranscriptRows(rows: Array<{ index: number; bodies: string[]; timestamps: string[] }>): RecordingTranscriptRow[];
export function assertRecordingTranscriptEquals(rows: RecordingTranscriptRow[], expectedLines: string[], options?: { timestamps?: 'optional' | 'required' }): { lineCount: number; timestampCount: number };
export function normalizeSpeechReference(text: string): string;
export function assertSpeechMatchesReference(actual: string, reference: SpeechReference): { referenceId: string; comparison: string; humanListeningVerified: false };
export function validateSpeechReference(reference: SpeechReference, audio: Buffer): { durationSeconds: number; rms: number; humanListeningVerified: false };
export function loadStableSmokeSpeechReference(): { reference: SpeechReference; audio: Buffer; signal: { durationSeconds: number; rms: number; humanListeningVerified: false }; fileName: string; mimeType: string };
