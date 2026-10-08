import { describe, expect, it } from 'vitest';
import { AutoWakeAdmission, hasWakeHeadroom } from '../../src/services/auto-wake-admission.js';

const healthy = { availableMB: 80_000, totalMB: 96_000, loadRatio: 0.1 };
describe('automatic wake admission', () => {
  it('admits one identified branch, releases on completion and ignores stale releases', () => {
    const gate = new AutoWakeAdmission(() => healthy);
    const releaseA = gate.tryAcquire('a')!;
    expect(gate.snapshot()?.branchId).toBe('a');
    expect(gate.tryAcquire('b')).toBeNull();
    releaseA();
    const releaseB = gate.tryAcquire('b')!;
    releaseA();
    expect(gate.snapshot()?.branchId).toBe('b');
    releaseB();
    expect(gate.snapshot()).toBeNull();
  });
  it('defers low memory and overload without creating a queue or occupying a slot', () => {
    let sample = { ...healthy, availableMB: 1000 };
    const gate = new AutoWakeAdmission(() => sample);
    expect(gate.tryAcquire('a')).toBeNull();
    expect(gate.snapshot()).toBeNull();
    sample = { ...healthy, loadRatio: 1.2 };
    expect(gate.tryAcquire('a')).toBeNull();
    sample = healthy;
    expect(gate.tryAcquire('a')).not.toBeNull();
  });
  it('fails closed if telemetry is unavailable and detects pressure during startup', () => {
    expect(new AutoWakeAdmission(() => { throw new Error('unavailable'); }).tryAcquire('a')).toBeNull();
    expect(hasWakeHeadroom({ ...healthy, availableMB: NaN })).toBe(false);
    let sample = healthy;
    const gate = new AutoWakeAdmission(() => sample);
    expect(gate.tryAcquire('a')).not.toBeNull();
    sample = { ...healthy, availableMB: 1000 };
    expect(gate.hasHeadroom()).toBe(false);
  });
});
