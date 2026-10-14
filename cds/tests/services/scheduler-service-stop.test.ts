import { describe, it, expect, vi } from 'vitest';
import { stopServiceForCooling } from '../../src/services/scheduler-service-stop.js';
import type { ServiceState } from '../../src/types.js';

const service = (): ServiceState => ({ profileId: 'api', containerName: 'candidate', hostPort: 10001, status: 'error',
  servingRuntime: { containerName: 'serving', hostPort: 10002 } });

describe('真实停止确认与降温状态', () => {
  it('未知停止不能标 stopped 或释放驻留；下一次确认后才释放全部身份', async () => {
    const svc = service();
    const container = { stopRuntimeGroup: vi.fn().mockRejectedValueOnce(new Error('executor unavailable')).mockResolvedValueOnce(undefined) };
    const released = vi.fn();
    await expect(stopServiceForCooling({ service: svc, container, context: {}, confirmedStopped: released })).rejects.toThrow('executor unavailable');
    expect(svc.status).toBe('error'); expect(released).not.toHaveBeenCalled();
    expect(svc.servingRuntime?.containerName).toBe('serving');
    await stopServiceForCooling({ service: svc, container, context: {}, confirmedStopped: released });
    expect(svc.status).toBe('stopped'); expect(released).toHaveBeenCalledWith(['candidate', 'serving']);
  });

  it('停止返回后的租约被取代时不确认降温', async () => {
    const svc = service(); const released = vi.fn();
    const container = { stopRuntimeGroup: vi.fn().mockResolvedValue(undefined) };
    let checks = 0;
    const check = () => { if (++checks > 1) throw new Error('superseded'); };
    await expect(stopServiceForCooling({ service: svc, container, context: {}, assertCurrent: check, confirmedStopped: released })).rejects.toThrow('superseded');
    expect(svc.status).toBe('stopping'); expect(released).not.toHaveBeenCalled();
  });
});
