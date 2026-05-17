import { describe, expect, it } from 'vitest';

import { resolveProviderEvidenceState } from '../cdsAgentReadiness';

describe('CDS Agent provider readiness evidence', () => {
  it('does not let old session events pass S1/S2/S3 while R1 is blocked', () => {
    const state = resolveProviderEvidenceState({
      defaultProfileReady: false,
      officialLoopReady: true,
      hasReadonlyRunEvidence: true,
      hasApprovalEvidence: true,
      hasCancelEvidence: true,
    });

    expect(state.eligible).toBe(false);
    expect(state.s1EvidenceReady).toBe(false);
    expect(state.s2EvidenceReady).toBe(false);
    expect(state.s3EvidenceReady).toBe(false);
    expect(state.blockedDetail).toContain('旧会话事件不能证明当前 provider gate');
    expect(state.s1DetailOverride).toContain('旧会话事件不能证明当前 provider gate');
    expect(state.s2DetailOverride).toContain('旧会话事件不能证明当前 provider gate');
    expect(state.s3DetailOverride).toContain('旧会话事件不能证明当前 provider gate');
  });

  it('requires the official SDK loop before using page events as provider evidence', () => {
    const state = resolveProviderEvidenceState({
      defaultProfileReady: true,
      officialLoopReady: false,
      hasReadonlyRunEvidence: true,
      hasApprovalEvidence: true,
      hasCancelEvidence: true,
    });

    expect(state.eligible).toBe(false);
    expect(state.s1EvidenceReady).toBe(false);
    expect(state.s2EvidenceReady).toBe(false);
    expect(state.s3EvidenceReady).toBe(false);
    expect(state.s1DetailOverride).toContain('旧会话事件不能证明当前 provider gate');
    expect(state.s2DetailOverride).toContain('旧会话事件不能证明当前 provider gate');
    expect(state.s3DetailOverride).toContain('旧会话事件不能证明当前 provider gate');
  });

  it('allows S1/S2/S3 page evidence only after R1 and official loop are ready', () => {
    const state = resolveProviderEvidenceState({
      defaultProfileReady: true,
      officialLoopReady: true,
      hasReadonlyRunEvidence: true,
      hasApprovalEvidence: true,
      hasCancelEvidence: true,
    });

    expect(state.eligible).toBe(true);
    expect(state.s1EvidenceReady).toBe(true);
    expect(state.s2EvidenceReady).toBe(true);
    expect(state.s3EvidenceReady).toBe(true);
    expect(state.s1DetailOverride).toBe('');
    expect(state.s2DetailOverride).toBe('');
    expect(state.s3DetailOverride).toBe('');
  });
});
