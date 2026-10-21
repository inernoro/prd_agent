import { describe, it, expect, vi } from 'vitest';
import { recoverBranchRuntime } from '../../src/services/branch-runtime-recovery.js';
import { servingRuntime } from '../../src/services/service-runtime.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';

function fixture() {
  const sha = 'a'.repeat(40), cid = 'b'.repeat(64);
  const entry = { id: 'branch', projectId: 'project', githubCommitSha: sha, status: 'error', errorMessage: 'historical failure',
    services: { api: { profileId: 'api', containerId: cid, containerName: 'current', hostPort: 2000, status: 'running', networkName: 'cohort',
      servingRuntime: { containerName: 'old', containerId: 'c'.repeat(64), hostPort: 1000, networkName: 'old-network' } } } } as BranchEntry;
  const state = { save: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) };
  const container = {
    inspectOwnedRuntime: vi.fn().mockImplementation(async (_entry, _id, runtime) => runtime),
    connectReplacementPeer: vi.fn().mockResolvedValue(undefined), isolateReplacementPeer: vi.fn().mockResolvedValue(undefined),
    restartServiceInPlace: vi.fn().mockResolvedValue(true), waitForReadiness: vi.fn().mockResolvedValue(true), waitForStartupSignal: vi.fn(),
  };
  const profiles = [{ id: 'api', name: 'API', readinessProbe: { path: '/health' } }] as BuildProfile[];
  const options = { entry, profiles, state: state as any, container, expectedCommitSha: sha, expectedContainers: { api: cid }, restartProfiles: ['api'], assertCurrent: vi.fn() };
  return { entry, state, container, options };
}

describe('当前同批容器恢复', () => {
  it.each(['sha', 'scope', 'container', 'foreign', 'missing'])('%s前置失败时不连网、不重启、不发布', async mode => {
    const f = fixture();
    if (mode === 'sha') f.options.expectedCommitSha = 'd'.repeat(40);
    if (mode === 'scope') f.options.expectedContainers = {} as any;
    if (mode === 'container') f.options.expectedContainers.api = 'e'.repeat(64);
    if (mode === 'foreign') f.container.inspectOwnedRuntime.mockRejectedValueOnce(new Error('foreign'));
    if (mode === 'missing') f.container.inspectOwnedRuntime.mockResolvedValueOnce(null);
    await expect(recoverBranchRuntime(f.options)).rejects.toThrow();
    expect(f.container.connectReplacementPeer).not.toHaveBeenCalled();
    expect(f.container.restartServiceInPlace).not.toHaveBeenCalled();
    expect(servingRuntime(f.entry.services.api)?.containerName).toBe('old');
  });

  it('真实就绪失败保留原入口和失败记录；不创建或删除数据库容器', async () => {
    const f = fixture(); f.container.waitForReadiness.mockResolvedValueOnce(false);
    await expect(recoverBranchRuntime(f.options)).rejects.toThrow('未通过就绪');
    expect(servingRuntime(f.entry.services.api)?.containerName).toBe('old');
    expect(f.entry.status).toBe('error'); expect(f.entry.errorMessage).toBe('historical failure');
    expect(f.container.restartServiceInPlace).toHaveBeenCalledWith('b'.repeat(64), undefined, expect.objectContaining({ branchId: 'branch', projectId: 'project', assertCurrent: expect.any(Function) }));
  });

  it('持久化确认前保持旧入口，确认后只发布已验证的当前身份并保留历史', async () => {
    const f = fixture(); let release!: () => void, entered!: () => void;
    const saving = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.state.flush.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { entered(); await pending; });
    const recovery = recoverBranchRuntime(f.options); await saving;
    expect(servingRuntime(f.entry.services.api)?.containerName).toBe('old');
    release(); await recovery;
    expect(servingRuntime(f.entry.services.api)?.containerName).toBe('current');
    expect(f.entry.services.api.retainedRuntimes?.[0].containerName).toBe('old');
    expect(f.entry.status).toBe('running');
  });

  it('发布落盘失败恢复原入口和原失败状态', async () => {
    const f = fixture(); f.state.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk'));
    await expect(recoverBranchRuntime(f.options)).rejects.toThrow('disk');
    expect(servingRuntime(f.entry.services.api)?.containerName).toBe('old');
    expect(f.entry.status).toBe('error'); expect(f.entry.errorMessage).toBe('historical failure');
  });

  it('中途出现新容器身份时不重启迟到对象、不发布旧计划', async () => {
    const f = fixture(); f.container.inspectOwnedRuntime.mockImplementationOnce(async (_entry, _id, runtime) => {
      f.entry.services.api.containerId = 'f'.repeat(64); return runtime;
    });
    await expect(recoverBranchRuntime(f.options)).rejects.toThrow('身份已变化');
    expect(f.container.connectReplacementPeer).not.toHaveBeenCalled();
    expect(f.container.restartServiceInPlace).not.toHaveBeenCalled();
  });
});
