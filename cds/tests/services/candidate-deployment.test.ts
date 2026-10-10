import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { OwnedContainerLifecycle } from '../../src/services/owned-container-lifecycle.js';
import { CandidateDeploymentService } from '../../src/services/candidate-deployment.js';
import type { BranchEntry, BuildProfile, IShellExecutor } from '../../src/types.js';
const sha = 'a'.repeat(40); const image = 'sha256:' + 'a'.repeat(64);
let dir: string; let state: StateService; let entry: BranchEntry; let runId: string;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-candidate-deployment-'));
  state = new StateService(path.join(dir, 'state.json')); state.load();
  entry = { id: 'branch', projectId: 'project', branch: 'test', worktreePath: '/unused', githubCommitSha: sha, deploymentTargetSha: sha,
    status: 'running', createdAt: '2026-10-11', services: { api: { profileId: 'api', containerName: 'old', hostPort: 10001, status: 'running',
      deployedCommitSha: 'b'.repeat(40), deployedImage: 'sha256:' + 'b'.repeat(64) } } };
  state.addBranch(entry);
  runId = (await new DeploymentRunService(state).begin({ projectId: 'project', branchId: entry.id, trigger: 'manual',
    commitSha: sha, operationId: 'operation', configHash: 'frozen' })).id;
});
afterEach(async () => { await state.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(role: 'api' | 'worker' = 'api') {
  const events: string[] = []; const objects = new Map<string, any>();
  const add = (name: string, port: number, candidate = false) => {
    const id = createHash('sha256').update(name).digest('hex');
    const info = { Id: id, Name: '/' + name, Image: candidate ? image : entry.services.api.deployedImage,
      State: { Running: true }, Config: { Labels: { 'cds.managed': 'true', 'cds.type': 'app', 'cds.instance': 'instance',
        'cds.project.id': 'project', 'cds.branch.id': 'branch', 'cds.profile.id': 'api',
        ...(candidate ? { 'cds.deployment.operation': 'operation', 'cds.deployment.kind': 'candidate' } : {}) } },
      HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: String(port) }] } }, Mounts: [] };
    objects.set(id, info); return info;
  };
  const old = add('old', 10001);
  const shell = { exec: async (command: string) => {
    const identity = command.split(' ').at(-1)!.replaceAll("'", '');
    const info = objects.get(identity) || [...objects.values()].find(object => object.Name === '/' + identity);
    if (command.startsWith('docker inspect')) return info ? { exitCode: 0, stdout: JSON.stringify(info), stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'No such object: ' + identity };
    events.push(command);
    if (!info) return { exitCode: 1, stdout: '', stderr: 'No such container' };
    if (command.startsWith('docker stop')) {
      const saved = new StateService(path.join(dir, 'state.json')); saved.load();
      expect(saved.getDeploymentRun(runId)!.candidate!.stopBeforeStart).toContain('api');
      expect(saved.getDeploymentRun(runId)!.candidate!.serving.api.containerId).toBe(old.Id);
      info.State.Running = false;
    }
    if (command.startsWith('docker start')) info.State.Running = true;
    if (command.startsWith('docker rm')) objects.delete(info.Id);
    return { exitCode: 0, stdout: info.Id, stderr: '' };
  } } as unknown as IShellExecutor;
  const profile = { id: 'api', projectId: 'project', role, name: 'API', containerPort: 8080, workDir: '.', dockerImage: image,
    prebuiltImage: true, prebuiltCommitPolicy: 'exact', preparedCommitSha: sha, preparedArtifactId: image } as BuildProfile;
  let ready = true; let oldReady = true; let createFails = false; let wait: (() => Promise<boolean>) | undefined;
  const containers = { runService: async (graph: BranchEntry, p: BuildProfile, service: any, _output: any, _env: any, context: any) => {
    expect(graph).not.toBe(entry); expect(context.candidateRunId).toBe('operation');
    events.push('create-candidate'); if (createFails) throw new Error('create-unknown');
    add(service.containerName, service.hostPort, true);
    Object.assign(service, { deployedPrebuilt: true, deployedCommitSha: sha, deployedImage: image, deployedMode: 'express' });
  }, waitForStartupSignal: async () => true, waitForReadiness: async (port: number) => port === 10001 ? oldReady : wait ? await wait() : ready };
  const options = { runId, entry, profiles: [profile], allocatePort: () => 10002, assertCurrent: () => {},
    admit: async () => {}, acknowledge: async () => { events.push('ack'); return true; }, customEnv: {} };
  const service = new CandidateDeploymentService(state, containers as any, new OwnedContainerLifecycle(shell, 'instance'));
  return { service, options, old, events, objects, setReady: (value: boolean) => { ready = value; },
    setOldReady: (value: boolean) => { oldReady = value; }, failCreate: () => { createFails = true; }, setWait: (value: () => Promise<boolean>) => { wait = value; } };
}
describe('P3 actual deployment candidate orchestration', () => {
  it('leaves the serving graph untouched until all candidates are ready and consumer ACK is durable', async () => {
    const f = fixture(); let release!: () => void; let entered!: () => void;
    const gate = new Promise<boolean>(resolve => { release = () => resolve(true); });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    f.setWait(async () => { entered(); return gate; });
    const pending = f.service.deploy(f.options);
    try { await reached; expect(entry.services.api.containerName).toBe('old'); expect(f.old.State.Running).toBe(true);
      expect(f.events).toEqual(['create-candidate']);
      const restored = new StateService(path.join(dir, 'state.json')); restored.load();
      expect(restored.getDeploymentRun(runId)!.candidate!.phase).toBe('starting');
      expect(restored.getBranch(entry.id)!.services.api.containerName).toBe('old');
    } finally { release(); }
    await pending;
    expect(f.events[1]).toBe('ack'); expect(f.events[2]).toBe('docker rm -f ' + f.old.Id);
    expect(entry.services.api.containerName).toMatch(/^cds-candidate-/);
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('released');
  });
  it('rejects incomplete artifacts and explicit unsafe worker parallel before any Docker mutation', async () => {
    for (const variant of ['missing-artifact', 'worker-parallel']) {
      const f = fixture(variant === 'worker-parallel' ? 'worker' : 'api');
      if (variant === 'missing-artifact') f.options.profiles[0].preparedArtifactId = undefined;
      else f.options.profiles[0].replacementStrategy = 'parallel';
      await expect(f.service.deploy(f.options)).rejects.toThrow('replacement_');
      expect(f.events).toEqual([]); expect(f.old.State.Running).toBe(true);
    }
  });
  it('keeps the original serving container on readiness failure and cleans only a confirmed owned candidate', async () => {
    const f = fixture(); f.setReady(false);
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_readiness');
    expect(entry.services.api.containerName).toBe('old'); expect(f.old.State.Running).toBe(true);
    expect(f.events.some(event => event === 'docker rm -f ' + f.old.Id)).toBe(false);
  });
  it('records stop intent before stopping a worker and starts the original ID after a confirmed candidate failure', async () => {
    const f = fixture('worker'); f.setReady(false);
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_readiness');
    expect(f.events[0]).toBe('docker stop -t 10 ' + f.old.Id);
    expect(f.events[1]).toBe('create-candidate');
    expect(f.events).toContain('docker start ' + f.old.Id); expect(f.old.State.Running).toBe(true);
    expect(entry.services.api.containerName).toBe('old'); expect(entry.services.api.status).toBe('running');
    expect(state.getDeploymentRun(runId)!.candidate!.stopBeforeStart).toEqual(['api']);
  });
  it('does not restore a single consumer blindly after an unconfirmed Daemon create outcome', async () => {
    const f = fixture('worker'); f.failCreate();
    await expect(f.service.deploy(f.options)).rejects.toThrow('create-unknown');
    expect(f.old.State.Running).toBe(false); expect(f.events).not.toContain('docker start ' + f.old.Id);
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('reconciling');
    expect(state.allocatePort(10002)).not.toBe(10002);
  });
  it('does not create or stop before capacity admits the overlap, and releases a proven unstarted reservation on rejection', async () => {
    const f = fixture('worker');
    f.options.admit = async () => { throw new Error('capacity-denied'); };
    await expect(f.service.deploy(f.options)).rejects.toThrow('capacity-denied');
    expect(f.events).toEqual([]); expect(f.old.State.Running).toBe(true);
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('released');
    expect(state.allocatePort(10002)).toBe(10002);
  });
  it('does not erase a serving fact mutation during readiness', async () => {
    const f = fixture(); f.setWait(async () => { entry.services.api.deployedImage = 'foreign-new-version'; return true; });
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_deploy_drift');
    expect(entry.services.api.deployedImage).toBe('foreign-new-version');
    expect(f.events).toEqual(['create-candidate']); expect(f.old.State.Running).toBe(true);
  });
  it('restores a stopped original worker only after a failed switch restores and acknowledges the old mapping', async () => {
    const f = fixture('worker');
    f.options.acknowledge = async () => { f.events.push('ack'); return entry.services.api.containerName === 'old'; };
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_switch_ack');
    const removed = f.events.findIndex(event => event.startsWith('docker rm -f '));
    const restored = f.events.findIndex(event => event === 'docker start ' + f.old.Id);
    expect(f.events.slice(0, removed)).toContain('ack'); expect(restored).toBeGreaterThan(removed);
    expect(f.old.State.Running).toBe(true); expect(entry.services.api.status).toBe('running');
    expect(entry.services.api.containerName).toBe('old');
  });

  it('records an explicit recovery failure when the restored original instance is alive but not ready', async () => {
    const f = fixture('worker'); f.setReady(false); f.setOldReady(false);
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_readiness');
    expect(f.old.State.Running).toBe(true); expect(entry.services.api.status).toBe('stopped');
    expect(state.getDeploymentRun(runId)!.candidate!.recoveryFailure).toMatchObject({ stage: 'serving-readiness' });
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('reconciling');
  });

});
