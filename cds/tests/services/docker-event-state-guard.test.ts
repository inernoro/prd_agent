import { describe, expect, it } from 'vitest';
import { canApplyDockerLifecycleState } from '../../src/services/docker-event-state-guard.js';

describe('Docker event successor state fence', () => {
  const oldId = 'a'.repeat(64), newId = 'b'.repeat(64);
  it('rejects an older identity even when the mutable canonical name is reused', () => {
    expect(canApplyDockerLifecycleState(newId, { containerId: oldId, stateSyncEligible: true })).toBe(false);
  });
  it('rejects unknown event identity and corrupt stored IDs instead of treating them as a match', () => {
    expect(canApplyDockerLifecycleState(newId, { stateSyncEligible: true })).toBe(false);
    expect(canApplyDockerLifecycleState('short-id', { containerId: 'short-id' })).toBe(false);
    expect(canApplyDockerLifecycleState('', {})).toBe(false);
  });
  it('rejects an observation preceding same-ID restart, including legacy serving records', () => {
    expect(canApplyDockerLifecycleState(oldId, { containerId: oldId, stateSyncEligible: false })).toBe(false);
    expect(canApplyDockerLifecycleState(undefined, { containerId: oldId, stateSyncEligible: false })).toBe(false);
  });
  it('accepts a current immutable event and keeps unproven legacy read compatibility explicit', () => {
    expect(canApplyDockerLifecycleState(newId, { containerId: newId, stateSyncEligible: true })).toBe(true);
    expect(canApplyDockerLifecycleState(undefined, { containerId: newId, stateSyncEligible: true })).toBe(true);
  });
});
