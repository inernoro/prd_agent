import { describe, expect, it } from 'vitest';
import type { ProductInitiation } from './types';
import {
  formatInitiationReviewScore,
  isMeetingResultPending,
} from './initiationWorkflowUtils';

const base = {
  id: '1',
  productId: 'p1',
  planName: '方案',
  versionType: 'minor',
  status: 'approved',
  createdBy: 'u1',
} as ProductInitiation;

describe('formatInitiationReviewScore', () => {
  it('优先展示 reviewScore', () => {
    expect(formatInitiationReviewScore({ ...base, reviewScore: 88 })).toBe('88/100');
  });

  it('无 reviewScore 时回退到最近一次尝试', () => {
    expect(formatInitiationReviewScore({
      ...base,
      reviewAttempts: [
        { id: 'a1', attemptNo: 1, reviewScore: 60 },
        { id: 'a2', attemptNo: 2, reviewScore: 72 },
      ],
    })).toBe('72/100');
  });

  it('无分数时显示 —', () => {
    expect(formatInitiationReviewScore(base)).toBe('-');
  });
});

describe('isMeetingResultPending', () => {
  it('未选择开会则不需要回填', () => {
    expect(isMeetingResultPending({ ...base, reviewMeetingRequired: false })).toBe(false);
  });

  it('需开会且任一审稿未填通过结论则为待回填', () => {
    expect(isMeetingResultPending({
      ...base,
      reviewMeetingRequired: true,
      meetingDraftCount: 2,
      meetingDraftRounds: [{ round: 1, passed: true }, { round: 2, passed: null }],
    })).toBe(true);
  });

  it('各稿均已填结论则不再待回填', () => {
    expect(isMeetingResultPending({
      ...base,
      reviewMeetingRequired: true,
      meetingDraftCount: 2,
      meetingDraftRounds: [{ round: 1, passed: true }, { round: 2, passed: true }],
    })).toBe(false);
  });
});
