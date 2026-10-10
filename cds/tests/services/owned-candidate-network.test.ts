import { describe, expect, it, vi } from 'vitest';
import { OwnedCandidateNetworkLifecycle } from '../../src/services/owned-candidate-network.js';
import type { IShellExecutor } from '../../src/types.js';
const owner = { projectId: 'project', branchId: 'branch', operationId: 'op' };
const id = 'a'.repeat(64); const name = 'cds-candidate-run';
function fixture() {
  const facts: any = { Id: id, Name: name, Driver: 'bridge', Scope: 'local', Internal: false, Attachable: false,
    Ingress: false, EnableIPv6: false, IPAM: { Driver: 'default', Options: { token: 'private-IPAM-token' }, Config: [] },
    Options: { token: 'private-network-token' }, Containers: {}, Labels: { 'cds.managed': 'true', 'cds.type': 'candidate-network',
      'cds.instance': 'instance', 'cds.project.id': 'project', 'cds.branch.id': 'branch', 'cds.deployment.operation': 'op' } };
  let exists = true; const mutations: string[] = [];
  const exec = vi.fn(async (command: string) => {
    if (command.startsWith('docker network inspect')) return exists ? { exitCode: 0, stdout: JSON.stringify(facts), stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'Error: network not found' };
    mutations.push(command); exists = false; return { exitCode: 0, stdout: id, stderr: '' };
  });
  return { facts, exec, mutations, lifecycle: new OwnedCandidateNetworkLifecycle({ exec } as unknown as IShellExecutor, 'instance') };
}
describe('P3 owned candidate network retirement', () => {
  it('captures only opaque network configuration and removes the empty captured ID', async () => {
    const f = fixture(); const ref = await f.lifecycle.capture(owner, name, () => {});
    expect(JSON.stringify(ref)).not.toContain('private-'); expect(ref.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(ref)).toBe(true); expect(Object.isFrozen(ref.owner)).toBe(true);
    await f.lifecycle.remove(ref, () => {});
    expect(f.mutations).toEqual([`docker network rm ${id}`]);
  });
  it.each(['owner', 'protected', 'network-config', 'identity', 'endpoint', 'unknown-endpoints'])('refuses unsafe retirement after capture: %s', async variant => {
    const f = fixture(); const ref = await f.lifecycle.capture(owner, name, () => {});
    if (variant === 'owner') f.facts.Labels['cds.deployment.operation'] = 'new-operation';
    if (variant === 'protected') f.facts.Labels['cds.protected'] = 'true';
    if (variant === 'network-config') f.facts.IPAM.Options.token = 'changed-token';
    if (variant === 'identity') f.facts.Id = 'b'.repeat(64);
    if (variant === 'endpoint') f.facts.Containers['c'.repeat(64)] = { Name: 'serving-worker' };
    if (variant === 'unknown-endpoints') f.facts.Containers = null;
    await expect(f.lifecycle.remove(ref, () => {})).rejects.toThrow(); expect(f.mutations).toEqual([]);
  });
  it('checks the new owner after inspect and before issuing any network mutation', async () => {
    const f = fixture(); const ref = await f.lifecycle.capture(owner, name, () => {}); let revoked = false;
    const original = f.exec.getMockImplementation()!;
    f.exec.mockImplementation(async (cmd: string) => { const result = await original(cmd); revoked = true; return result; });
    await expect(f.lifecycle.remove(ref, () => { if (revoked) throw new Error('superseded'); })).rejects.toThrow('superseded');
    expect(f.mutations).toEqual([]);
  });
  it('does not treat inspection failure as confirmed disappearance', async () => {
    const f = fixture(); const ref = await f.lifecycle.capture(owner, name, () => {});
    f.exec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'Daemon connection refused' });
    await expect(f.lifecycle.remove(ref, () => {})).rejects.toThrow('network_inspect'); expect(f.mutations).toEqual([]);
  });
  it('requires final inspect of the captured ID to prove removal', async () => {
    const f = fixture(); const ref = await f.lifecycle.capture(owner, name, () => {});
    f.exec.mockImplementation(async command => {
      if (command.startsWith('docker network rm')) { f.mutations.push(command); return { exitCode: 0, stdout: id, stderr: '' }; }
      return { exitCode: 0, stdout: JSON.stringify(f.facts), stderr: '' };
    });
    await expect(f.lifecycle.remove(ref, () => {})).rejects.toThrow('network_remove_unconfirmed');
    expect(f.mutations).toEqual([`docker network rm ${id}`]);
  });
});
