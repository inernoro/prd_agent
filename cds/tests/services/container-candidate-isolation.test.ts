import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidateRuntimeIdentity } from '../../src/services/service-candidate.js';
import { computeCdsInstanceId } from '../../src/services/orphan-container-reaper.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BranchEntry, BuildProfile, CdsConfig, ServiceState } from '../../src/types.js';
const sha = 'a'.repeat(40); const imageId = 'sha256:' + 'b'.repeat(64);
const config = { repoRoot: '/repo', worktreeBase: '/wt', masterPort: 9900, workerPort: 5500,
  dockerNetwork: 'shared-test', portStart: 10001, sharedEnv: {}, jwt: { secret: 'test', issuer: 'test' } } as CdsConfig;
const old = { profileId: 'api', containerName: 'cds-branch-api', hostPort: 10001, status: 'running', deployedImage: 'old-image' } as ServiceState;
const entry = (): BranchEntry => ({ id: 'branch', branch: 'test', projectId: 'project', worktreePath: '/repo',
  githubCommitSha: sha, deploymentTargetSha: sha, services: { api: { ...old } }, status: 'running', createdAt: '2026-10-10' });
const profile = (): BuildProfile => ({ id: 'api', projectId: 'project', name: 'API', role: 'api', workDir: '.', containerPort: 8080,
  command: '', prebuiltImage: true, prebuiltCommitPolicy: 'exact', dockerImage: 'registry/app:sha-' + sha });
let shell: MockShellExecutor; let container: ContainerService;
beforeEach(() => {
  vi.stubEnv('CDS_BRANCH_NETWORK_ISOLATION', '1'); shell = new MockShellExecutor(); container = new ContainerService(shell, config);
  shell.addResponsePattern(/docker pull|docker create|docker start|docker network connect|docker rm -f/, () => ({ stdout: 'd'.repeat(64), stderr: '', exitCode: 0 }));
  shell.addResponsePattern(/docker inspect --format='\{\{json \.\}\}'/, () => ({ stdout: '', stderr: 'Error: No such object', exitCode: 1 }));
  shell.addResponsePattern(/docker network inspect --format/, () => ({ stdout: JSON.stringify({ 'cds.managed': 'true', 'cds.type': 'candidate-network', 'cds.instance': computeCdsInstanceId('/repo'), 'cds.project.id': 'project', 'cds.branch.id': 'branch', 'cds.deployment.operation': 'op-test' }), stderr: '', exitCode: 0 }));
  shell.addResponsePattern(/docker version/, () => ({ stdout: 'amd64', stderr: '', exitCode: 0 }));
  shell.addResponsePattern(/docker image inspect/, () => ({ stdout: JSON.stringify({ architecture: 'amd64', os: 'linux', revision: sha, id: imageId }), stderr: '', exitCode: 0 }));
  shell.addResponsePattern(/docker network inspect/, () => ({ stdout: JSON.stringify([{ Containers: { old: { Name: old.containerName, IPv4Address: '1.2.3.4/24' } } }]), stderr: '', exitCode: 0 }));
  shell.addResponsePattern(/docker ps/, () => ({ stdout: old.containerName, stderr: '', exitCode: 0 }));
  // Test the create/connect/start boundary only; readiness and the routing transaction are separate plan items.
  vi.spyOn(container as any, 'waitForContainerAlive').mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('P3-04 candidate runtime boundary', () => {
  it.each(['intent-write', 'created-write', 'cancel-after-created'])('does not create/connect/start beyond an unconfirmed candidate ledger boundary: %s', async failure => {
    const candidate = { profileId: 'api', containerName: candidateRuntimeIdentity('branch', 'api', 'op-test').containerName,
      hostPort: 10002, status: 'idle' } as ServiceState;
    let current = true; const events: string[] = [];
    shell.addResponsePatternFirst(/^docker create /, () => { events.push('create'); return { stdout: 'c'.repeat(64), stderr: '', exitCode: 0 }; });
    await expect(container.runService(entry(), profile(), candidate, undefined, undefined, {
      candidateRunId: 'op-test', assertCurrent: () => { if (!current) throw new Error('new-owner'); },
      onCandidateCreateIntent: async () => { events.push('intent-durable'); if (failure === 'intent-write') throw new Error('disk-unavailable'); },
      onCandidateCreated: async (id: string) => { expect(id).toBe('c'.repeat(64)); events.push('created-durable');
        if (failure === 'created-write') throw new Error('disk-unavailable'); current = false; },
    } as any)).rejects.toThrow(failure === 'cancel-after-created' ? 'new-owner' : 'disk-unavailable');
    expect(events).toEqual(failure === 'intent-write' ? ['intent-durable'] : ['intent-durable', 'create', 'created-durable']);
    expect(shell.commands.some(command => command.startsWith('docker network connect') || command.startsWith('docker start'))).toBe(false);
  });
  it('starts and connects the immutable created ID after both candidate ledger barriers', async () => {
    const candidate = { profileId: 'api', containerName: candidateRuntimeIdentity('branch', 'api', 'op-test').containerName,
      hostPort: 10002, status: 'idle' } as ServiceState;
    const events: string[] = []; const id = 'c'.repeat(64);
    shell.addResponsePatternFirst(/^docker create /, () => { events.push('create'); return { stdout: id, stderr: '', exitCode: 0 }; });
    await container.runService(entry(), profile(), candidate, undefined, undefined, {
      candidateRunId: 'op-test', onCandidateCreateIntent: async () => { events.push('intent-durable'); },
      onCandidateCreated: async (created: string) => { expect(created).toBe(id); events.push('created-durable'); },
    } as any);
    expect(events).toEqual(['intent-durable', 'create', 'created-durable']);
    expect(shell.commands.filter(command => command.startsWith('docker start'))).toEqual(['docker start ' + id]);
    expect(shell.commands.filter(command => command.startsWith('docker network connect')).every(command => command.includes(id))).toBe(true);
    expect(candidate.containerId).toBe(id);
  });

  it('creates in a run-specific network and does not prune the healthy old instance', async () => {
    const candidate = { profileId: 'api', containerName: candidateRuntimeIdentity('branch', 'api', 'op-test').containerName, hostPort: 10002, status: 'idle' } as ServiceState;
    await container.runService(entry(), profile(), candidate, undefined, undefined, { candidateRunId: 'op-test' });
    const created = shell.commands.find(command => command.startsWith('docker create'));
    expect(created).toContain('--name ' + candidate.containerName);
    expect(created).toContain("cds.deployment.operation='op-test'");
    expect(created).not.toContain('--network cds-br-branch ');
    expect(shell.commands.some(command => command === 'docker rm -f ' + old.containerName || command.includes("docker rm -f '" + old.containerName + "'"))).toBe(false);
  });
  it('binds artifact admission to the frozen candidate target rather than an older prepared profile', async () => {
    const candidate = { profileId: 'api', containerName: candidateRuntimeIdentity('branch', 'api', 'op-test').containerName, hostPort: 10002, status: 'idle' } as ServiceState;
    await container.runService(entry(), { ...profile(), preparedCommitSha: 'c'.repeat(40), preparedArtifactId: imageId }, candidate,
      undefined, undefined, { candidateRunId: 'op-test' });
    expect(shell.commands.some(command => command.startsWith('docker pull') && command.includes('sha-' + sha))).toBe(true);
  });
  it('rejects a candidate that reuses the old identity before any Docker operation', async () => {
    await expect(container.runService(entry(), profile(), { ...old }, undefined, undefined, { candidateRunId: 'op-test' })).rejects.toThrow('candidate_identity');
    expect(shell.commands).toEqual([]);
  });
  it('rejects candidate startup if network isolation was disabled', async () => {
    vi.stubEnv('CDS_BRANCH_NETWORK_ISOLATION', '0');
    const candidate = { profileId: 'api', containerName: candidateRuntimeIdentity('branch', 'api', 'op-test').containerName, hostPort: 10002, status: 'idle' } as ServiceState;
    await expect(container.runService(entry(), profile(), candidate, undefined, undefined, { candidateRunId: 'op-test' })).rejects.toThrow('candidate_network_isolation');
    expect(shell.commands).toEqual([]);
  });
  it.each(['foreign', 'promoted', 'running', 'malformed'])('preserves an existing %s container', async kind => {
    const labels = { 'cds.managed': 'true', 'cds.instance': computeCdsInstanceId('/repo'),
      'cds.project.id': 'project', 'cds.branch.id': 'branch', 'cds.profile.id': 'api',
      'cds.deployment.operation': 'op-test', 'cds.deployment.kind': 'candidate' };
    if (kind === 'foreign') labels['cds.deployment.operation'] = 'someone-else';
    if (kind === 'promoted') labels['cds.deployment.kind'] = 'serving';
    shell.addResponsePatternFirst(/docker inspect --format='\{\{json \.\}\}'/, () => ({
      stdout: kind === 'malformed' ? '{}' : JSON.stringify({ Id: 'c'.repeat(64), Config: { Labels: labels }, State: { Running: kind === 'running' } }), stderr: '', exitCode: 0 }));
    const candidate = { profileId: 'api', containerName: candidateRuntimeIdentity('branch', 'api', 'op-test').containerName, hostPort: 10002, status: 'idle' } as ServiceState;
    await expect(container.runService(entry(), profile(), candidate, undefined, undefined, { candidateRunId: 'op-test' })).rejects.toThrow('candidate_container_owner');
    expect(shell.commands.some(command => command.startsWith('docker rm') || command.startsWith('docker create'))).toBe(false);
  });
  it('removes only a verified stopped candidate by immutable ID without force', async () => {
    const id = 'c'.repeat(64);
    shell.addResponsePatternFirst(/docker inspect --format='\{\{json \.\}\}'/, () => ({ stdout: JSON.stringify({ Id: id,
      Config: { Labels: { 'cds.managed': 'true', 'cds.instance': computeCdsInstanceId('/repo'), 'cds.project.id': 'project',
        'cds.branch.id': 'branch', 'cds.profile.id': 'api', 'cds.deployment.operation': 'op-test', 'cds.deployment.kind': 'candidate' } },
      State: { Running: false } }), stderr: '', exitCode: 0 }));
    shell.addResponsePatternFirst(/^docker rm /, () => ({ stdout: id, stderr: '', exitCode: 0 }));
    const candidate = { profileId: 'api', containerName: candidateRuntimeIdentity('branch', 'api', 'op-test').containerName, hostPort: 10002, status: 'idle' } as ServiceState;
    await container.runService(entry(), profile(), candidate, undefined, undefined, { candidateRunId: 'op-test' });
    expect(shell.commands.filter(command => command.startsWith('docker rm'))).toEqual(['docker rm ' + id]);
  });
  it.each([{}, { 'cds.deployment.operation': 'foreign' }])('rejects a foreign candidate network', async labels => {
    shell.addResponsePatternFirst(/docker network inspect --format/, () => ({ stdout: JSON.stringify(labels), stderr: '', exitCode: 0 }));
    const candidate = { profileId: 'api', containerName: candidateRuntimeIdentity('branch', 'api', 'op-test').containerName, hostPort: 10002, status: 'idle' } as ServiceState;
    await expect(container.runService(entry(), profile(), candidate, undefined, undefined, { candidateRunId: 'op-test' })).rejects.toThrow('candidate_network_owner');
    expect(shell.commands.some(command => command.startsWith('docker rm') || command.startsWith('docker create'))).toBe(false);
  });
});
