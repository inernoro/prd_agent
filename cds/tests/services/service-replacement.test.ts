import { describe, expect, it, vi } from 'vitest';
import type { BranchEntry, ServiceState } from '../../src/types.js';
import type { StateService } from '../../src/services/state.js';
import { ContainerService, resolveEffectiveProfile } from '../../src/services/container.js';
import type { CdsConfig, ExecOptions, IShellExecutor } from '../../src/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertBrowserOnlyStaticConsumers, commitServiceReplacements, prepareServiceReplacement, replacementLaunchEntry, reserveServiceReplacements } from '../../src/services/service-replacement.js';
import { resolveBranchUpstream } from '../../src/services/proxy.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

function fixture() {
  const service: ServiceState = { profileId: 'api', containerName: 'new-api', hostPort: 10002, status: 'starting',
    networkName: 'new-network', servingRuntime: { containerName: 'old-api', containerId: 'a'.repeat(64), hostPort: 10001, networkName: 'old-network' } };
  const entry = { id: 'branch', branch: 'feature', projectId: 'project', services: { api: service } } as BranchEntry;
  let port = 10010;
  const state = { save: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), allocatePort: () => port++,
    getCdsEnvVars: () => ({}), getMirrorEnvVars: () => ({}), getCustomEnvScope: () => ({}),
    getCustomEnvRaw: () => ({}),
    getAllBranches: () => [], getState: () => ({ projects: [] }),
    appendContainerLogArchive: vi.fn((_id, snapshot) => ({ ...snapshot, capturedAt: '2026-11-05T00:00:00Z' })) } as unknown as StateService;
  const container = { cleanupUnusedReplacementNetworks: vi.fn().mockResolvedValue(undefined), removeOwnedRuntime: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue(''), getEnv: vi.fn().mockResolvedValue(''),
    inspectOwnedRuntime: vi.fn().mockImplementation(async (_entry, _id, runtime) =>
      ({ ...runtime, aliasNetworks: runtime.aliasNetworks || [runtime.networkName] })) } as unknown as ContainerService;
  return { entry, service, state, container };
}

describe('就绪切换与保旧回退', () => {
  it.each([{ step: 'stop', state: 'dead' }, { step: 'rm', state: 'dead' },
    { step: 'stop', state: 'changed' }, { step: 'stop', state: 'live' }])('实际shell槽准入后复核旧入口，step=$step state=$state', async ({ step, state }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-admitted-cleanup-'));
    const cid = 'a'.repeat(64), calls = path.join(dir, 'calls');
    fs.writeFileSync(path.join(dir, 'docker'), '#!/bin/sh\nif [ "$1" = inspect ]; then printf "%s\\n" "$UAT_OLD_STATE"; else printf "%s\\n" "$1" >> "$UAT_DOCKER_CALLS"; fi\n', { mode: 0o700 });
    let admitted = false, oldLive = true;
    const shell = { exec: async (command: string, options?: ExecOptions) => {
      if (step === 'rm' && command.includes('docker stop ')) return { stdout: '', stderr: '', exitCode: 0 };
      admitted = true; oldLive = state === 'live'; options?.beforeStart?.();
      const r = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: {
        PATH: dir, UAT_OLD_STATE: `${state === 'changed' ? 'c'.repeat(64) : cid} ${state === 'dead' ? 'false' : 'true'}`, UAT_DOCKER_CALLS: calls,
      } });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
    } } as IShellExecutor;
    const container = new ContainerService(shell, {} as CdsConfig);
    vi.spyOn(container as any, 'captureContainerDiagnostics').mockResolvedValue({ logs: '' });
    const beforeRemove = vi.fn(async () => { expect(oldLive).toBe(true); });
    try {
      const removal = container.remove('b'.repeat(64), { beforeRemove, requiredRunningContainerId: cid });
      if (state === 'live') await expect(removal).resolves.toBeUndefined();
      else await expect(removal).rejects.toThrow('旧入口');
      expect(admitted).toBe(true); expect(beforeRemove).toHaveBeenCalled();
      if (state === 'live') expect(fs.readFileSync(calls, 'utf8')).toBe('stop\nrm\n');
      else expect(fs.existsSync(calls)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('发出创建但没有确认CID时保留未知候选和原失败，不读取未确认日志', async () => {
    const f = fixture(); f.entry.replacementNetwork = 'new-network';
    Object.assign(f.service, { status: 'error', creationIssued: true, errorMessage: 'image run failed before CID' });
    f.service.pendingRuntime = { containerName: 'unknown-candidate', networkName: 'new-network', hostPort: 10002, creationIssued: true };
    vi.mocked(f.container.removeOwnedRuntime).mockRejectedValue(new Error('迟到创建身份未确认，保留回收责任'));
    await expect(commitServiceReplacements({ ...f, profileIds: ['api'] })).resolves.toBeUndefined();
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled(); expect(f.container.getLogs).not.toHaveBeenCalled();
    expect(f.service.errorMessage).toBe('image run failed before CID'); expect(f.service.pendingRuntime?.creationIssued).toBe(true);
    expect(f.state.appendContainerLogArchive).toHaveBeenCalledWith('branch', expect.objectContaining({ logs: '', message: expect.stringContaining('身份') }));
  });

  it('旧入口查询返回空时也不能跳过失效代次围栏', async () => {
    const f = fixture(); f.service.status = 'error'; f.service.creationIssued = true;
    f.service.containerId = 'b'.repeat(64); f.entry.replacementNetwork = 'new-network';
    let current = true;
    vi.mocked(f.container.inspectOwnedRuntime).mockImplementation(async () => { current = false; return null; });
    await expect(commitServiceReplacements({ ...f, profileIds: ['api'],
      assertCurrent: () => { if (!current) throw new Error('superseded generation'); } })).rejects.toThrow('superseded generation');
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
  });

  it('失败诊断归档持久化未确认时不收回候选', async () => {
    const f = fixture(); f.service.status = 'error'; f.service.creationIssued = true;
    f.service.containerId = 'b'.repeat(64); f.entry.replacementNetwork = 'new-network';
    vi.mocked(f.state.flush).mockRejectedValueOnce(new Error('archive persistence failed'));
    await expect(commitServiceReplacements({ ...f, profileIds: ['api'] })).rejects.toThrow('archive persistence failed');
    expect(f.state.appendContainerLogArchive).toHaveBeenCalled();
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    expect(f.service.containerId).toBe('b'.repeat(64));
  });

  it('失败诊断读取期间代次失效不追加归档或收回候选', async () => {
    const f = fixture(); f.service.status = 'error'; f.service.creationIssued = true;
    f.service.containerId = 'b'.repeat(64); f.entry.replacementNetwork = 'new-network';
    let current = true;
    vi.mocked(f.container.getLogs).mockImplementation(async () => { current = false; return 'late old-owner logs'; });
    await expect(commitServiceReplacements({ ...f, profileIds: ['api'],
      assertCurrent: () => { if (!current) throw new Error('superseded generation'); } })).rejects.toThrow('superseded generation');
    expect(f.state.appendContainerLogArchive).not.toHaveBeenCalled();
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
  });

  it('同轮身份和环境提前预约，接口仍指向旧服务；下一轮另分网络', () => {
    const { entry, state, service } = fixture();
    entry.services.web = { ...service, profileId: 'web', containerName: 'old-web', hostPort: 10003,
      servingRuntime: { containerName: 'old-web', hostPort: 10003 } };
    reserveServiceReplacements({ entry, profileIds: ['api', 'web'], state, portStart: 10000, operationId: 'first' });
    const first = entry.replacementNetwork;
    const names = Object.values(entry.services).map(service => service.pendingRuntime!.containerName);
    expect(new Set(names).size).toBe(2);
    const prospective = replacementLaunchEntry(entry);
    expect(prospective.services.api.containerName).toBe(names[0]);
    expect(prospective.services.web.networkName).toBe(first);
    expect(resolveBranchUpstream(entry, 'api')).toBe('http://127.0.0.1:10001');
    reserveServiceReplacements({ entry, profileIds: ['api'], state, portStart: 10000, operationId: 'second' });
    expect(entry.replacementNetwork).not.toBe(first);
    expect(service.retainedRuntimes?.some(runtime => runtime.containerName === names[0])).toBe(true);
  });

  it.each(['starting', 'error'] as const)('候选%s或任一必需服务失败时不切换、不删旧容器', async status => {
    const f = fixture(); f.service.status = status;
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10001');
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    f.service.status = 'running';
    f.entry.services.web = { profileId: 'web', containerName: 'web', hostPort: 10003, status: 'error' };
    await commitServiceReplacements({ ...f, profileIds: ['api', 'web'] });
    expect(f.service.servingRuntime?.containerName).toBe('old-api');
  });

  it('切换关键保存失败时恢复旧入口且不回收，随后重试以精确旧ID回收', async () => {
    const f = fixture(); f.service.status = 'running';
    vi.mocked(f.state.flush).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk failed'));
    await expect(commitServiceReplacements({ ...f, profileIds: ['api'] })).rejects.toThrow('disk failed');
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10001');
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10002');
    expect(f.container.removeOwnedRuntime).toHaveBeenCalledWith(f.entry, 'api', expect.objectContaining({ containerId: 'a'.repeat(64) }), expect.objectContaining({ profileId: 'api' }));
  });

  it('切换保存尚未返回时继续旧入口，确认后才发布新入口', async () => {
    const f = fixture(); f.service.status = 'running';
    let entered!: () => void, release!: () => void;
    const saving = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.state.flush).mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { entered(); await pending; });
    const commit = commitServiceReplacements({ ...f, profileIds: ['api'] });
    await saving;
    expect(f.service.servingRuntime?.containerName).toBe('new-api');
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10001');
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    release(); await commit;
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10002');
  });

  it('保存期间新操作取代时，不改其候选身份；未发布指针回到原确认入口', async () => {
    const f = fixture(); f.service.status = 'running';
    vi.mocked(f.state.flush).mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      f.service.containerName = 'newer-api'; f.service.hostPort = 10005;
    });
    await expect(commitServiceReplacements({ ...f, profileIds: ['api'], assertCurrent: step => {
      if (step === 'after runtime cutover persistence') throw new Error('superseded');
    } })).rejects.toThrow('superseded');
    expect(f.service.containerName).toBe('newer-api');
    expect(f.service.servingRuntime?.containerName).toBe('old-api');
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
  });

  it('未替换Web仍依赖旧API时保留旧API，Web随后迁移才回收历史API', async () => {
    const f = fixture(); f.service.status = 'running';
    f.entry.services.web = { profileId: 'web', containerName: 'old-web', hostPort: 10003, status: 'running', networkName: 'old-network' };
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    f.entry.services.web = { profileId: 'web', containerName: 'new-web', hostPort: 10004, status: 'running', networkName: 'new-network',
      servingRuntime: { containerName: 'old-web', hostPort: 10003, containerId: 'b'.repeat(64), networkName: 'old-network' } };
    await commitServiceReplacements({ ...f, profileIds: ['web'] });
    expect(f.container.removeOwnedRuntime).toHaveBeenCalledTimes(2);
    expect(f.service.retainedRuntimes).toEqual([]);
  });

  it('当前消费者已连通新版本时，共享服务的历史网络不再锁住多代旧实例', async () => {
    const f = fixture(); f.service.status = 'running';
    f.service.retainedRuntimes = [1, 2, 3].map(n => ({ containerName: `retained-${n}`, containerId: String(n).repeat(64),
      hostPort: 11000 + n, networkName: `generation-${n}`, aliasNetworks: [`generation-${n}`, 'old-network'] }));
    f.entry.services.redis = { profileId: 'redis', containerName: 'redis', status: 'running', hostPort: 12000,
      networkName: 'old-network', connectedNetworks: ['new-network', 'generation-1', 'generation-2', 'generation-3'] };
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(f.container.removeOwnedRuntime).toHaveBeenCalledTimes(4);
    expect(f.service.retainedRuntimes).toEqual([]);
    expect(f.entry.services.redis.containerName).toBe('redis');
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10002');
  });

  it('新版本没有实际服务别名时不凭历史拓扑删除旧资源', async () => {
    const f = fixture(); f.service.status = 'running';
    f.service.aliasNetworks = ['old-network', 'new-network'];
    f.entry.services.web = { profileId: 'web', containerName: 'web', status: 'running', hostPort: 12000, networkName: 'old-network' };
    vi.mocked(f.container.inspectOwnedRuntime).mockImplementation(async (_entry, _id, runtime) =>
      ({ ...runtime, aliasNetworks: [runtime.networkName!] }));
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    expect(f.service.retainedRuntimes?.[0].containerName).toBe('old-api');
  });

  it('当前版本死亡或任一当前消费者状态未知时保留旧实例', async () => {
    const f = fixture(); f.service.status = 'running';
    f.entry.services.web = { profileId: 'web', containerName: 'web', status: 'running', hostPort: 12000, networkName: 'new-network' };
    vi.mocked(f.container.inspectOwnedRuntime).mockImplementation(async (_entry, id, runtime) => id === 'web'
      ? null : ({ ...runtime, aliasNetworks: [runtime.networkName!] }));
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    vi.mocked(f.container.inspectOwnedRuntime).mockResolvedValue(null);
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
  });

  it('保留列表混入当前或待发布CID时拒绝回收这些身份', async () => {
    const f = fixture(); f.service.status = 'running'; f.service.containerId = 'b'.repeat(64);
    f.service.pendingRuntime = { containerName: 'pending', containerId: 'c'.repeat(64), hostPort: 13000, networkName: 'pending-network' };
    f.service.retainedRuntimes = [{ containerName: 'stale-name', containerId: 'b'.repeat(64), hostPort: 10002, networkName: 'new-network' },
      { ...f.service.pendingRuntime }];
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(vi.mocked(f.container.removeOwnedRuntime).mock.calls.map(call => call[2].containerId)).toEqual(['a'.repeat(64)]);
    expect(f.service.retainedRuntimes).toHaveLength(2);
  });

  it('Docker观测期间当前服务变化时终止回收', async () => {
    const f = fixture(); f.service.status = 'running';
    vi.mocked(f.container.inspectOwnedRuntime).mockImplementationOnce(async (_entry, _id, runtime) => {
      f.service.containerName = 'newer-api'; return { ...runtime, aliasNetworks: ['new-network'] };
    });
    await expect(commitServiceReplacements({ ...f, profileIds: ['api'] })).rejects.toThrow('身份已变化');
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
  });

  it('历史记录缺CID时仍保护Docker确认的当前CID，逐项回收前重验当前存活', async () => {
    const f = fixture(); f.service.status = 'running';
    f.service.retainedRuntimes = [{ containerName: 'misnamed-current', containerId: 'b'.repeat(64), hostPort: 10002, networkName: 'new-network' }];
    vi.mocked(f.container.inspectOwnedRuntime).mockImplementation(async (_entry, _id, runtime) =>
      ({ ...runtime, containerId: runtime.containerName === 'new-api' ? 'b'.repeat(64) : runtime.containerId, aliasNetworks: [runtime.networkName!] }));
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(vi.mocked(f.container.removeOwnedRuntime).mock.calls.map(call => call[2].containerId)).toEqual(['a'.repeat(64)]);
    vi.mocked(f.container.removeOwnedRuntime).mockClear();
    vi.mocked(f.container.inspectOwnedRuntime).mockResolvedValueOnce({ ...f.service, containerId: 'b'.repeat(64), aliasNetworks: ['new-network'] })
      .mockResolvedValueOnce(null);
    f.service.retainedRuntimes = [{ containerName: 'other-old', containerId: 'c'.repeat(64), hostPort: 10005, networkName: 'other-network' }];
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    expect(f.service.retainedRuntimes).toHaveLength(1);
  });
  it('整体失败后收回已就绪但未发布的候选，旧入口及失败结果保持', async () => {
    const f = fixture(); f.entry.replacementNetwork = 'new-network';
    Object.assign(f.service, { status: 'running', containerId: 'b'.repeat(64), creationIssued: true });
    f.entry.services.web = { profileId: 'web', containerName: 'failed-web', containerId: 'c'.repeat(64), creationIssued: true,
      networkName: 'new-network', hostPort: 10003, status: 'error', errorMessage: 'readiness failed',
      servingRuntime: { containerName: 'old-web', containerId: 'd'.repeat(64), hostPort: 10004, networkName: 'old-network' } };
    f.container.inspectOwnedRuntime = vi.fn().mockImplementation(async (_entry, _id, runtime) => runtime);
    await commitServiceReplacements({ ...f, profileIds: ['api', 'web'] });
    expect(vi.mocked(f.container.removeOwnedRuntime).mock.calls.map(call => call[2].containerId)).toEqual(['b'.repeat(64), 'c'.repeat(64)]);
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10001');
    expect(resolveBranchUpstream(f.entry, 'web')).toBe('http://127.0.0.1:10004');
    expect(f.service.containerName).toBe('old-api'); expect(f.entry.services.web.status).toBe('error');
    expect(f.entry.services.web.errorMessage).toBe('readiness failed');
  });

  it('旧入口死亡或已发布角色消费候选时保留责任，不误回收唯一可用资源', async () => {
    const f = fixture(); f.entry.replacementNetwork = 'new-network';
    Object.assign(f.service, { status: 'error', containerId: 'b'.repeat(64), creationIssued: true });
    f.container.inspectOwnedRuntime = vi.fn().mockResolvedValue(null);
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    vi.mocked(f.container.inspectOwnedRuntime).mockImplementation(async (_entry, _id, runtime) => runtime);
    f.entry.services.web = { profileId: 'web', containerName: 'published-web', hostPort: 10004, networkName: 'new-network', status: 'running' };
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled(); expect(f.service.containerId).toBe('b'.repeat(64));
  });

  it('候选回收未确认时不移除身份或清除容量责任', async () => {
    const f = fixture(); f.entry.replacementNetwork = 'new-network';
    Object.assign(f.service, { status: 'error', containerId: 'b'.repeat(64), creationIssued: true });
    f.container.inspectOwnedRuntime = vi.fn().mockImplementation(async (_entry, _id, runtime) => runtime);
    vi.mocked(f.container.removeOwnedRuntime).mockRejectedValueOnce(new Error('removal unconfirmed'));
    await expect(commitServiceReplacements({ ...f, profileIds: ['api'] })).rejects.toThrow('removal unconfirmed');
    expect(f.service.containerId).toBe('b'.repeat(64)); expect(f.service.servingRuntime?.containerId).toBe('a'.repeat(64));
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10001');
  });

  it('候选名称不同但携带旧入口实际CID时绝不删除旧资源', async () => {
    const f = fixture(); f.entry.replacementNetwork = 'new-network';
    Object.assign(f.service, { status: 'error', creationIssued: true, containerId: f.service.servingRuntime!.containerId });
    f.container.inspectOwnedRuntime = vi.fn().mockImplementation(async (_entry, _id, runtime) => runtime);
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10001');
  });

});

describe('静态预览版本切换', () => {
  it('静态候选只预约端口，不创建替换网络，也不继承旧容器身份', () => {
    const f = fixture();
    reserveServiceReplacements({ ...f, profileIds: ['api'], staticProfileIds: ['api'], portStart: 10000, operationId: 'static-operation' });
    expect(f.entry.replacementNetwork).toBeUndefined();
    expect(f.service.pendingRuntime).toMatchObject({ runtimeKind: 'static', hostPort: 10010 });
    expect(f.service.pendingRuntime?.containerId).toBeUndefined();
    expect(replacementLaunchEntry(f.entry).services.api.runtimeKind).toBe('static');
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10001');
  });

  it('旧静态监听器在新版持久化后回收；当前和候选身份始终保护', async () => {
    const f = fixture(); f.service.status = 'running'; f.service.runtimeKind = 'static';
    const old = { ...f.service.servingRuntime!, networkName: undefined, staticWeb: { id: 'static:old' } };
    f.service.servingRuntime = old as ServiceState;
    f.service.retainedRuntimes = [{ ...f.service, staticWeb: { id: 'static:current' } } as ServiceState];
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(f.container.removeOwnedRuntime).toHaveBeenCalledTimes(1);
    expect(f.container.removeOwnedRuntime).toHaveBeenCalledWith(f.entry, 'api', expect.objectContaining({ containerName: 'old-api' }), expect.any(Object));
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10002');
  });
});

describe('仅浏览器前端容器退役合同', () => {
  it('读取实际环境期间服务身份变化，旧回执不能删除旧前端或覆盖新消费者', async () => {
    const f = browserFixture();
    vi.mocked(f.container.getEnv).mockImplementation(async () => {
      f.entry.services.backend.containerId = 'c'.repeat(64);
      return 'TARGET=https://external.example/path\n';
    });
    await expect(commitServiceReplacements({ ...f, profileIds: ['api'] })).rejects.toThrow('当前服务身份已变化');
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    expect(f.entry.services.backend.containerId).toBe('c'.repeat(64));
    expect(f.service.retainedRuntimes?.some(runtime => runtime.containerId === 'a'.repeat(64))).toBe(true);
  });
  it.each(['internal-alias', 'container-name', 'unavailable', 'unconfirmed', 'external', 'credentialed', 'uppercase', 'multiple-urls', 'multiple-external', 'multiple-external-ports', 'uppercase-container', 'uppercase-profile', 'credentialed-comma'])('配置已改外部地址，实际运行消费者=%s 时只凭真实证据退役', async kind => {
    const f = browserFixture(), shell = new MockShellExecutor(), profileId = kind === 'uppercase-profile' ? 'API' : 'api';
    if (profileId !== 'api') { delete f.entry.services.api; f.entry.services[profileId] = f.service; f.service.profileId = profileId; }
    if (kind === 'uppercase-container') f.service.servingRuntime!.containerName = 'OLD-API';
    Object.assign(f.state, { getEffectiveProfilesForBranch: () => [{ id: profileId }, { id: 'backend', env: { TARGET: 'https://external.example/path' } }] });
    const target = { 'internal-alias': 'http://api:80/path', 'container-name': 'http://old-api:80/path',
      credentialed: 'http://fixture-user:fixture-pass@api:80/path', uppercase: 'http://API:80/path',
      'multiple-urls': 'http://external.example,http://api:80/path', 'multiple-external': 'http://external.example,http://other.example',
      'multiple-external-ports': 'https://external.example:443,http://other.example:80',
      'uppercase-container': 'http://old-api:80/path', 'uppercase-profile': 'http://api:80/path', 'credentialed-comma': 'http://fixture,user:pass@api:80/path' }[kind] || 'https://external.example/path';
    shell.addResponsePattern(/docker inspect/, () => kind === 'unavailable'
      ? { stdout: '', stderr: 'environment unavailable', exitCode: 1 }
      : { stdout: `TARGET=${target}\n`, stderr: '', exitCode: 0 });
    const native = new ContainerService(shell, {} as CdsConfig);
    f.container.getEnv = native.getEnv.bind(native);
    if (kind === 'unconfirmed') vi.mocked(f.container.inspectOwnedRuntime).mockImplementation(async (_entry, id, runtime) => id === 'backend' ? null : { ...runtime, aliasNetworks: runtime.aliasNetworks || [runtime.networkName!] });
    await expect(commitServiceReplacements({ ...f, profileIds: [profileId] })).resolves.toBeUndefined();
    const externalOnly = kind === 'external' || kind.startsWith('multiple-external');
    expect(f.container.removeOwnedRuntime).toHaveBeenCalledTimes(externalOnly ? 1 : 0);
    expect(f.service.retainedRuntimes?.some(runtime => runtime.containerId === 'a'.repeat(64))).toBe(!externalOnly);
    expect(f.entry.services.backend.containerId).toBe('b'.repeat(64));
    expect(shell.commands).toHaveLength(kind === 'unconfirmed' ? 0 : 1);
    for (const command of shell.commands) { expect(command).toContain('docker inspect ' + 'b'.repeat(64)); expect(command).not.toContain('unchanged-backend'); }
  });
  it.each(['project', 'legacy-project', 'branch', 'mode', 'external', 'legacy-external', 'list-external'])('按实际运行环境解析 %s 消费者，保留外部地址控制', async layer => {
    const f = browserFixture(), internal = 'http://api:80/path', external = layer === 'list-external' ? 'https://external.example:443,http://other.example:80' : 'https://external.example/path';
    const externalOnly = layer.endsWith('external');
    const projectEnv = { FRONTEND_URL: layer === 'branch' || externalOnly ? external : internal };
    const branchEnv = layer === 'branch' ? { FRONTEND_URL: internal } : {};
    const peer = { id: 'backend', dockerImage: 'example/backend:1', env: { TARGET: '${FRONTEND_URL}' },
      ...(layer === 'mode' ? { env: { TARGET: external }, activeDeployMode: 'consume', deployModes: { consume: { env: { TARGET: '${FRONTEND_URL}' } } } } : {}) };
    Object.assign(f.state, { getCustomEnvScope: (scope: string) => scope === f.entry.id ? branchEnv : layer.startsWith('legacy-') ? {} : projectEnv,
      getCustomEnvRaw: () => ({ project: projectEnv }),
      getEffectiveProfilesForBranch: () => [{ id: 'api' }, peer] });
    const runtime = (new ContainerService({} as never, { jwt: { issuer: 'fixture' } } as CdsConfig) as any)
      .resolveProfileRuntimeEnv(f.entry, resolveEffectiveProfile(peer as never, f.entry), { ...projectEnv, ...branchEnv });
    expect(runtime.TARGET).toBe(externalOnly ? external : internal);
    if (externalOnly) await expect(commitServiceReplacements({ ...f, profileIds: ['api'] })).resolves.toBeUndefined();
    else await expect(commitServiceReplacements({ ...f, profileIds: ['api'] })).rejects.toThrow('仍声明依赖');
    expect(f.container.removeOwnedRuntime).toHaveBeenCalledTimes(externalOnly ? 1 : 0);
    expect(f.entry.services.backend.containerId).toBe('b'.repeat(64));
  });
  it.each([true, false])('首次实际准备也核对容器消费者=%s，校验在任何容器操作之前', async referenced => {
    const f = fixture(); f.service.servingRuntime = undefined; f.service.pendingRuntime = undefined;
    Object.assign(f.state, { getProject: () => ({ id: 'project', slug: 'project' }), getEffectiveProfilesForBranch: () => [
      { id: 'api' }, { id: 'backend', calls: referenced ? ['api'] : [] },
    ] });
    const prepare = prepareServiceReplacement({ ...f, profile: { id: 'api', staticWeb: { browserOnly: true } } as never, portStart: 10010 });
    if (referenced) await expect(prepare).rejects.toThrow('仍声明依赖');
    else await expect(prepare).resolves.toBe(f.service);
    expect(f.container.inspectOwnedRuntime).not.toHaveBeenCalled();
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
  });
  function browserFixture() {
    const f = fixture(); f.service.status = 'running'; f.service.containerId = 'static:new';
    f.service.staticWeb = { id: 'static:new', browserOnly: true } as NonNullable<ServiceState['staticWeb']>;
    f.service.networkName = undefined; f.service.aliasNetworks = [];
    f.entry.services.backend = { profileId: 'backend', containerName: 'unchanged-backend', hostPort: 10003, status: 'running', networkName: 'old-network', containerId: 'b'.repeat(64) };
    Object.assign(f.state, { getProject: () => ({ id: 'project', slug: 'project' }), getEffectiveProfilesForBranch: () => [{ id: 'api' }, { id: 'backend', env: {} }] });
    return f;
  }
  it('明确声明无容器消费者后，只退役旧前端，后端身份和网络保持', async () => {
    const f = browserFixture();
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(f.container.removeOwnedRuntime).toHaveBeenCalledTimes(1);
    expect(f.container.removeOwnedRuntime).toHaveBeenCalledWith(f.entry, 'api', expect.objectContaining({ containerId: 'a'.repeat(64) }), expect.any(Object));
    expect(f.entry.services.backend.containerId).toBe('b'.repeat(64));
    expect(f.entry.services.backend.networkName).toBe('old-network');
  });
  it('没有明确合同仍保留可能被容器消费者使用的旧前端', async () => {
    const f = browserFixture(); f.service.staticWeb!.browserOnly = false;
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
  });
  it.each(['calls', 'dependsOn', 'url'])('发现 %s 反向依赖则拒绝，不会退役旧前端', async kind => {
    const f = browserFixture();
    Object.assign(f.state, { getEffectiveProfilesForBranch: () => [{ id: 'api' }, { id: 'backend',
      ...(kind === 'url' ? { env: { TARGET: 'http://api:80/path' } } : { [kind]: ['api'] }) }] });
    expect(() => assertBrowserOnlyStaticConsumers(f.entry, 'api', f.state)).toThrow('仍声明依赖');
    await expect(commitServiceReplacements({ ...f, profileIds: ['api'] })).rejects.toThrow('仍声明依赖');
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
  });
});
