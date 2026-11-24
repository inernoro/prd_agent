import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EGRESS_HEALTH_EXEC_TIMEOUT_MS, EGRESS_HEALTH_PROBE_SCRIPT } from '../../src/services/agent-egress-health.js';

type Outcome = number | 'error' | 'stall';

function runProbe(outcomes: Outcome[]) {
  const exit = vi.fn();
  let count = 0;
  const get = vi.fn((url: string, callback: (response: unknown) => void) => {
    expect(url).toBe('http://127.0.0.1:8787/__health');
    const outcome = outcomes[Math.min(count++, outcomes.length - 1)];
    const request = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      setTimeout: (ms: number, callback: () => void) => void;
    };
    request.destroy = () => request.emit('error', new Error('closed'));
    request.setTimeout = (ms, callback) => {
      if (outcome === 'stall') setTimeout(callback, ms);
    };
    if (outcome !== 'stall') setTimeout(() => {
      if (outcome === 'error') request.emit('error', new Error('starting'));
      else callback({ statusCode: outcome, resume: vi.fn() });
    }, 1);
    return request;
  });
  vm.runInNewContext(EGRESS_HEALTH_PROBE_SCRIPT, {
    require: (id: string) => {
      expect(id).toBe('node:http');
      return { get };
    },
    Date, setTimeout, clearTimeout, process: { exit },
  });
  return { get, exit };
}

afterEach(() => vi.useRealTimers());

describe('single-process egress readiness', () => {
  it('retries startup errors and rejects non-204 responses before readiness', async () => {
    vi.useFakeTimers();
    const { get, exit } = runProbe(['error', 503, 204]);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(get).toHaveBeenCalledTimes(3);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(EGRESS_HEALTH_EXEC_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it.each([200, 401, 503, 'error', 'stall'] as Outcome[])('fails closed with a bounded deadline for %s', async outcome => {
    vi.useFakeTimers();
    const { get, exit } = runProbe([outcome]);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    const stoppedCount = get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(get).toHaveBeenCalledTimes(stoppedCount);
  });
});
