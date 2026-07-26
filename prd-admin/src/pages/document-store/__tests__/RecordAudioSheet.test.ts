import { describe, expect, it } from 'vitest';
import {
  canDiscardRecording,
  nextRecordingFinalizationLock,
  shouldForwardLivePcm,
  shouldStopRecordingCompletionRetry,
} from '../RecordAudioSheet';

describe('RecordAudioSheet finalization guard', () => {
  it('allows discard before finalization owns the terminal state', () => {
    expect(canDiscardRecording(false)).toBe(true);
  });

  it('rejects discard after finalization owns the terminal state', () => {
    expect(canDiscardRecording(true)).toBe(false);
  });

  it('locks synchronously when completion is accepted and never unlocks on discard', () => {
    const lockedOnComplete = nextRecordingFinalizationLock(false, 'complete');

    expect(lockedOnComplete).toBe(true);
    expect(canDiscardRecording(lockedOnComplete)).toBe(false);
    expect(nextRecordingFinalizationLock(lockedOnComplete, 'discard')).toBe(true);
  });

  it('forwards live PCM while actively recording', () => {
    expect(shouldForwardLivePcm(true, 'recording', false)).toBe(true);
  });

  it('holds PCM while paused but flushes the tail after completion owns the terminal state', () => {
    expect(shouldForwardLivePcm(true, 'paused', false)).toBe(false);
    expect(shouldForwardLivePcm(true, 'paused', true)).toBe(true);
  });

  it('never forwards a tail after live capture has been disabled', () => {
    expect(shouldForwardLivePcm(false, 'paused', true)).toBe(false);
  });

  it('stops completion retries when the server reports a removed session', () => {
    expect(shouldStopRecordingCompletionRetry({
      success: false,
      error: { code: 'NOT_FOUND' },
    })).toBe(true);
    expect(shouldStopRecordingCompletionRetry({
      success: false,
      error: { code: 'SESSION_NOT_FOUND' },
    })).toBe(true);
    expect(shouldStopRecordingCompletionRetry({
      success: false,
      error: { code: 'SESSION_EXPIRED' },
    })).toBe(true);
    expect(shouldStopRecordingCompletionRetry({
      success: true,
      data: { status: 'cancelled' },
    })).toBe(true);
  });

  it('keeps retrying on an unknown network result or a recoverable session', () => {
    expect(shouldStopRecordingCompletionRetry(null)).toBe(false);
    expect(shouldStopRecordingCompletionRetry({
      success: false,
      error: { code: 'SERVER_ERROR' },
    })).toBe(false);
    expect(shouldStopRecordingCompletionRetry({
      success: true,
      data: { status: 'completing' },
    })).toBe(false);
  });
});
