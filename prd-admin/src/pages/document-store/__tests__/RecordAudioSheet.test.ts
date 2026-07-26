import { describe, expect, it } from 'vitest';
import {
  canDiscardRecording,
  nextRecordingCompletionOwnership,
  nextRecordingFinalizationLock,
  shouldFallbackCompletedRecording,
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

  it('keeps server completion ownership sticky across transient status failures', () => {
    const completing = nextRecordingCompletionOwnership(false, {
      success: true,
      data: { status: 'completing' },
    });

    expect(completing).toBe(true);
    expect(nextRecordingCompletionOwnership(completing, null)).toBe(true);
    expect(nextRecordingCompletionOwnership(completing, {
      success: false,
      error: { code: 'SERVER_ERROR' },
    })).toBe(true);
    expect(nextRecordingCompletionOwnership(completing, {
      success: true,
      data: { status: 'completed' },
    })).toBe(true);
  });

  it('releases completion ownership only when the server explicitly returns to uploading', () => {
    expect(nextRecordingCompletionOwnership(true, {
      success: true,
      data: { status: 'uploading' },
    })).toBe(false);
  });

  it('falls back when a completed session has irrecoverably lost its entry', () => {
    const completedStatus = {
      success: true as const,
      data: { status: 'completed' },
    };

    expect(shouldFallbackCompletedRecording(completedStatus, {
      success: false,
      error: { code: 'INVALID_FORMAT' },
    })).toBe(true);
    expect(shouldFallbackCompletedRecording(completedStatus, {
      success: false,
      error: { code: 'NOT_FOUND' },
    })).toBe(true);
  });

  it('keeps server ownership for completed sessions across transient failures', () => {
    const completedStatus = {
      success: true as const,
      data: { status: 'completed' },
    };

    expect(shouldFallbackCompletedRecording(completedStatus, null)).toBe(false);
    expect(shouldFallbackCompletedRecording(completedStatus, {
      success: false,
      error: { code: 'SERVER_ERROR' },
    })).toBe(false);
    expect(shouldFallbackCompletedRecording({
      success: true,
      data: { status: 'completing' },
    }, {
      success: false,
      error: { code: 'INVALID_FORMAT' },
    })).toBe(false);
  });
});
