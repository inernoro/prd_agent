import { describe, expect, it } from 'vitest';
import {
  EVENT_LOOP_LAG_CRITICAL_MS,
  collectControlPlanePressure,
  type ControlPlanePressureInput,
} from '../../src/services/control-plane-pressure.js';

/**
 * 控制面压力快照（2026-09-08）。每条告警的判据钉在这里：宿主过载、事件循环卡顿、
 * 探活停摆、构建限流、容器未挂 slice、审计熔断。线上 09-08 早上的真实数据
 * （18 核 load 26.2、探活 24h 未完成）必须命中 critical。
 */
function baseInput(overrides: Partial<ControlPlanePressureInput> = {}): ControlPlanePressureInput {
  return {
    host: { cores: 18, loadAvg: [4, 4, 4], totalMB: 96_556, freeMB: 40_000 },
    eventLoop: { enabled: true, windowStartedAt: null, current: { p50Ms: 1, p99Ms: 5, maxMs: 9, samples: 100 }, previous: null },
    buildGate: { active: 1, queued: 0, max: 3, load: { load1: 4, cores: 18, ratio: 0.22, factor: 1.2, saturated: false } },
    uptimeMonitor: { ok: true, running: false, lastCycleAt: 1, sinceLastCycleMs: 30_000, stale: false, watchdogResets: 0, probeDeadlineHits: 0 },
    workloadCgroup: { enabled: true, parent: 'system-cdsworkloads.slice', driver: 'systemd', weightManaged: true, reason: 'ok' },
    webhookNoise: null,
    offhostAudit: null,
    ...overrides,
  };
}

describe('collectControlPlanePressure', () => {
  it('健康宿主：无告警、不 degraded', () => {
    const p = collectControlPlanePressure(baseInput());
    expect(p.warnings).toEqual([]);
    expect(p.degraded).toBe(false);
    expect(p.host).toMatchObject({ cores: 18, loadAvg1: 4, loadRatio: 0.22 });
  });

  it('09-08 线上真实数据：load 26.2/18 核 + 探活 24h 停摆 → 两条 critical', () => {
    const p = collectControlPlanePressure(baseInput({
      host: { cores: 18, loadAvg: [26.24, 17.56, 20.57], totalMB: 96_556, freeMB: 33_009 },
      uptimeMonitor: { ok: false, running: true, lastCycleAt: 1, sinceLastCycleMs: 24 * 3600_000, stale: true, watchdogResets: 0, probeDeadlineHits: 0 },
      buildGate: { active: 3, queued: 4, max: 3, load: { load1: 26.24, cores: 18, ratio: 1.46, factor: 1.2, saturated: true } },
    }));
    const codes = p.warnings.map((w) => `${w.level}:${w.code}`);
    expect(codes).toContain('critical:host-overloaded');
    expect(codes).toContain('critical:uptime-monitor-stale');
    expect(codes).toContain('warning:build-throttled-by-load');
    expect(p.degraded).toBe(true);
    expect(p.host.loadRatio).toBe(1.46);
  });

  it('事件循环 p99 取当前与上一窗口的较大值判卡顿', () => {
    const p = collectControlPlanePressure(baseInput({
      eventLoop: {
        enabled: true, windowStartedAt: null,
        current: { p50Ms: 1, p99Ms: 5, maxMs: 9, samples: 3 },
        previous: { p50Ms: 20, p99Ms: EVENT_LOOP_LAG_CRITICAL_MS + 1, maxMs: 3000, samples: 900 },
      },
    }));
    expect(p.warnings.map((w) => w.code)).toContain('event-loop-stalled');
    expect(p.degraded).toBe(true);
  });

  it('容器未挂 slice / 权重未接管 / 审计熔断 → warning 而非 critical', () => {
    const p = collectControlPlanePressure(baseInput({
      workloadCgroup: { enabled: true, parent: '/cdsworkloads', driver: 'cgroupfs', weightManaged: false, reason: 'cgroupfs' },
      offhostAudit: { consecutiveFailures: 9, open: true, openedAt: 'x', nextRetryAt: 'y', skippedWhileOpen: 120, lastError: 'boom' },
    }));
    expect(p.warnings.map((w) => `${w.level}:${w.code}`)).toEqual([
      'warning:workload-cgroup-unmanaged',
      'warning:offhost-audit-breaker-open',
    ]);
    expect(p.degraded).toBe(false);
  });
});
