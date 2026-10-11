import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcceptanceResourceRunsRouter } from '../../src/routes/acceptance-resource-runs.js';
import { StateService } from '../../src/services/state.js';
import { AcceptanceResourceRunService } from '../../src/services/acceptance-resource-run.js';
import { OwnedContainerLifecycle } from '../../src/services/owned-container-lifecycle.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { acceptanceReleaseOperationAdmission } from '../../src/services/acceptance-release-admission.js';
import type { IShellExecutor } from '../../src/types.js';

// Real own HTTP/State/JSON plus a controlled CLI; this is not a real Daemon qualification.
describe('P5-05 actual release HTTP orchestration', () => {
  const id = 'b'.repeat(64), sha = 'a'.repeat(40), name = 'owned-bootstrap';
  const scope = { projectId: 'p1', branchId: 'b1', targetSha: sha, isolationRunId: 'owned_run', profileId: 'owned-init' };
  let dir: string, state: StateService, kernel: AcceptanceResourceRunService, server: http.Server;
  let owner: Awaited<ReturnType<AcceptanceResourceRunService['begin']>>;
  let coordinator: BranchOperationCoordinator, commands: string[], facts: any, exists: boolean;
  let remote: boolean, binding: boolean, hook: ((command: string) => Promise<void>) | undefined;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-http-'));
    state = new StateService(path.join(dir, 'state.json')); state.load();
    state.addProject({ id: 'p1', slug: 'p1', name: 'own' } as any);
    state.addBranch({ id: 'b1', projectId: 'p1', branch: 'own/release', createdAt: '2026-10-10T00:00:00Z', worktreePath: dir, status: 'idle', services: {} });
    kernel = new AcceptanceResourceRunService(state); owner = await kernel.begin(scope);
    const branch = state.getBranch('b1')!;
    branch.extraProfiles = [{ id: scope.profileId, projectId: 'p1', env: { IMP_HEALTH_RUN_ID: scope.isolationRunId, IMP_TARGET_SHA: sha } }, { id: 'other', projectId: 'p1' }] as any;
    branch.profileOverrides = { [scope.profileId]: { env: { PRIVATE: 'private-value' } }, other: { env: { KEEP: 'yes' } } };
    branch.services[scope.profileId] = { profileId: scope.profileId, containerId: id, containerName: name, hostPort: 10000, status: 'running', deployedCommitSha: sha };
    branch.services.other = { profileId: 'other', containerName: 'other', hostPort: 10001, status: 'running' };
    state.addDeploymentRun({ id: 'dr_create', projectId: 'p1', branchId: 'b1', commitSha: sha, status: 'running', startedAt: new Date(Date.parse(owner.run.startedAt) + 1000).toISOString(), seq: 1, events: [] } as any);
    await kernel.register(owner.run.id, owner.ownerToken);
    const report = await state.createAcceptanceReportAsync({ projectId: 'p1', branchId: 'b1', commitSha: sha, acceptanceRunId: owner.run.id, verdict: 'fail', title: 'own', format: 'md', content: 'own report body' });
    await kernel.finish(owner.run.id, owner.ownerToken, report.id);
    facts = { Id: id, Name: '/' + name, Image: 'sha256:' + 'c'.repeat(64), State: { Running: true }, Config: { Labels: {
      'cds.managed': 'true', 'cds.type': 'app', 'cds.instance': 'own-instance', 'cds.project.id': 'p1', 'cds.branch.id': 'b1', 'cds.profile.id': scope.profileId,
    } }, HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: '10000' }] } }, Mounts: [] };
    commands = []; exists = true; remote = false; binding = true; hook = undefined;
    const shell = { exec: async (command: string) => {
      commands.push(command); await hook?.(command);
      if (command.startsWith('docker inspect')) {
        const identity = command.endsWith("'" + id + "'") ? id : name;
        return exists && (identity === name || facts.Id === identity) ? { exitCode: 0, stdout: JSON.stringify(facts), stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'Error: No such object: ' + identity };
      }
      if (command === 'docker stop -t 10 ' + id) facts.State.Running = false;
      else if (command === 'docker rm ' + id) exists = false;
      else throw new Error('unexpected command');
      return { exitCode: 0, stdout: id, stderr: '' };
    } } as unknown as IShellExecutor;
    coordinator = new BranchOperationCoordinator(undefined, undefined, undefined, request => acceptanceReleaseOperationAdmission(state, request));
    const app = express();
    app.use((req, _res, next) => { const projectId = req.header('x-test-project'); if (projectId) (req as any).cdsProjectKey = { projectId }; next(); });
    app.use('/api', createAcceptanceResourceRunsRouter({ stateService: state, release: {
      coordinator, lifecycle: new OwnedContainerLifecycle(shell, 'own-instance'), canExecute: () => binding && !remote,
    } } as any));
    server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  });
  afterEach(async () => { vi.restoreAllMocks(); await new Promise<void>(resolve => server.close(() => resolve())); await state.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  function request(token = owner.ownerToken, project = 'p1') {
    return new Promise<{ status: number; body: any; raw: string }>((resolve, reject) => {
      const data = JSON.stringify({ ownerToken: token });
      const req = http.request({ host: '127.0.0.1', port: (server.address() as any).port, path: '/api/acceptance-resource-runs/' + owner.run.id + '/release', method: 'POST', agent: false,
        headers: { 'x-test-project': project, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
        let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; });
        res.on('end', () => { let body; try { body = JSON.parse(raw); } catch { body = null; } resolve({ status: res.statusCode!, body, raw }); });
      });
      req.setTimeout(5000, () => req.destroy(new Error('own request deadline'))); req.on('error', reject); req.end(data);
    });
  }
  it('stops/removes only original full ID and atomically publishes the target graph after exact absence', async () => {
    const other = structuredClone(state.getBranch('b1')!.services.other);
    const result = await request(); expect(result.status).toBe(200); expect(result.body.run.stage).toBe('released');
    expect(result.body.run.terminal.verdict).toBe('fail'); expect(result.raw).not.toMatch(/ownerHash|private-value/);
    expect(commands.filter(command => !command.startsWith('docker inspect'))).toEqual(['docker stop -t 10 ' + id, 'docker rm ' + id]);
    const branch = state.getBranch('b1')!; expect(branch.extraProfiles!.map(p => p.id)).toEqual(['other']);
    expect(branch.profileOverrides).toEqual({ other: { env: { KEEP: 'yes' } } }); expect(branch.services).toEqual({ other });
    const restored = new StateService(path.join(dir, 'state.json')); restored.load(); await restored.flush();
    expect(restored.getState().acceptanceResourceRuns![owner.run.id].stage).toBe('released'); expect(restored.getBranch('b1')!.services).toEqual({ other });
    const count = commands.length; facts.Id = 'd'.repeat(64); exists = true;
    expect((await request()).body.run.stage).toBe('released'); expect(commands).toHaveLength(count);
  });
  it.each(['project', 'owner', 'binding', 'remote', 'lease', 'mount', 'wrong-id', 'report'])('refuses %s before any destructive command', async kind => {
    if (kind === 'binding') binding = false;
    if (kind === 'remote') remote = true;
    if (kind === 'lease') coordinator.begin({ branchId: 'b1', kind: 'deploy', trigger: 'manual' });
    if (kind === 'mount') facts.Mounts = [{ Type: 'volume', Source: 'own', Destination: '/data', RW: true, Mode: 'rw', Propagation: '' }];
    if (kind === 'wrong-id') facts.Id = 'd'.repeat(64);
    if (kind === 'report') fs.writeFileSync(path.join(state.getReportsBase(), kernel.get(owner.run.id)!.terminal!.reportId + '.md'), 'changed body');
    const result = await request(kind === 'owner' ? 'f'.repeat(64) : owner.ownerToken, kind === 'project' ? 'p2' : 'p1');
    expect(result.status).toBe(kind === 'project' || kind === 'owner' ? 403 : kind === 'remote' || kind === 'binding' ? 503 : 409);
    expect(commands.filter(command => !command.startsWith('docker inspect'))).toEqual([]);
    expect(kernel.get(owner.run.id)!.stage).toBe('finished'); expect(state.getBranch('b1')!.services[scope.profileId].containerId).toBe(id);
  });
  it('does not stop before reliable prepared ACK and fences an intervening identity change', async () => {
    const flush = state.flush.bind(state); let resume!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; }), began = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(state, 'flush').mockImplementationOnce(async () => { await flush(); entered(); await gate; });
    const releasing = request();
    try { await began; expect(commands.filter(command => command.startsWith('docker stop'))).toEqual([]); state.getBranch('b1')!.services[scope.profileId].containerId = 'd'.repeat(64); }
    finally { resume(); }
    const result = await releasing; expect(result.status).toBe(409); expect(kernel.get(owner.run.id)!.stage).toBe('finished');
    expect(commands.filter(command => !command.startsWith('docker inspect'))).toEqual([]);
  });
  it.each(['stop', 'rm'])('preserves intent and graph after an unknown %s result', async kind => {
    hook = async command => { if (command.startsWith(kind === 'stop' ? 'docker stop' : 'docker rm')) throw new Error('unknown private daemon response'); };
    const result = await request(); expect(result.status).toBe(500); expect(result.body.error).toBe('internal');
    const row = kernel.get(owner.run.id)!; expect(row.stage).toBe('finished');
    expect(row.releaseIntent!.phase).toBe(kind === 'stop' ? 'prepared' : 'stopped');
    expect(state.getBranch('b1')!.services[scope.profileId].containerId).toBe(id);
    if (kind === 'stop') expect(commands.some(command => command.startsWith('docker rm'))).toBe(false);
    expect((await request()).status).toBe(500); // Explicit retry, still unknown; no automatic recreation.
  });
  it('never adopts a same-name successor when original ID has disappeared during explicit retry', async () => {
    hook = async command => { if (command.startsWith('docker stop')) throw new Error('unknown'); };
    expect((await request()).status).toBe(500); const count = commands.length;
    hook = undefined; facts.Id = 'd'.repeat(64);
    const result = await request(); expect(result.status).toBe(409);
    expect(commands.slice(count).filter(command => !command.startsWith('docker inspect'))).toEqual([]);
    expect(kernel.get(owner.run.id)!.releaseIntent!.reference.id).toBe(id);
    expect(state.getBranch('b1')!.extraProfiles!.some(p => p.id === scope.profileId)).toBe(true);
  });
  it('retains the original prepared reference and safely reconciles an explicitly confirmed stopped resource', async () => {
    hook = async command => { if (command.startsWith('docker stop')) { facts.State.Running = false; throw new Error('unknown stop ACK'); } };
    expect((await request()).status).toBe(500); expect(kernel.get(owner.run.id)!.releaseIntent!.phase).toBe('prepared');
    const count = commands.length; hook = undefined;
    expect((await request()).status).toBe(200);
    expect(commands.slice(count).filter(command => !command.startsWith('docker inspect'))).toEqual(['docker rm ' + id]);
  });
  it('rechecks the report body after the second final physical ACK before public release', async () => {
    const flush = state.flush.bind(state); let calls = 0;
    vi.spyOn(state, 'flush').mockImplementation(async () => {
      await flush();
      // prepared/stopped/removed each have two writes, then the release has two.
      if (++calls === 8) fs.writeFileSync(path.join(state.getReportsBase(), kernel.get(owner.run.id)!.terminal!.reportId + '.md'), 'changed after final physical commit');
    });
    const result = await request(); expect(result.status).toBe(409); expect(result.body.error).toBe('acceptance_report_changed');
    expect(kernel.get(owner.run.id)!.stage).toBe('finished'); expect(kernel.get(owner.run.id)!.releaseIntent!.phase).toBe('removed');
    expect(state.getBranch('b1')!.services[scope.profileId].containerId).toBe(id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).acceptanceResourceRuns[owner.run.id].stage).toBe('finished');
  });
  it('does not free a cancelled lease while its original stop is still executing', async () => {
    let resume!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; }), began = new Promise<void>(resolve => { entered = resolve; });
    hook = async command => { if (command.startsWith('docker stop')) { entered(); await gate; } };
    const releasing = request();
    try {
      await began; coordinator.cancelBranch('b1', 'own test');
      expect(coordinator.begin({ branchId: 'b1', kind: 'stop', trigger: 'manual' }).status).toBe('rejected');
      expect(kernel.get(owner.run.id)!.releaseIntent!.phase).toBe('prepared');
    } finally { resume(); }
    const result = await releasing; expect(result.status).toBe(409); expect(result.body.error).toBe('acceptance_release_cancelled');
    expect(commands.filter(command => command.startsWith('docker rm'))).toEqual([]);
    expect(kernel.get(owner.run.id)!.stage).toBe('finished');
  });
});
