import { describe, expect, it } from 'vitest';
import {
  canDiscardRecording,
  enqueueRecordingDestinationChange,
  nextRecordingCompletionOwnership,
  nextRecordingFinalizationLock,
  recordingCompletionOwnershipAfterRequestIssued,
  recordingCompletionOwnershipTransition,
  shouldFallbackCompletedRecording,
  shouldContinueRecordingCompletionRetry,
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

  it('protects the server session before every completion request has a confirmed response', () => {
    expect(recordingCompletionOwnershipAfterRequestIssued()).toBe(true);
    expect(nextRecordingCompletionOwnership(
      recordingCompletionOwnershipAfterRequestIssued(),
      null,
    )).toBe(true);
    expect(nextRecordingCompletionOwnership(
      recordingCompletionOwnershipAfterRequestIssued(),
      { success: false, error: { code: 'SERVER_ERROR' } },
    )).toBe(true);
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

  it('bounds both uncertain and server-owned completion retries', () => {
    expect(shouldContinueRecordingCompletionRetry(false, 31, 23, 44_999)).toBe(true);
    expect(shouldContinueRecordingCompletionRetry(false, 32, 0, 0)).toBe(false);
    expect(shouldContinueRecordingCompletionRetry(false, 0, 24, 0)).toBe(false);
    expect(shouldContinueRecordingCompletionRetry(false, 0, 0, 45_000)).toBe(false);
    expect(shouldContinueRecordingCompletionRetry(true, 0, 0, 0)).toBe(false);
  });

  it('persists and clears the recovery binding exactly on ownership transitions', () => {
    expect(recordingCompletionOwnershipTransition(false, true)).toBe('acquired');
    expect(recordingCompletionOwnershipTransition(true, true)).toBe('unchanged');
    expect(recordingCompletionOwnershipTransition(true, false)).toBe('released');
    expect(recordingCompletionOwnershipTransition(false, false)).toBe('unchanged');
  });

  it('serializes a destination switch and historical replay before newly arriving chunks', async () => {
    const order: string[] = [];
    let releaseOldUpload!: () => void;
    const oldUpload = new Promise<void>((resolve) => {
      releaseOldUpload = () => {
        order.push('old-upload-finished');
        resolve();
      };
    });
    const replay = [new Blob(['first']), new Blob(['second'])];
    const switched = enqueueRecordingDestinationChange(
      oldUpload,
      replay,
      async () => {
        order.push('destination-switched');
      },
      async (chunk) => {
        order.push(`replay-${await chunk.text()}`);
      },
    );
    const newChunk = switched.then(() => {
      order.push('new-live-chunk');
    });

    expect(order).toEqual([]);
    releaseOldUpload();
    await newChunk;

    expect(order).toEqual([
      'old-upload-finished',
      'destination-switched',
      'replay-first',
      'replay-second',
      'new-live-chunk',
    ]);
  });
});
