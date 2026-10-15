import type { Locator } from '@playwright/test';
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
