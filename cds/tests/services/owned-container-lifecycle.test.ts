import { describe, expect, it, vi } from 'vitest';
import { OwnedContainerLifecycle } from '../../src/services/owned-container-lifecycle.js';
import type { IShellExecutor, ServiceState } from '../../src/types.js';

const id = 'a'.repeat(64); const image = 'sha256:' + 'b'.repeat(64);
const service: ServiceState = { profileId: 'api', containerName: 'old', hostPort: 10001, status: 'running' };
const info = () => ({ Id: id, Name: '/old', Image: image, State: { Running: true },
  Config: { Labels: { 'cds.managed': 'true', 'cds.type': 'app', 'cds.instance': 'instance',
    'cds.project.id': 'project', 'cds.branch.id': 'branch', 'cds.profile.id': 'api' } },
  HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '10001' }] } },
  Mounts: [{ Type: 'volume', Source: '/var/lib/docker/volumes/app', Destination: '/data', RW: true, Mode: '', Propagation: '' }] });
const ok = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' });
function fixture() {
  let current = info(); let exists = true; const mutations: string[] = [];
  const exec = vi.fn(async (command: string) => {
    if (command.startsWith('docker inspect')) return exists ? ok(current) : { exitCode: 1, stdout: '', stderr: 'No such object: ' + id };
    mutations.push(command);
    if (command.startsWith('docker stop')) current.State.Running = false;
    if (command.startsWith('docker start')) current.State.Running = true;
    if (command.startsWith('docker rm')) exists = false;
    return { exitCode: 0, stdout: id, stderr: '' };
  });
  const lifecycle = new OwnedContainerLifecycle({ exec } as unknown as IShellExecutor, 'instance');
  return { lifecycle, current, exec, mutations };
}
const owner = { projectId: 'project', branchId: 'branch' };
describe('P3 immutable owned container lifecycle', () => {
  it.each([false, null])('keeps the same identity when Docker materializes the default OOM setting as %s', async initial => {
    const f = fixture();
    (f.current.HostConfig as any).OomKillDisable = initial;
    const ref = await f.lifecycle.capture(owner, service, () => {});
    (f.current.HostConfig as any).OomKillDisable = initial === false ? null : false;
    const after = await f.lifecycle.capture(owner, service, () => {});
    expect(after.fingerprint).toBe(ref.fingerprint);
    await expect(f.lifecycle.stop(ref, () => {})).resolves.toBeUndefined();
    expect(f.mutations).toEqual([`docker stop -t 10 ${id}`]);
  });

  it('still rejects a changed OOM policy', async () => {
    const f = fixture();
    (f.current.HostConfig as any).OomKillDisable = false;
    const ref = await f.lifecycle.capture(owner, service, () => {});
    (f.current.HostConfig as any).OomKillDisable = true;
    await expect(f.lifecycle.stop(ref, () => {})).rejects.toThrow('container_drift');
    expect(f.mutations).toEqual([]);
  });

  it.each(['environment', 'command', 'resource-limit', 'network-mode'])('detects complete runtime configuration drift without storing its plaintext: %s', async variant => {
    const f = fixture(); Object.assign(f.current.Config, { Env: ['TOKEN=private-env-value'], Cmd: ['run', 'old'] });
    Object.assign(f.current.HostConfig, { Memory: 1024, NetworkMode: 'original-network' });
    const ref = await f.lifecycle.capture(owner, service, () => {});
    expect(ref.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ref.fingerprint).not.toContain('private-env-value');
    if (variant === 'environment') (f.current.Config as any).Env = ['TOKEN=new-secret'];
    if (variant === 'command') (f.current.Config as any).Cmd = ['run', 'new'];
    if (variant === 'resource-limit') (f.current.HostConfig as any).Memory = 2048;
    if (variant === 'network-mode') (f.current.HostConfig as any).NetworkMode = 'other-network';
    await expect(f.lifecycle.start(ref, () => {})).rejects.toThrow('container_drift');
    expect(f.mutations).toEqual([]);
  });

  it('keeps runtime comparison proof opaque even when Docker mount metadata contains credentials', async () => {
    const f = fixture(); (f.current.Mounts[0] as any).DriverOpts = { password: 'mount-private-token' };
    const captured = await f.lifecycle.capture(owner, service, () => {});
    expect(captured.fingerprint).not.toContain('mount-private-token');
    expect(captured.fingerprint).not.toContain('/var/lib/docker/volumes/app');
    (f.current.Mounts[0] as any).DriverOpts.password = 'changed-private-token';
    await expect(f.lifecycle.start(captured, () => {})).rejects.toThrow('container_drift');
    expect(f.mutations).toEqual([]);
  });

  it('records lifecycle intent after inspected ownership and fences again before the immutable-ID command', async () => {
    const f = fixture(); let superseded = false;
    const hook = vi.fn((reference, action) => {
      expect(f.exec.mock.calls.at(-1)![0]).toContain('docker inspect');
      expect(reference.owner).toEqual({ ...owner, profileId: 'api', operationId: 'op' });
      expect(action).toBe('stop'); superseded = true;
    });
    const lifecycle = new OwnedContainerLifecycle({ exec: f.exec } as unknown as IShellExecutor, 'instance', hook);
    const ref = await lifecycle.capture({ ...owner, operationId: 'op' }, service, () => {});
    expect(Object.isFrozen(ref.owner)).toBe(true);
    await expect(lifecycle.stop(ref, () => { if (superseded) throw new Error('new-owner'); })).rejects.toThrow('new-owner');
    expect(hook).toHaveBeenCalledOnce(); expect(f.mutations).toEqual([]);
  });

  it.each(['missing', 'unknown-type', 'mode-conflict', 'propagation-drift'])('fails closed on unknown or changed mounts: %s', async variant => {
    const f = fixture();
    if (variant === 'propagation-drift') {
      const captured = await f.lifecycle.capture(owner, service, () => {});
      f.current.Mounts[0].Propagation = 'shared';
      await expect(f.lifecycle.remove(captured, () => {})).rejects.toThrow('container_drift');
    } else {
      if (variant === 'missing') delete (f.current as any).Mounts;
      if (variant === 'unknown-type') f.current.Mounts[0].Type = 'future-type';
      if (variant === 'mode-conflict') { f.current.Mounts[0].RW = false; f.current.Mounts[0].Mode = 'rw'; }
      await expect(f.lifecycle.capture(owner, service, () => {})).rejects.toThrow('container_inspect');
    }
    expect(f.mutations).toEqual([]);
  });
  it('refuses a protected app even if the normal ownership labels match', async () => {
    const f = fixture(); (f.current.Config.Labels as Record<string, string>)['cds.protected'] = 'true';
    await expect(f.lifecycle.capture(owner, service, () => {})).rejects.toThrow('container_owner');
    expect(f.mutations).toEqual([]);
  });
  it('captures actual immutable ID and stops/restores the same configuration before retiring it', async () => {
    const f = fixture(); const captured = await f.lifecycle.capture(owner, service, () => {});
    expect(captured.id).toBe(id); expect(captured.image).toBe(image); expect(captured.writableMounts).toEqual(['/data']);
    await f.lifecycle.stop(captured, () => {}); expect(f.current.State.Running).toBe(false);
    await f.lifecycle.start(captured, () => {}); expect(f.current.State.Running).toBe(true);
    await f.lifecycle.remove(captured, () => {});
    expect(f.mutations).toEqual([`docker stop -t 10 ${id}`, `docker start ${id}`, `docker rm -f ${id}`]);
    expect(f.exec.mock.calls.filter(([command]) => command.startsWith('docker inspect')).every(([command]) =>
      command.includes("'old'") || command.endsWith("'" + id + "'"))).toBe(true);
  });
  it.each(['cds.managed', 'cds.type', 'cds.instance', 'cds.project.id', 'cds.branch.id', 'cds.profile.id'])('refuses a foreign %s owner before any mutation', async label => {
    const f = fixture(); (f.current.Config.Labels as Record<string, string>)[label] = 'foreign';
    await expect(f.lifecycle.capture(owner, service, () => {})).rejects.toThrow('container_owner');
    expect(f.mutations).toEqual([]);
  });
  it('fences after awaited inspect before stopping or deleting the inspected ID', async () => {
    for (const method of ['stop', 'remove'] as const) {
      const f = fixture(); const captured = await f.lifecycle.capture(owner, service, () => {});
      let checks = 0;
      await expect(f.lifecycle[method](captured, () => { if (++checks === 2) throw new Error('superseded'); })).rejects.toThrow('superseded');
      expect(f.mutations).toEqual([]);
    }
  });
  it.each(['id', 'image', 'name', 'port', 'generation'])('does not mutate a changed captured identity: %s', async drift => {
    const f = fixture(); const captured = await f.lifecycle.capture(owner, service, () => {});
    if (drift === 'id') f.current.Id = 'c'.repeat(64);
    if (drift === 'image') f.current.Image = 'sha256:' + 'c'.repeat(64);
    if (drift === 'name') f.current.Name = '/new-owner';
    if (drift === 'port') f.current.HostConfig.PortBindings['8080/tcp'][0].HostPort = '10002';
    if (drift === 'generation') (f.current.Config.Labels as Record<string, string>)['cds.deployment.operation'] = 'new';
    await expect(f.lifecycle.remove(captured, () => {})).rejects.toThrow('container_drift');
    expect(f.mutations).toEqual([]);
  });
  it('requires the actual candidate operation and kind, and rejects missing or malformed inspect', async () => {
    const f = fixture();
    await expect(f.lifecycle.capture({ ...owner, candidateOperationId: 'operation' }, service, () => {})).rejects.toThrow('container_owner');
    f.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' });
    await expect(f.lifecycle.capture(owner, service, () => {})).rejects.toThrow('container_inspect');
    expect(f.mutations).toEqual([]);
  });
  it('does not claim removal when the Daemon still reports the inspected ID', async () => {
    const f = fixture(); const captured = await f.lifecycle.capture(owner, service, () => {});
    f.exec.mockImplementation(async command => command.startsWith('docker inspect') ? ok(f.current) : { exitCode: 0, stdout: id, stderr: '' });
    await expect(f.lifecycle.remove(captured, () => {})).rejects.toThrow('container_remove_unconfirmed');
  });
  it('propagates Daemon failure without trying another container name or ID', async () => {
    const f = fixture(); const captured = await f.lifecycle.capture(owner, service, () => {});
    f.exec.mockImplementation(async command => command.startsWith('docker inspect') ? ok(f.current) : { exitCode: 1, stdout: '', stderr: 'daemon down' });
    await expect(f.lifecycle.remove(captured, () => {})).rejects.toThrow('container_remove');
    expect(f.exec.mock.calls.filter(([command]) => command.startsWith('docker rm'))).toHaveLength(1);
  });
});
