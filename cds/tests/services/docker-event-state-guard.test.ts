import { describe, expect, it } from 'vitest';
import { canApplyDockerLifecycleState, parseDockerEvent } from '../../src/services/docker-event-state-guard.js';

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

describe('exact Docker event timestamp projection', () => {
  it('preserves large numeric nanoseconds without changing the public parsed event', () => {
    const parsed = parseDockerEvent('{"time":1770000000,"timeNano":1770000000000000001}');
    expect(parsed.timeNs).toBe(1770000000000000001n);
    expect(typeof parsed.event.timeNano).toBe('number');
  });
  it('ignores nested attribute timestamps and accepts the declared root decimal string', () => {
    expect(parseDockerEvent('{"timeNano":"1770000000000000001","Actor":{"Attributes":{"timeNano":9}}}').timeNs).toBe(1770000000000000001n);
  });
  it.each(['-1', '1.5', '18446744073709551616', '"not-time"'])('does not order malformed or overflowing timestamps %s', stamp => {
    expect(parseDockerEvent(`{"timeNano":${stamp}}`).timeNs).toBeUndefined();
  });
  it('refuses contradictory seconds and nanoseconds instead of preferring an attacker-controlled field', () => {
    expect(parseDockerEvent('{"time":100,"timeNano":200000000000}').timeNs).toBeUndefined();
  });
  it('keeps seconds-only legacy precision explicit and rejects malformed seconds', () => {
    expect(parseDockerEvent('{"time":200}').timeNs).toBe(200000000000n);
    expect(parseDockerEvent('{"time":"200"}').timeNs).toBeUndefined();
    expect(parseDockerEvent('{"time":18446744074}').timeNs).toBeUndefined();
    expect(parseDockerEvent('{"time":9007199254740991}').timeNs).toBeUndefined();
  });
});
