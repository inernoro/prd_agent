import { describe, it, expect, vi } from 'vitest';
import { recoverBranchRuntime } from '../../src/services/branch-runtime-recovery.js';
import { servingRuntime } from '../../src/services/service-runtime.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';
import { branchAppNetworkName } from '../../src/services/branch-network.js';

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
    cleanupUnusedReplacementNetworks: vi.fn().mockResolvedValue(undefined),
  };
  const profiles = [{ id: 'api', name: 'API', readinessProbe: { path: '/health' } }] as BuildProfile[];
  const options = { entry, profiles, state: state as any, container, expectedCommitSha: sha, expectedContainers: { api: cid }, restartProfiles: ['api'], assertCurrent: vi.fn() };
  return { entry, state, container, options };
}

describe('当前同批容器恢复', () => {
  it('旧日志中的启动信号不能替代当前HTTP就绪失败，保留原入口', async () => {
    const f = fixture(), original = f.entry.services.api; f.options.profiles[0].startupSignal = 'ready';
    f.container.waitForStartupSignal.mockResolvedValue(true); f.container.waitForReadiness.mockResolvedValue(false);
    await expect(recoverBranchRuntime(f.options)).rejects.toThrow('未通过就绪验证');
    expect(f.container.waitForReadiness).toHaveBeenCalledOnce();
    expect(f.entry.services.api).toBe(original); expect(servingRuntime(original)?.containerName).toBe('old');
  });

  it('启动信号后仍等当前探测确认，原入口在等待期间持续服务且预算不放宽', async () => {
    const f = fixture(), original = f.entry.services.api; f.options.profiles[0].startupSignal = 'ready';
    f.container.waitForStartupSignal.mockResolvedValue(true);
    let release!: (ready: boolean) => void, entered!: () => void;
    const pending = new Promise<boolean>(resolve => { release = resolve; }), probing = new Promise<void>(resolve => { entered = resolve; });
    f.container.waitForReadiness.mockImplementation(async () => { entered(); return pending; });
    const recovery = recoverBranchRuntime(f.options);
    try {
      expect(await Promise.race([probing.then(() => 'probing'), recovery.then(() => 'published')])).toBe('probing');
      expect(f.entry.services.api).toBe(original); expect(servingRuntime(original)?.containerName).toBe('old');
      const budget = f.container.waitForReadiness.mock.calls[0][1].timeoutSeconds;
      expect(budget).toBeGreaterThan(0); expect(budget).toBeLessThanOrEqual(120);
    } finally { release(true); await recovery; }
    expect(f.entry.status).toBe('running');
  });

  it.each(['stopping', 'stopped'] as const)('发布落盘期间手动停止到%s后，迟到恢复不得覆盖继任状态', async status => {
    const f = fixture(); let current = true, entered!: () => void, release!: () => void;
    const saving = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.options.assertCurrent.mockImplementation(() => { if (!current) throw new Error('superseded by stop'); });
    f.state.flush.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { entered(); await pending; });
    const recovery = recoverBranchRuntime(f.options); await saving;
    const heldByStop = f.entry.services.api;
    heldByStop.status = status; f.entry.status = status === 'stopped' ? 'idle' : 'stopping';
    f.entry.errorMessage = 'stop-owned-result'; current = false; release();
    await expect(recovery).rejects.toThrow('superseded by stop');
    expect(f.entry.services.api).toBe(heldByStop);
    expect(f.entry.services.api.status).toBe(status);
    expect(f.entry.status).toBe(status === 'stopped' ? 'idle' : 'stopping');
    expect(f.entry.errorMessage).toBe('stop-owned-result');
    expect(f.container.cleanupUnusedReplacementNetworks).not.toHaveBeenCalled();
  });

  it.each(['restart', 'readiness', 'persistence'])('未公开服务%s失败后保留原连接，原身份可以继续恢复', async failure => {
    const f = fixture(), originalNetwork = branchAppNetworkName('branch'), connected = new Set([originalNetwork]);
    f.entry.services.api.status = 'error'; f.entry.services.api.servingRuntime = undefined; f.entry.services.api.networkName = originalNetwork;
    f.container.connectReplacementPeer.mockImplementation(async (_entry, _profile, _service, network) => { connected.add(network); });
    f.container.isolateReplacementPeer.mockImplementation(async (_entry, service, network, _check, protectedNetworks = []) => {
      if (!protectedNetworks.includes(originalNetwork)) connected.delete(originalNetwork);
      service.networkName = network;
    });
    f.container.cleanupUnusedReplacementNetworks.mockImplementation(async view => { for (const network of view.replacementNetworks) connected.delete(network); });
    if (failure === 'restart') f.container.restartServiceInPlace.mockResolvedValueOnce(false);
    if (failure === 'readiness') f.container.waitForReadiness.mockResolvedValueOnce(false);
    if (failure === 'persistence') f.state.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk'));
    await expect(recoverBranchRuntime(f.options)).rejects.toThrow();
    expect(connected.has(originalNetwork)).toBe(true);
    expect(f.entry.services.api.networkName).toBe(originalNetwork);
    expect(servingRuntime(f.entry.services.api)).toBeNull();
  });

  it('未公开服务在落盘确认前继续不可见，确认后才发布', async () => {
    const f = fixture(); f.entry.services.api.status = 'error'; f.entry.services.api.servingRuntime = undefined;
    let release!: () => void, entered!: () => void;
    const saving = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.state.flush.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { entered(); await pending; });
    const recovery = recoverBranchRuntime(f.options); await saving;
    try { expect(servingRuntime(f.entry.services.api)).toBeNull(); } finally { release(); await recovery; }
    expect(servingRuntime(f.entry.services.api)?.containerName).toBe('current');
  });

  it.each(['restart', 'readiness', 'persistence'])('%s失败不摘掉仍被旧入口使用的数据库网络，并回收本次未发布网络', async failure => {
    const f = fixture();
    const databaseNetworks = new Set(['old-network', 'candidate-network']);
    f.entry.services.db = { profileId: 'db', containerName: 'database', containerId: 'd'.repeat(64), hostPort: 3000, status: 'running', networkName: 'old-network' };
    f.options.profiles.push({ id: 'db', name: 'DB' } as BuildProfile);
    (f.options.expectedContainers as Record<string, string>).db = 'd'.repeat(64);
    f.container.isolateReplacementPeer.mockImplementation(async (_entry, service, _network, _check, protectedNetworks = []) => {
      if (service.profileId === 'db' && !protectedNetworks.includes('old-network')) databaseNetworks.delete('old-network');
    });
    if (failure === 'restart') f.container.restartServiceInPlace.mockResolvedValueOnce(false);
    if (failure === 'readiness') f.container.waitForReadiness.mockResolvedValueOnce(false);
    if (failure === 'persistence') f.state.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk'));
    await expect(recoverBranchRuntime(f.options)).rejects.toThrow();
    expect(databaseNetworks.has('old-network')).toBe(true);
    expect(servingRuntime(f.entry.services.api)?.containerName).toBe('old');
    expect(f.container.cleanupUnusedReplacementNetworks).toHaveBeenCalledOnce();
    expect(f.container.cleanupUnusedReplacementNetworks.mock.calls[0][0].replacementNetworks).toHaveLength(1);
  });

  it('成功发布后复用已有归属核验的共同网络，不为同批当前容器反复分配网络', async () => {
    const f = fixture();
    const existing = `${branchAppNetworkName(f.entry.id).slice(0, 27)}-r-${'e'.repeat(32)}`;
    f.entry.replacementNetworks = [existing]; f.entry.services.api.networkName = existing;
    const result = await recoverBranchRuntime(f.options);
    expect(result.network).toBe(existing);
    expect(f.entry.replacementNetworks).toEqual([existing]);
    expect(f.container.cleanupUnusedReplacementNetworks).toHaveBeenCalledOnce();
  });

  it('已有其他空预约网络在发布后交给原归属核验回收，清理失败保留责任', async () => {
    const f = fixture();
    const unused = `${branchAppNetworkName(f.entry.id).slice(0, 27)}-r-${'f'.repeat(32)}`;
    f.entry.replacementNetworks = [unused];
    f.container.cleanupUnusedReplacementNetworks.mockImplementation(async view => {
      expect(view.replacementNetworks).toContain(unused);
      expect(servingRuntime(f.entry.services.api)?.containerName).toBe('current');
      throw new Error('network ownership unknown');
    });
    await expect(recoverBranchRuntime(f.options)).rejects.toThrow('network ownership unknown');
    expect(f.entry.replacementNetworks).toContain(unused);
    expect(servingRuntime(f.entry.services.api)?.containerName).toBe('current');
  });

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
