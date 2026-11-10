import { describe, expect, it, vi } from 'vitest';
import { UptimeMonitorService } from '../../src/services/uptime-monitor.js';
import type { UptimeCustomMonitor } from '../../src/types.js';
describe('通知回调失败隔离', () => {
  it.each(['sync', 'async'])('%s通知失败被记录且不破坏探测与故障台账', async mode => {
    const warn = vi.fn();
    const monitor: UptimeCustomMonitor = { id: 'callback', name: '回调检查', kind: 'http', url: 'https://callback.invalid', enabled: true, projectId: 'p', createdAt: '', updatedAt: '' };
    const service = new UptimeMonitorService({
      state: { getAllBranches: () => [], getUptimeMonitors: () => [monitor] },
      config: { enabled: true, intervalMs: 60_000, timeoutMs: 1000, failureThreshold: 1, recoveryThreshold: 1, maxSamples: 20, excludePatterns: [], scope: 'all', userViewEnabled: false },
      probe: async () => ({ up: false, ms: 1, code: 500 }), logger: { warn },
      onAlert: mode === 'async' ? async () => { throw new Error('fixture callback rejected'); } : () => { throw new Error('fixture callback rejected'); },
    });
    await expect(service.probeNow('monitor@callback')).resolves.toMatchObject({ status: 'down' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[uptime] 告警外发失败: fixture callback rejected'));
    expect(service.getIncidents()).toHaveLength(1);
  });
});
