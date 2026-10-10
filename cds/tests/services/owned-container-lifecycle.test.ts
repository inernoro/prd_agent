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
