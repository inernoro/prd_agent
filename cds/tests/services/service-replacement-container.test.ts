import { describe, expect, it, vi } from 'vitest';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BranchEntry, CdsConfig } from '../../src/types.js';

function fixture() {
  const shell = new MockShellExecutor();
  const container = new ContainerService(shell, { dockerNetwork: 'shared', sharedEnv: {}, repoRoot: '/tmp' } as CdsConfig);
  const entry = { id: 'branch', projectId: 'project' } as BranchEntry;
  const runtime = { containerName: 'old-api', containerId: 'a'.repeat(64), hostPort: 10001, networkName: 'old-network' };
  const identity = { id: runtime.containerId, running: true, branch: entry.id, project: entry.projectId,
    profile: 'api', networks: { 'old-network': { Aliases: ['api'] } } };
  shell.addResponsePattern(/docker inspect.*"running"/, () => ({ stdout: JSON.stringify(identity), stderr: '', exitCode: 0 }));
  const remove = vi.spyOn(container, 'remove').mockResolvedValue(undefined);
  return { shell, container, entry, runtime, identity, remove };
}

describe('替换运行身份与回收证明', () => {
  it('使用完整CID和归属确认回收，名称被重用也不删新同名容器', async () => {
    const f = fixture();
    f.shell.addResponsePattern(/docker inspect --format '\{\{.Id\}\}'/, () => ({ stdout: '', stderr: 'Error: No such object: exact-id', exitCode: 1 }));
    await f.container.removeOwnedRuntime(f.entry, 'api', f.runtime);
    expect(f.remove).toHaveBeenCalledWith(f.runtime.containerId, expect.anything());
    expect(f.shell.commands.every(command => !command.endsWith("'old-api'"))).toBe(true);
  });

  it.each(['still-exists', 'daemon-unavailable'] as const)('%s时不把remove返回当成删除确认', async mode => {
    const f = fixture();
    f.shell.addResponsePattern(/docker inspect --format '\{\{.Id\}\}'/, () => mode === 'still-exists'
      ? { stdout: f.runtime.containerId, stderr: '', exitCode: 0 }
      : { stdout: '', stderr: 'Cannot connect to Docker daemon', exitCode: 1 });
    await expect(f.container.removeOwnedRuntime(f.entry, 'api', f.runtime)).rejects.toThrow('回收未确认');
  });

  it('归属不符拒绝删除，已退出容器仍必须校验归属', async () => {
    const f = fixture(); f.identity.running = false; f.identity.project = 'another-project';
    await expect(f.container.removeOwnedRuntime(f.entry, 'api', f.runtime)).rejects.toThrow('归属无法确认');
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('未确认创建的一次不存在观察不抹掉迟到责任', async () => {
    const f = fixture();
    f.shell.addResponsePatternFirst(/docker inspect/, () => ({ stdout: '', stderr: 'No such container: unknown', exitCode: 1 }));
    await expect(f.container.removeOwnedRuntime(f.entry, 'api', { ...f.runtime, containerId: undefined, creationIssued: true })).rejects.toThrow('迟到创建身份未确认');
    expect(f.remove).not.toHaveBeenCalled();
  });
});
