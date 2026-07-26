import { describe, expect, it } from 'vitest';
import { decideVaultServerRecovery, shouldRetryVaultServerCompletion } from '../recordingVault';

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
