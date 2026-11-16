import { afterEach, describe, expect, it } from 'vitest';
import { ContainerService } from '../../src/services/container.js';
import { deploymentPhaseBudget } from '../../src/services/deployment-phase-budget.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig, ServiceState } from '../../src/types.js';

const name = 'owned-stop-reservation';
const id = 'a'.repeat(64);
const oldOwner = { projectId: 'owned', branchId: 'branch', operationId: 'old' };
const newOwner = { ...oldOwner, operationId: 'new' };
afterEach(() => { for (const key of [name, id, name + '-peer']) deploymentPhaseBudget.releaseMemory(key); });

function fixture(onStop?: () => void, confirmed = true) {
  let stopped = false;
  const shell = new MockShellExecutor();
  shell.addResponsePattern(/docker inspect /, () => ({ exitCode: 0, stderr: '', stdout: JSON.stringify([
    { Id: id, Name: '/' + name, State: { Running: !stopped, Status: stopped ? 'exited' : 'running', ExitCode: 0 } },
  ]) }));
  shell.addResponsePattern(/docker stop /, () => {
    onStop?.(); stopped = confirmed;
    return { exitCode: confirmed ? 0 : 1, stdout: '', stderr: confirmed ? '' : 'owned daemon unavailable' };
  });
  const container = new ContainerService(shell, {} as CdsConfig);
  const service = { profileId: 'api', containerName: name, containerId: id, status: 'running', hostPort: 1 } as ServiceState;
  return { container, service, shell };
}

describe('真实停止确认只结算原容量预约', () => {
  it.each([false, true])('旧直接停止不能释放异步期间新增的同名预约，原预约存在=%s', async existing => {
    if (existing) deploymentPhaseBudget.reserveKnownMemory(name, 128, oldOwner);
    const { container } = fixture(() => deploymentPhaseBudget.reserveKnownMemory(name, 256, newOwner));
    await container.stop(name, 'owned stop', oldOwner);
    expect(deploymentPhaseBudget.memorySnapshot().find(row => row.key === name))
      .toMatchObject({ memoryMB: 256, owner: newOwner });
  });

  it('按准确CID确认停止后结算原容器名预约，不能遗留已停止资源', async () => {
    deploymentPhaseBudget.reserveKnownMemory(name, 128, oldOwner);
    const { container, service, shell } = fixture();
    await container.stopRuntimeGroup(service, 'owned stop', oldOwner);
    expect(shell.commands).toContain('docker stop ' + id);
    expect(deploymentPhaseBudget.memorySnapshot().some(row => row.key === name)).toBe(false);
  });

  it('按CID停止期间同名预约已换代时保留后继对象', async () => {
    deploymentPhaseBudget.reserveKnownMemory(name, 128, oldOwner);
    const { container, service } = fixture(() => deploymentPhaseBudget.reserveKnownMemory(name, 256, newOwner));
    await container.stopRuntimeGroup(service, 'owned stop', oldOwner);
    expect(deploymentPhaseBudget.memorySnapshot().find(row => row.key === name))
      .toMatchObject({ memoryMB: 256, owner: newOwner });
  });

  it('准确CID停止未确认时保留原预约并拒绝成功', async () => {
    deploymentPhaseBudget.reserveKnownMemory(name, 128, oldOwner);
    const { container, service } = fixture(undefined, false);
    await expect(container.stopRuntimeGroup(service, 'owned stop', oldOwner)).rejects.toThrow('停止结果未确认');
    expect(deploymentPhaseBudget.memorySnapshot().find(row => row.key === name))
      .toMatchObject({ memoryMB: 128, owner: oldOwner });
  });

  it('等待停止槽期间换代的预约不被迟到停止清掉', async () => {
    deploymentPhaseBudget.reserveKnownMemory(name, 128, oldOwner);
    const release = await deploymentPhaseBudget.acquire('terminal', oldOwner);
    const { container } = fixture();
    const stopped = container.stop(name, 'owned stop', oldOwner);
    deploymentPhaseBudget.reserveKnownMemory(name, 256, newOwner);
    release(); await stopped;
    expect(deploymentPhaseBudget.memorySnapshot().find(row => row.key === name))
      .toMatchObject({ memoryMB: 256, owner: newOwner });
  });

  it('前一个组员异步停止期间换代的后组员预约仍受原对象保护', async () => {
    const peer = name + '-peer'; let replaced = false;
    deploymentPhaseBudget.reserveKnownMemory(peer, 128, oldOwner);
    const { container, service } = fixture(() => {
      if (!replaced) { replaced = true; deploymentPhaseBudget.reserveKnownMemory(peer, 256, newOwner); }
    });
    service.containerId = undefined;
    service.servingRuntime = { containerName: peer, hostPort: 2 };
    await container.stopRuntimeGroup(service, 'owned stop', oldOwner);
    expect(deploymentPhaseBudget.memorySnapshot().find(row => row.key === peer))
      .toMatchObject({ memoryMB: 256, owner: newOwner });
  });
});
