import { describe, it, expect, vi } from 'vitest';
import { stopServiceForCooling } from '../../src/services/scheduler-service-stop.js';
import type { ServiceState } from '../../src/types.js';

import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function actualCoolingCallback(context: Record<string, unknown>): (slug: string) => Promise<void> {
  const file = ts.createSourceFile('index.ts', fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'schedulerService.setCoolFn') callback = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!callback) throw new Error('真实调度停止入口缺失');
  const code = ts.transpileModule('globalThis.cool = (' + callback.getText(file) + ');', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInNewContext(code, context);
  return context.cool as (slug: string) => Promise<void>;
}

describe('生产降温回调的真实停止结果', () => {
  function setup(stop: ReturnType<typeof vi.fn>, assertCurrent = vi.fn()) {
    const svc = service(); svc.status = 'running';
    const branch = { id: 'branch', projectId: 'project', branch: 'feature', status: 'running', services: { api: svc }, replicaSets: {} };
    const released = vi.fn(), completed = vi.fn();
    const callback = actualCoolingCallback({
      stateService: { getBranch: () => branch, save: vi.fn(), appendActivityLog: vi.fn(), incrementBranchStat: vi.fn() },
      beginBackgroundBranchOperation: () => ({ operationId: 'owned-operation', assertCurrent }),
      completeBackgroundBranchOperation: completed,
      containerService: { stopRuntimeGroup: stop },
      getObservedRunningContainerNames: () => new Set(['candidate', 'serving']),
      serviceRuntimeRefs: (s: ServiceState) => [s, s.servingRuntime].filter(Boolean),
      stopServiceForCooling, forgetConfirmedStoppedContainers: released,
      archiveBranchContainerLogs: vi.fn().mockResolvedValue(undefined),
      config: { scheduler: { idleTTLSeconds: 900 } }, activeServerEventLogStore: undefined,
      console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, Date, Math,
    });
    return { callback, branch, svc, released, completed };
  }

  it('生产降温停止失败保留状态和驻留，之后同组确认成功才释放', async () => {
    const error = new Error('owned stop unconfirmed');
    const stop = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const x = setup(stop);
    await expect(x.callback('branch')).rejects.toBe(error);
    expect(x.branch.status).toBe('error'); expect(x.svc.status).toBe('running');
    expect(x.released).not.toHaveBeenCalled();
    expect(x.completed).toHaveBeenLastCalledWith(expect.anything(), 'failed');
    await x.callback('branch');
    expect(x.svc.status).toBe('stopped'); expect(x.branch.status).toBe('idle');
    expect(x.released).toHaveBeenCalledWith(['candidate', 'serving']);
    expect(x.completed).toHaveBeenLastCalledWith(expect.anything(), 'completed');
  });

  it('生产降温停止返回时资格撤销不得确认停止或释放驻留', async () => {
    let revoked = false;
    const x = setup(vi.fn().mockImplementation(async () => { revoked = true; }), () => { if (revoked) throw new Error('superseded'); });
    await expect(x.callback('branch')).rejects.toThrow('superseded');
    expect(x.svc.status).not.toBe('stopped'); expect(x.released).not.toHaveBeenCalled();
    expect(x.completed).toHaveBeenLastCalledWith(expect.anything(), 'failed');
  });
});


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
