import { describe, expect, it } from 'vitest';
import {
  canDiscardRecording,
  nextRecordingFinalizationLock,
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
});
