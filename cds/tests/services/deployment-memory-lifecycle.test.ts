import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ContainerService } from '../../src/services/container.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { deploymentPhaseBudget } from '../../src/services/deployment-phase-budget.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { setBuildGateHostLoadProvider } from '../../src/services/build-gate.js';
import type { CdsConfig, ServiceState } from '../../src/types.js';

const owner = { projectId: 'p1', branchId: 'b1', profileId: 'api', operationId: 'op-old', operationGeneration: 1 };
const runtime: ServiceState = { profileId: 'api', containerName: 'cds-b1-api', hostPort: 10001,
  status: 'error', containerId: 'a'.repeat(64), creationIssued: true };
const config: CdsConfig = { repoRoot: '/repo', worktreeBase: '/wt', masterPort: 9900, workerPort: 5500,
  dockerNetwork: 'test-network', portStart: 10001, sharedEnv: {}, jwt: { secret: 'test-secret', issuer: 'test' } };

describe('部署内存预约生命周期：原真实清理接缝回归', () => {
  let mock: MockShellExecutor;
  beforeEach(() => {
    mock = new MockShellExecutor();
    vi.stubEnv('CDS_BRANCH_NETWORK_ISOLATION', '0');
    setBuildGateHostLoadProvider(() => ({ load1: 0, cores: 18 }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setBuildGateHostLoadProvider(null); });

  it.each(['complete', 'diagnostics', 'stop', 'stop-returned', 'rm', 'rm-returned'] as const)('真实cleanup的%s边界：资格先于进展与派发，未确认不退款', async boundary => {
    const trace: string[] = [], progress: string[] = [];
    let current = true, entered!: () => void, resume!: () => void;
    const assigned = new Promise<void>(resolve => { entered = resolve; });
    const slot = new Promise<void>(resolve => { resume = resolve; });
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 512, owner);
    mock.addResponsePattern(/docker inspect/, () => ({ stdout: '[]', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker logs|docker stop|docker rm/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const delayed = new ContainerService({ exec: async (command, options) => {
      const action = /^docker (stop|rm) /.exec(command)?.[1];
      if (boundary === 'diagnostics' && command.startsWith('docker inspect ')) { entered(); await slot; }
      if (action === boundary) { entered(); await slot; }
      options?.beforeStart?.();
      if (action) trace.push(`physical:${action}`);
      const result = await mock.exec(command, options);
      if (action && boundary === `${action}-returned`) { entered(); await slot; }
      return result;
    } }, config);
    const removing = delayed.remove(runtime.containerName, { ...owner, assertCurrent: () => {
      trace.push('check'); if (!current) throw new Error('原清理资格失效');
    }, onProgress: step => { trace.push(`progress:${step}`); progress.push(step); } });
    const outcome = removing.then(() => undefined, error => error as Error);
    try {
      if (boundary !== 'complete') {
        await assigned;
        expect(deploymentPhaseBudget.snapshot().cleanup.active).toHaveLength(1);
        expect(deploymentPhaseBudget.memorySnapshot()).toHaveLength(1);
        current = false; resume();
      }
      const error = await outcome;
      const allProgress = ['admitted', 'diagnostics-returned', 'stop', 'stop-returned', 'rm', 'rm-returned'];
      const stoppedBefore = boundary === 'diagnostics' ? 1 : boundary === 'stop' ? 2 : boundary === 'stop-returned' ? 3 : boundary === 'rm' ? 4 : 5;
      expect(progress).toEqual(boundary === 'complete' ? allProgress : allProgress.slice(0, stoppedBefore));
      for (const step of progress) expect(trace[trace.indexOf(`progress:${step}`) - 1]).toBe('check');
      if (boundary === 'complete') {
        expect(error).toBeUndefined(); expect(trace.filter(item => item.startsWith('physical:'))).toEqual(['physical:stop', 'physical:rm']);
        expect(deploymentPhaseBudget.memorySnapshot()).toEqual([]);
      } else {
        expect(error?.message).toBe('原清理资格失效'); expect(trace).not.toContain(`physical:${boundary}`);
        expect(deploymentPhaseBudget.memorySnapshot().map(item => item.key)).toEqual(boundary === 'rm-returned' ? [] : [runtime.containerName]);
      }
      expect(deploymentPhaseBudget.snapshot().cleanup.active).toEqual([]);
    } finally { resume(); await outcome; }
  });

  it('真实操作池原15分钟截止发cancel后，回执未到不得提前释放cleanup槽或物理预约', async () => {
    vi.useFakeTimers();
    const messages: Array<{ type: string; id?: number; command?: string }> = [], progress: string[] = [];
    const channel = new EventEmitter() as EventEmitter & { connected: boolean; send: (message: any, callback?: (error: null) => void) => boolean; ref: () => void; unref: () => void };
    channel.connected = true; channel.ref = () => {}; channel.unref = () => {};
    channel.send = (message, callback) => {
      messages.push(message); callback?.(null);
      if (message.type === 'initialize') queueMicrotask(() => channel.emit('message', { type: 'ready' }));
      if (message.type === 'exec') queueMicrotask(() => channel.emit('message', { type: 'assigned', id: message.id }));
      return true;
    };
    // 只替换IPC传输，实际IsolatedShellExecutor负责计时、authorize、cancel及回执结算；不创建进程。
    const isolated = new IsolatedShellExecutor(mock, { processFactory: () => channel as unknown as ChildProcess,
      isolatedLane: 'operation', concurrency: 2, reservedCleanup: 1, defaultTimeoutMs: 15 * 60_000 });
    mock.addResponsePattern(/docker inspect/, () => ({ stdout: '[]', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker logs/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 512, owner);
    let settled = false;
    const removing = new ContainerService(isolated, config).remove(runtime.containerName, {
      ...owner, assertCurrent: () => undefined, onProgress: step => progress.push(step),
    });
    const outcome = removing.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const stop = messages.find(message => message.type === 'exec' && message.command?.startsWith('docker stop '));
      expect(stop).toBeDefined(); expect(messages).toContainEqual({ type: 'authorize', id: stop!.id });
      expect(progress).toEqual(['admitted', 'diagnostics-returned', 'stop']);
      await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
      expect(messages.some(message => message.type === 'cancel')).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(messages).toContainEqual({ type: 'cancel', id: stop!.id });
      expect(settled).toBe(false); expect(progress).toEqual(['admitted', 'diagnostics-returned', 'stop']);
      expect(deploymentPhaseBudget.snapshot().cleanup.active).toHaveLength(1);
      expect(deploymentPhaseBudget.memorySnapshot()).toHaveLength(1);
      channel.emit('message', { type: 'cancelled', id: stop!.id });
      expect(await outcome).toMatchObject({ code: 'deadline' });
      expect(deploymentPhaseBudget.snapshot().cleanup.active).toEqual([]);
      expect(deploymentPhaseBudget.memorySnapshot().map(item => item.key)).toEqual([runtime.containerName]);
      expect(messages.some(message => message.command?.startsWith('docker rm '))).toBe(false);
      expect(isolated.getStats()).toMatchObject({ active: 0, queued: 0, bytes: 0 });
    } finally {
      for (const message of messages.filter(item => item.type === 'exec')) channel.emit('message', { type: 'cancelled', id: message.id });
      await outcome; vi.useRealTimers();
    }
  });

  it.each(['absent', 'present', 'unavailable', 'replaced'] as const)('真实rm返回不是CID消失证明：后置inspect=%s仍按原确认与预约CAS结算', async result => {
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 512, owner);
    mock.addResponsePattern(/docker inspect --format.*"networks"/, () => ({ stdout: JSON.stringify({
      id: runtime.containerId, running: true, project: 'p1', branch: 'b1', profile: 'api',
      networks: { 'test-network': { Aliases: ['api'] } } }), stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker inspect --format/, () => {
      if (result === 'replaced') deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 768,
        { ...owner, operationId: 'op-next', operationGeneration: 2 });
      return result === 'present' ? { stdout: runtime.containerId!, stderr: '', exitCode: 0 }
        : result === 'unavailable' ? { stdout: '', stderr: 'daemon unavailable', exitCode: 1 }
          : { stdout: '', stderr: `Error: No such container: ${runtime.containerId}`, exitCode: 1 };
    });
    mock.addResponsePattern(/docker inspect /, () => ({ stdout: '[]', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker logs|docker stop|docker rm/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const progress: string[] = [];
    const actual = new ContainerService({ exec: (command, options) => { options?.beforeStart?.(); return mock.exec(command, options); } }, config);
    const error = await actual.removeRuntimeGroup(structuredClone(runtime), { ...owner,
      assertCurrent: () => undefined, onProgress: step => progress.push(step) }).then(() => undefined, error => error as Error);
    expect(progress).toEqual(['admitted', 'diagnostics-returned', 'stop', 'stop-returned', 'rm', 'rm-returned']);
    expect(error?.message).toBe(result === 'present' || result === 'unavailable' ? '旧运行身份回收未确认，保留责任及容量占用' : undefined);
    if (result === 'absent') expect(deploymentPhaseBudget.memorySnapshot()).toEqual([]);
    else expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: runtime.containerName,
      memoryMB: result === 'replaced' ? 768 : 512, owner: result === 'replaced'
        ? { ...owner, operationId: 'op-next', operationGeneration: 2 } : owner })]);
    expect(deploymentPhaseBudget.snapshot().cleanup.active).toEqual([]);
  });

});
