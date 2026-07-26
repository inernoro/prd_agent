import { describe, expect, it } from 'vitest';
import {
  decideVaultServerRecovery,
  deferredRunIdForRecoveredVaultCompletion,
  enqueueBackgroundTranscriptionRun,
  shouldRetryVaultServerCompletion,
} from '../recordingVault';

describe('recording vault completion retry gate', () => {
  it('retries only server-owned completing and completed sessions', () => {
    expect(shouldRetryVaultServerCompletion({
      success: true,
      data: { status: 'completing' },
    })).toBe(true);
    expect(shouldRetryVaultServerCompletion({
      success: true,
      data: { status: 'completed' },
    })).toBe(true);
    expect(shouldRetryVaultServerCompletion({
      success: true,
      data: { status: 'uploading' },
    })).toBe(false);
    expect(shouldRetryVaultServerCompletion({
      success: true,
      data: { status: 'cancelled' },
    })).toBe(false);
    expect(shouldRetryVaultServerCompletion({
      success: false,
      error: { code: 'SERVER_ERROR' },
    })).toBe(false);
    expect(shouldRetryVaultServerCompletion(null)).toBe(false);
  });
});

describe('recording vault deferred transcription recovery', () => {
  it('watches only a non-empty deferred run owned by an archive-pending completion', () => {
    expect(deferredRunIdForRecoveredVaultCompletion({
      success: true,
      data: { archivePending: true, deferredTranscriptionRunId: ' run-1 ' },
    })).toBe('run-1');
    expect(deferredRunIdForRecoveredVaultCompletion({
      success: true,
      data: { archivePending: false, deferredTranscriptionRunId: 'run-1' },
    })).toBeNull();
    expect(deferredRunIdForRecoveredVaultCompletion({
      success: true,
      data: { archivePending: true, deferredTranscriptionRunId: ' ' },
    })).toBeNull();
    expect(deferredRunIdForRecoveredVaultCompletion(null)).toBeNull();
  });

  it('keeps multiple recovered runs while trimming and deduplicating replays', () => {
    const first = enqueueBackgroundTranscriptionRun([], ' run-1 ');
    const duplicate = enqueueBackgroundTranscriptionRun(first, 'run-1');
    const second = enqueueBackgroundTranscriptionRun(duplicate, 'run-2');

    expect(first).toEqual(['run-1']);
    expect(duplicate).toEqual(['run-1']);
    expect(second).toEqual(['run-1', 'run-2']);
    expect(enqueueBackgroundTranscriptionRun(second, ' ')).toEqual(second);
  });
});

describe('recording vault server recovery decision', () => {
  it('keeps local audio protected for unknown network and transient server errors', () => {
    expect(decideVaultServerRecovery(null)).toBe('keep-protected');
    expect(decideVaultServerRecovery({
      success: false,
      error: { code: 'SERVER_ERROR' },
    })).toBe('keep-protected');
  });

  it('keeps local audio protected while the server is completing', () => {
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completing' },
    })).toBe('keep-protected');
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completing' },
    }, {
      success: false,
      error: { code: 'SERVER_ERROR' },
    })).toBe('keep-protected');
  });

  it('accepts a successful idempotent completion after observing a completing lease', () => {
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completing' },
    }, { success: true })).toBe('completed');
  });

  it('deletes the vault only after the completed entry is recovered', () => {
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completed' },
    }, { success: true })).toBe('completed');
  });

  it('keeps protection when a completed session has only a transient response failure', () => {
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completed' },
    }, null)).toBe('keep-protected');
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completed' },
    }, {
      success: false,
      error: { code: 'SERVER_ERROR' },
    })).toBe('keep-protected');
  });

  it('allows local recovery only after explicit release or a missing completed entry', () => {
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'uploading' },
    })).toBe('recover-local');
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'uploading' },
    }, { success: true })).toBe('recover-local');
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'cancelled' },
    })).toBe('recover-local');
    expect(decideVaultServerRecovery({
      success: false,
      error: { code: 'SESSION_EXPIRED' },
    })).toBe('recover-local');
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completed' },
    }, {
      success: false,
      error: { code: 'NOT_FOUND' },
    })).toBe('recover-local');
  });
});
