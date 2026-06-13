import { describe, expect, it } from 'vitest';
import { computeInitiationReviewProgress } from './InitiationReviewLivePanel';
import { hasRecoverableSseOutcome } from './initiationReviewFinish';

describe('computeInitiationReviewProgress', () => {
  it('returns staged progress before streaming completes', () => {
    expect(computeInitiationReviewProgress('uploading', 0, 5)).toBe(12);
    expect(computeInitiationReviewProgress('submitting', 0, 5)).toBe(22);
    expect(computeInitiationReviewProgress('syncing', 5, 5)).toBe(95);
  });

  it('increases progress as dimensions arrive', () => {
    const half = computeInitiationReviewProgress('streaming', 2, 4);
    const full = computeInitiationReviewProgress('streaming', 4, 4);
    expect(half).toBeGreaterThan(28);
    expect(full).toBeGreaterThan(half);
    expect(full).toBeLessThanOrEqual(88);
  });
});

describe('hasRecoverableSseOutcome', () => {
  it('treats partial SSE payload as recoverable', () => {
    expect(hasRecoverableSseOutcome({ hasResult: true, dimensionCount: 0, streamDone: false })).toBe(true);
    expect(hasRecoverableSseOutcome({ hasResult: false, dimensionCount: 2, streamDone: false })).toBe(true);
    expect(hasRecoverableSseOutcome({ hasResult: false, dimensionCount: 0, streamDone: false })).toBe(false);
  });
});
