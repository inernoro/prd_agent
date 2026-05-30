import { describe, expect, it } from 'vitest';
import { InfraFlapWatchdog, type FlapSample } from '../../src/services/infra-flap-watchdog.js';

describe('InfraFlapWatchdog.evaluateSamples', () => {
  function makeWatchdog(opts?: Parameters<typeof InfraFlapWatchdog.prototype.constructor>[1]) {
    return new InfraFlapWatchdog(
      { shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } },
      opts,
    );
  }

  it('first tick: 1 sample only, no trip', () => {
    const wd = makeWatchdog({ now: () => 0 });
    const tripped = wd.evaluateSamples([
      { containerId: 'a', containerName: 'cds-infra-foo', restartCount: 5, status: 'restarting', ts: 0 },
    ]);
    expect(tripped).toEqual([]);
  });

  it('delta below threshold: no trip', () => {
    let now = 0;
    const wd = makeWatchdog({ now: () => now, restartDeltaThreshold: 5, windowMs: 300_000, tickIntervalMs: 60_000 });
    wd.evaluateSamples([
      { containerId: 'a', containerName: 'cds-infra-foo', restartCount: 5, status: 'restarting', ts: now },
    ]);
    now = 60_000;
    const tripped = wd.evaluateSamples([
      { containerId: 'a', containerName: 'cds-infra-foo', restartCount: 7, status: 'restarting', ts: now },
    ]);
    expect(tripped).toEqual([]);
  });

  it('delta ≥ threshold within window: trips', () => {
    let now = 0;
    const wd = makeWatchdog({ now: () => now, restartDeltaThreshold: 5, windowMs: 300_000 });
    wd.evaluateSamples([
      { containerId: 'a', containerName: 'cds-infra-bad', restartCount: 100, status: 'restarting', ts: now },
    ]);
    now = 120_000;
    const tripped = wd.evaluateSamples([
      { containerId: 'a', containerName: 'cds-infra-bad', restartCount: 110, status: 'restarting', ts: now },
    ]);
    expect(tripped).toHaveLength(1);
    expect(tripped[0].containerName).toBe('cds-infra-bad');
  });

  it('does not re-trip a container after first circuit-break', () => {
    let now = 0;
    const wd = makeWatchdog({ now: () => now, restartDeltaThreshold: 5, windowMs: 300_000 });
    wd.evaluateSamples([
      { containerId: 'a', containerName: 'cds-infra-bad', restartCount: 100, status: 'restarting', ts: now },
    ]);
    now = 60_000;
    const first = wd.evaluateSamples([
      { containerId: 'a', containerName: 'cds-infra-bad', restartCount: 110, status: 'restarting', ts: now },
    ]);
    expect(first).toHaveLength(1);
    now = 120_000;
    const second = wd.evaluateSamples([
      { containerId: 'a', containerName: 'cds-infra-bad', restartCount: 120, status: 'restarting', ts: now },
    ]);
    expect(second).toEqual([]);
  });

  it('clears history when container disappears from docker', () => {
    let now = 0;
    const wd = makeWatchdog({ now: () => now });
    wd.evaluateSamples([
      { containerId: 'a', containerName: 'cds-infra-a', restartCount: 3, status: 'running', ts: now },
    ]);
    now = 60_000;
    // container 'a' rm'd, only 'b' present now
    wd.evaluateSamples([
      { containerId: 'b', containerName: 'cds-infra-b', restartCount: 1, status: 'running', ts: now },
    ]);
    // container 'a' comes back with fresh ID — should start fresh history, not trip on old delta
    now = 120_000;
    const tripped = wd.evaluateSamples([
      { containerId: 'a-new', containerName: 'cds-infra-a', restartCount: 50, status: 'running', ts: now },
    ]);
    expect(tripped).toEqual([]);
  });

  it('window expiry: old samples don\'t count toward delta', () => {
    let now = 0;
    const wd = makeWatchdog({ now: () => now, restartDeltaThreshold: 5, windowMs: 60_000 });
    wd.evaluateSamples([
      { containerId: 'a', containerName: 'cds-infra-slow', restartCount: 0, status: 'restarting', ts: now },
    ]);
    // wait > windowMs, then arrive with high count — but oldest sample was pruned,
    // and current sample is the only one in window → delta requires 2 samples in window
    now = 180_000;
    const noTrip = wd.evaluateSamples([
      { containerId: 'a', containerName: 'cds-infra-slow', restartCount: 50, status: 'restarting', ts: now },
    ]);
    expect(noTrip).toEqual([]);
  });

  it('multiple containers tracked independently', () => {
    let now = 0;
    const wd = makeWatchdog({ now: () => now, restartDeltaThreshold: 5, windowMs: 300_000 });
    wd.evaluateSamples([
      { containerId: 'a', containerName: 'cds-infra-a', restartCount: 0, status: 'restarting', ts: now },
      { containerId: 'b', containerName: 'cds-infra-b', restartCount: 0, status: 'running', ts: now },
    ]);
    now = 60_000;
    const tripped = wd.evaluateSamples([
      { containerId: 'a', containerName: 'cds-infra-a', restartCount: 10, status: 'restarting', ts: now },
      { containerId: 'b', containerName: 'cds-infra-b', restartCount: 1, status: 'running', ts: now },
    ]);
    expect(tripped).toHaveLength(1);
    expect(tripped[0].containerName).toBe('cds-infra-a');
  });
});

describe('InfraFlapWatchdog dummy samples type', () => {
  it('FlapSample shape', () => {
    const s: FlapSample = { containerId: 'x', containerName: 'cds-infra-x', restartCount: 0, status: 'created', ts: 0 };
    expect(s.containerId).toBe('x');
  });
});
