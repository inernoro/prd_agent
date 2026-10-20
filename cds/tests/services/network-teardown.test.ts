import { describe, it, expect } from 'vitest';
import { processNetworkTeardowns, type NetworkTeardownState } from '../../src/services/network-teardown.js';
import { branchAppNetworkName } from '../../src/services/branch-network.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

function fixture() {
  const name = branchAppNetworkName('removed-project-long-branch-' + 'x'.repeat(100));
  let tasks = [{ name, projectId: 'removed' }];
  const projects: Array<{ id: string; dockerNetwork?: string }> = [];
  const branches: Array<{ id: string }> = [];
  const state: NetworkTeardownState = {
    getNetworkTeardowns: () => tasks,
    removeNetworkTeardown: (name, projectId) => { tasks = tasks.filter(t => t.name !== name || t.projectId !== projectId); },
    getProjects: () => projects,
    getAllBranches: () => branches,
  };
  const shell = new MockShellExecutor();
  const id = 'a'.repeat(64);
  let endpoints: Record<string, unknown> = {};
  shell.addResponsePattern(/^docker network inspect /, () => ({ stdout: JSON.stringify([{ Id: id, Containers: endpoints }]), stderr: '', exitCode: 0 }));
  shell.addResponsePattern(/^docker network rm /, () => ({ stdout: id, stderr: '', exitCode: 0 }));
  return { state, shell, name, id, projects, branches, setEndpoints: (value: Record<string, unknown>) => { endpoints = value; } };
}

describe('删除项目网络补偿', () => {
  it('删除精确快照内的空网络，按 ID 删除而不是按可复用的名称', async () => {
    const f = fixture();
    await processNetworkTeardowns(f.shell, f.state);
    expect(f.shell.commands).toEqual([`docker network inspect ${f.name}`, `docker network rm ${f.id}`]);
    expect(f.state.getNetworkTeardowns()).toEqual([]);
  });
  it('保留有端点网络，下一次补偿在端点退出后重试', async () => {
    const f = fixture();
    f.setEndpoints({ unrelated: {} });
    await processNetworkTeardowns(f.shell, f.state);
    expect(f.shell.commands.some(c => c.startsWith('docker network rm'))).toBe(false);
    expect(f.state.getNetworkTeardowns()).toHaveLength(1);
    f.setEndpoints({});
    await processNetworkTeardowns(f.shell, f.state);
    expect(f.state.getNetworkTeardowns()).toEqual([]);
  });
  it('删除失败后原项目仍在或网络被新项目认领时不删除', async () => {
    const f = fixture();
    f.projects.push({ id: 'removed' });
    await processNetworkTeardowns(f.shell, f.state);
    expect(f.shell.commands).toEqual([]);
    f.projects.splice(0);
    f.projects.push({ id: 'new', dockerNetwork: f.name });
    await processNetworkTeardowns(f.shell, f.state);
    expect(f.shell.commands).toEqual([]);
  });
  it('Docker 暂不可用保留任务，绝不扩大成网络 prune', async () => {
    const f = fixture();
    f.shell.addResponsePatternFirst(/^docker network inspect /, () => ({ stdout: '', stderr: 'Cannot connect to Docker daemon', exitCode: 1 }));
    await processNetworkTeardowns(f.shell, f.state);
    expect(f.state.getNetworkTeardowns()).toHaveLength(1);
    expect(f.shell.commands).toEqual([`docker network inspect ${f.name}`]);
  });
});
