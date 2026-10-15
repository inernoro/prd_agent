import { computeCdsInstanceId } from '../../src/services/orphan-container-reaper.js';
import { acceptanceCreationContainerName } from '../../src/services/acceptance-resource-profile.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { AcceptanceResourceRunService } from '../../src/services/acceptance-resource-run.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { acceptanceReleaseOperationAdmission } from '../../src/services/acceptance-release-admission.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { ContainerService } from '../../src/services/container.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { OwnedContainerLifecycle } from '../../src/services/owned-container-lifecycle.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { createAcceptanceResourceRunsRouter } from '../../src/routes/acceptance-resource-runs.js';
import { createReportsRouter } from '../../src/routes/reports.js';
import { createBranchRouter } from '../../src/routes/branches.js';
import { diskGuard } from '../../src/services/disk-guard.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
import { beginSelfUpdateDrain, isDrainBlockedPath, endSelfUpdateDrain } from '../../src/services/deploy-drain.js';

// Actual owned HTTP/Router/State/DR/Coordinator. CLI and readiness boundaries are controlled, not a real Daemon.
describe('guide2.98 original owned single-service HTTP deployment', () => {
  const sha = 'a'.repeat(40); let root: string, state: StateService, shell: MockShellExecutor, server: http.Server;
  let coordinator: BranchOperationCoordinator, kernel: AcceptanceResourceRunService, runs: DeploymentRunService;
  let owner: Awaited<ReturnType<AcceptanceResourceRunService['begin']>>, config: any, container: ContainerService;
  let scopedKey: { projectId: string };
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-owned-create-http-')); state = new StateService(path.join(root, 'state.json')); state.load();
    state.addProject({ id: 'p1', slug: 'p1', name: 'own' } as any);
    state.addBranch({ id: 'b1', projectId: 'p1', branch: 'own/create', worktreePath: root, createdAt: '2026-10-12T00:00:00Z', status: 'idle', services: {} });
    shell = new MockShellExecutor(); coordinator = new BranchOperationCoordinator(undefined, undefined, undefined, request => acceptanceReleaseOperationAdmission(state, request));
    const release = { coordinator, lifecycle: new OwnedContainerLifecycle(shell, computeCdsInstanceId(root)), canExecute: () => true };
    kernel = new AcceptanceResourceRunService(state, undefined, undefined, release); runs = new DeploymentRunService(state);
    owner = await kernel.begin({ projectId: 'p1', branchId: 'b1', profileId: 'init', isolationRunId: 'owned_run', targetSha: sha });
    await kernel.createProfile(owner.run.id, owner.ownerToken, { dockerImage: 'ghcr.io/test/init:sha-' + sha, containerPort: 8899 });
    config = { repoRoot: root, worktreeBase: root, masterPort: 9900, workerPort: 5500, dockerNetwork: 'own', portStart: 10001, sharedEnv: {}, jwt: { secret: 'controlled-test-secret', issuer: 'prdagent' }, mode: 'standalone' };
    container = new ContainerService(shell, config); scopedKey = { projectId: 'p1' };
    const app = express(); app.use((req, _res, next) => { (req as any).cdsProjectKey = req.header('x-test-project') ? { projectId: req.header('x-test-project') } : scopedKey; next() });
    app.use('/api', createAcceptanceResourceRunsRouter({ stateService: state, release }));
    app.use('/api', createReportsRouter({stateService: state}));
    app.use('/api', createBranchRouter({ stateService: state, worktreeService: new WorktreeService(shell, root), containerService: container,
      shell, config, branchOperationCoordinator: coordinator, deploymentRunService: runs }));
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    diskGuard.reset(); diskGuard.setProbe(async () => [{ totalBytes: 100, freeBytes: 80 }]); await diskGuard.refreshNow();
  });
  afterEach(async () => { vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    coordinator.clearForTest(); diskGuard.reset(); endSelfUpdateDrain(); selfStatusCache._resetForTests(); await state.flush(); fs.rmSync(root, { recursive: true, force: true }) });
  function post(body: unknown = { ownerToken: owner.ownerToken }, headers: Record<string, string> = {}, suffix = '', action = 'deploy') {
    return new Promise<{ status: number; raw: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      const q = http.request({ host: '127.0.0.1', port: (server.address() as any).port, path: '/api/acceptance-resource-runs/' + owner.run.id + '/' + action + suffix,
        method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
        let raw = ''; res.on('data', chunk => raw += chunk); res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode!, raw, headers: res.headers }));
      }); q.setTimeout(20_000, () => q.destroy(Error('own HTTP budget'))); q.on('error', reject); q.end(data);
    });
  }
  const cid = 'b'.repeat(64), imageId = 'sha256:' + 'c'.repeat(64);
  function actualCli(options: { writable?: boolean; foreign?: boolean; collision?: boolean; wrongImage?: boolean } = {}) {
    let created = false, started = false, exists = false;
    vi.spyOn(WorktreeService.prototype, 'prepareDeploymentSource').mockResolvedValue({ head: sha, afterFull: sha, sourcePath: root } as any);
    vi.spyOn(container, 'waitForReadiness').mockResolvedValue(true); // Controlled readiness, not an actual probe.
    shell.addResponsePattern(/^docker version /, () => ({ stdout: 'amd64', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/^docker pull /, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/^docker image inspect /, () => ({ stdout: JSON.stringify({ architecture: 'amd64', os: 'linux', revision: sha, id: imageId, repoDigests: [] }), stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/^docker network inspect /, () => ({ stdout: '[]', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/^(ss |netstat |docker logs |for p in )/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/^docker create /, () => { created = true; exists = true; return { stdout: cid, stderr: '', exitCode: 0 } });
    shell.addResponsePattern(/^docker stop /, () => { started = false; return { stdout: cid, stderr: '', exitCode: 0 } });
    shell.addResponsePattern(/^docker rm /, () => { exists = false; return { stdout: cid, stderr: '', exitCode: 0 } });
    shell.addResponsePattern(/^docker network connect /, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/^docker start /, () => { started = true; return { stdout: cid, stderr: '', exitCode: 0 } });
    shell.addResponsePattern(/^docker inspect --format="/, () => ({ stdout: 'running|0', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/^docker inspect --format='.*' '([^']+)'$/, match => {
      const svc = state.getBranch('b1')!.services.init, row = kernel.get(owner.run.id)!;
      if ((!created && !options.collision) || (created && !exists)) return { stdout: '', stderr: 'Error: No such object: ' + match[1], exitCode: 1 };
      return { stdout: JSON.stringify({ Id: cid, Name: '/' + svc.containerName, Image: options.wrongImage ? 'sha256:' + 'd'.repeat(64) : imageId,
        State: { Running: started }, Config: { Labels: { 'cds.managed': 'true', 'cds.type': 'app', 'cds.instance': computeCdsInstanceId(root),
          'cds.project.id': options.foreign ? 'foreign' : 'p1', 'cds.branch.id': 'b1', 'cds.profile.id': 'init',
          'cds.acceptance.run': owner.run.id, 'cds.deployment.operation': row.creationIntent!.operationId! } },
        HostConfig: { PortBindings: { '8899/tcp': [{ HostPort: String(svc.hostPort) }] } },
        Mounts: options.writable ? [{ Type: 'tmpfs', Source: '', Destination: '/tmp', RW: true, Mode: '', Propagation: '' }] : [] }), stderr: '', exitCode: 0 };
    });
    return () => ({ created, started });
  }
  it.each([
    [{ ownerToken: '0'.repeat(64) }, {}, '', 403], [{ ownerToken: 'short' }, {}, '', 400], [{ ownerToken: null }, {}, '', 400],
    ['{', {}, '', 400], ['x'.repeat(3000), {}, '', 413], [undefined, {}, '?force=1', 400],
    [undefined, { 'x-test-project': 'other' }, '', 403], [undefined, { 'x-cds-pending-operation-id': 'forged' }, '', 400],
    [undefined, { 'x-cds-trigger': 'webhook' }, '', 400],
  ])('rejects input or project access before DR and CLI %#', async (body, headers, suffix, status) => {
    const result = await post(body, headers as Record<string,string>, suffix); expect(result.status).toBe(status);
    expect(shell.commands).toHaveLength(0); expect(Object.values(state.getState().deploymentRuns || {})).toHaveLength(0);
    expect(kernel.get(owner.run.id)!.creationIntent!.phase).toBe('configured'); expect(result.raw).not.toContain(owner.ownerToken);
  });
  it.each(['deploymentRunId','operationId','commitSha','profileId','targetExecutorId','versionId'])('rejects caller %s override', async key => {
    expect((await post({ ownerToken: owner.ownerToken, [key]: 'forged' })).status).toBe(400); expect(shell.commands).toHaveLength(0);
  });
  it.each([{ writable: true }, { foreign: true }, { collision: true }, { wrongImage: true }])('holds unconfirmed resources without start/delete/retry %j', async options => {
    const phase = actualCli(options); const result = await post(); expect(result.status).toBe(200);
    expect(kernel.get(owner.run.id)!.stage).toBe('active'); expect(kernel.get(owner.run.id)!.creationIntent!.reference).toBeUndefined();
    expect(phase().started).toBe(false); expect(shell.commands.some(c => /docker (?:rm|network disconnect|start|network connect)/.test(c))).toBe(false);
    expect(shell.commands.filter(c => c.startsWith('docker create '))).toHaveLength(options.collision ? 0 : 1);
    expect(runs.get(kernel.get(owner.run.id)!.creationIntent!.deploymentRunId!)!.status).toBe('failed');
    await expect(kernel.register(owner.run.id, owner.ownerToken)).rejects.toThrow('acceptance_resource_unconfirmed');
    expect((await post()).status).toBe(409); expect(coordinator.getActiveOperations()).toHaveLength(0);
  });
  it.each([1,2])('rechecks original scope at identity ACK %i before start', async ack => {
    const phase = actualCli(); const flush = state.flush.bind(state); let injected = false;
    vi.spyOn(state,'flush').mockImplementation(async () => {
      await flush(); const disk = JSON.parse(fs.readFileSync(path.join(root,'state.json'),'utf8'));
      const reached = ack === 1 ? disk.acceptanceResourcePublications?.[owner.run.id]?.draft.creationIntent?.reference
        : disk.acceptanceResourceRuns?.[owner.run.id]?.creationIntent?.reference;
      if (!injected && reached) { injected = true; scopedKey.projectId = 'foreign'; }
    });
    const result = await post(); expect(result.status).toBe(200); expect(injected).toBe(true); expect(phase()).toEqual({ created: true, started: false });
    expect(shell.commands.some(c => /docker (?:start|network connect|rm)/.test(c))).toBe(false);
    expect(kernel.get(owner.run.id)!.creationIntent!.reference).toBeUndefined();
    const disk = JSON.parse(fs.readFileSync(path.join(root,'state.json'),'utf8')); expect(disk.acceptanceResourceRuns[owner.run.id].creationIntent.reference).toBeUndefined();
  });
  it.each(['cancel','service','profile'])('holds actual create on %s drift during identity ACK', async kind => {
    const phase = actualCli(); const flush = state.flush.bind(state); let injected = false;
    vi.spyOn(state,'flush').mockImplementation(async () => {
      await flush(); const disk = JSON.parse(fs.readFileSync(path.join(root,'state.json'),'utf8'));
      if (!injected && disk.acceptanceResourcePublications?.[owner.run.id]?.draft.creationIntent?.reference) {
        injected = true;
        if (kind === 'cancel') coordinator.cancelBranch('b1','controlled creation cancellation');
        if (kind === 'service') state.getBranch('b1')!.services.init.containerId = 'd'.repeat(64);
        if (kind === 'profile') state.getBranch('b1')!.extraProfiles![0].env!.IMP_TARGET_SHA = 'd'.repeat(40);
      }
    });
    const result = await post(); expect(result.status).toBe(200); expect(injected).toBe(true); expect(phase().started).toBe(false);
    expect(shell.commands.some(c => /docker (?:start|network connect|rm)/.test(c))).toBe(false);
    expect(kernel.get(owner.run.id)!.creationIntent!.reference).toBeUndefined(); expect(coordinator.getActiveOperations()).toHaveLength(0);
  });
  it.each(['containerId','containerName','deployedImage','hostPort','deployedCommitSha','deployedPrebuilt','deployedMode'])('holds captured original identity on network await %s drift', async field => {
    const phase = actualCli(); let drifted = false;
    vi.spyOn(container, 'waitForContainerAlive').mockResolvedValue(undefined);
    shell.addResponsePatternFirst(/^docker network connect /, () => {
      const svc = state.getBranch('b1')!.services.init;
      const row = kernel.get(owner.run.id)!;
      expect(row.creationIntent!.reference!.id).toBe(cid);
      drifted = true;
      (svc as any)[field] = field === 'hostPort' ? svc.hostPort + 1 : field === 'deployedPrebuilt' ? false
        : field === 'containerId' ? 'd'.repeat(64) : field === 'containerName' ? 'foreign'
        : field === 'deployedImage' ? 'sha256:' + 'd'.repeat(64) : field === 'deployedCommitSha' ? 'd'.repeat(40) : 'static';
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const result = await post(); expect(drifted).toBe(true);
    expect(phase()).toEqual({ created: true, started: false });
    expect(shell.commands.some(c => c.startsWith('docker start '))).toBe(false);
    expect(result.raw).not.toContain('"ok":true');
    expect(kernel.get(owner.run.id)!.creationIntent!.reference!.id).toBe(cid);
    expect(shell.commands.some(c => c.startsWith('docker rm '))).toBe(false);
    expect((await post(undefined, {}, '', 'register')).status).toBe(409);
  });
  it.each(['start','readiness'])('does not publish success after %s identity drift', async boundary => {
    const phase = actualCli(); let drifted = false;
    vi.spyOn(container, 'waitForContainerAlive').mockResolvedValue(undefined);
    const change = () => { state.getBranch('b1')!.services.init.deployedImage = 'sha256:' + 'd'.repeat(64); drifted = true; };
    if (boundary === 'start') shell.addResponsePatternFirst(/^docker start /, () => { change(); return { stdout: cid, stderr: '', exitCode: 0 }; });
    else vi.spyOn(container, 'waitForReadiness').mockImplementationOnce(async () => { change(); return true; });
    const result = await post(); expect(drifted).toBe(true); expect(phase().created).toBe(true);
    expect(result.raw).not.toContain('"ok":true');
    expect(runs.get(kernel.get(owner.run.id)!.creationIntent!.deploymentRunId!)!.status).toBe('failed');
    expect((await post(undefined, {}, '', 'register')).status).toBe(409);
    expect(shell.commands.some(c => c.startsWith('docker rm '))).toBe(false);
  });
  it('preserves occupancy on unknown identity publication and compensation ACK', async () => {
    const phase = actualCli(); const flush = state.flush.bind(state); let triggered = false, remaining = 0;
    vi.spyOn(state,'flush').mockImplementation(async () => {
      await flush(); const disk = JSON.parse(fs.readFileSync(path.join(root,'state.json'),'utf8'));
      if (!triggered && disk.acceptanceResourcePublications?.[owner.run.id]?.draft.creationIntent?.reference) { triggered = true; remaining = 2; }
      if (remaining) { remaining--; throw Error('controlled unknown capture ACK'); }
    });
    expect((await post()).status).toBe(200); expect(triggered).toBe(true); expect(phase()).toEqual({ created: true, started: false });
    expect(state.getState().acceptanceResourcePublications?.[owner.run.id]).toBeDefined();
    expect((await post()).status).toBe(409); expect(shell.commands.filter(c => c.startsWith('docker create '))).toHaveLength(1);
    expect(shell.commands.some(c => /docker (?:start|network connect|rm)/.test(c))).toBe(false);
  });
  it.each(['low-disk','drain','post-disk-permission'])('uses production admission before DR/container for %s', async mode => {
    if (mode === 'low-disk') { diskGuard.setProbe(async () => [{totalBytes:100,freeBytes:5}]); await diskGuard.refreshNow(); }
    if (mode === 'drain') beginSelfUpdateDrain(Date.now());
    if (mode === 'post-disk-permission') vi.spyOn(diskGuard,'blockReasonForDeploy').mockImplementationOnce(async () => { scopedKey.projectId = 'foreign'; return null; });
    const result = await post(); expect(result.status).toBe(mode === 'low-disk' ? 507 : mode === 'drain' ? 503 : 403);
    expect(shell.commands).toHaveLength(0); expect(Object.values(state.getState().deploymentRuns || {})).toHaveLength(0);
    expect(kernel.get(owner.run.id)!.creationIntent!.phase).toBe('configured');
  });
  it('includes owned alias/case/trailing slash in application drain SSOT', () => {
    for (const route of ['/acceptance-resource-runs/ar_abc/deploy','/acceptance-resource-runs/ar_abc/deploy/','/ACCEPTANCE-RESOURCE-RUNS/ar_abc/DEPLOY']) expect(isDrainBlockedPath('POST',route)).toBe(true);
    expect(isDrainBlockedPath('GET','/acceptance-resource-runs/ar_abc/deploy')).toBe(false);
    expect(isDrainBlockedPath('POST','/acceptance-resource-runs/ar_abc/register')).toBe(false);
  });
  it('ACKs actual create identity before connect/start and registers original ready run', async () => {
    const phase = actualCli();
    vi.spyOn(container, 'waitForReadiness').mockImplementationOnce(async () => {
      expect((await post(undefined, {}, '', 'register')).status).toBe(409); return true;
    });
    let release!: () => void, entered!: () => void, held = false;
    const enteredPromise = new Promise<void>(resolve => entered = resolve), barrier = new Promise<void>(resolve => release = resolve);
    const flush = state.flush.bind(state);
    vi.spyOn(state, 'flush').mockImplementation(async () => {
      await flush(); const disk = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
      if (!held && disk.acceptanceResourcePublications?.[owner.run.id]?.draft.creationIntent?.reference) { held = true; entered(); await barrier; }
    });
    const pending = post(); await Promise.race([enteredPromise, pending.then(result => { throw Error('create identity boundary not reached: ' + result.raw); })]);
    try {
      expect(phase()).toEqual({ created: true, started: false }); expect(kernel.get(owner.run.id)!.creationIntent!.reference).toBeUndefined();
      expect(shell.commands.some(c => /docker (?:network connect|start)/.test(c))).toBe(false);
      await expect(kernel.register(owner.run.id, owner.ownerToken)).rejects.toThrow();
    } finally { release(); }
    const result = await pending;
    const row = kernel.get(owner.run.id)!, deployment = runs.get(row.creationIntent!.deploymentRunId!)!, svc = state.getBranch('b1')!.services.init;
    expect(result.status).toBe(200); expect(deployment.status, result.raw).toBe('running'); expect(phase().started).toBe(true);
    expect(row.creationIntent!.reference).toMatchObject({ id: cid, image: imageId, name: acceptanceCreationContainerName('b1','init',owner.run.id), writableMounts: [], wasRunning: false });
    expect(svc.deployedCommitSha).toBe(sha); expect(svc.deployedMode).toBe('express');
    expect(shell.commands.some(c => c.startsWith('docker rm ') || /mvn|npm |pnpm |--tmpfs/.test(c))).toBe(false);
    expect(shell.commands.find(c => c.startsWith('docker create '))).toContain(imageId);
    const registration = await post(undefined, {}, '', 'register'); expect(registration.status, registration.raw).toBe(200);
    const registered = JSON.parse(registration.raw).run; expect(registered.stage).toBe('registered');
    expect(registered.resource).toMatchObject({ containerId: cid, deploymentRunId: deployment.id });
    expect(result.raw).not.toContain(owner.ownerToken); expect(coordinator.getActiveOperations()).toHaveLength(0);
    const meta = await kernel.createBoundReport({ id: owner.run.id, ownerToken: owner.ownerToken, projectId: 'p1', branchId: 'b1', commitSha: sha }, async fence => {
      fence(); return state.createAcceptanceReportAsync({ projectId: 'p1', branchId: 'b1', commitSha: sha, acceptanceRunId: owner.run.id,
        verdict: 'fail', title: 'controlled creation lifecycle', format: 'md', content: 'Local controlled lifecycle evidence; not formal acceptance.' });
    });
    const finished = await post({ ownerToken: owner.ownerToken, reportId: meta.id }, {}, '', 'finish'); expect(finished.status, finished.raw).toBe(200);
    expect(JSON.parse(finished.raw).run.stage).toBe('finished');
    const released = await post(undefined, {}, '', 'release'); expect(released.status, released.raw).toBe(200);
    expect(JSON.parse(released.raw).run.stage).toBe('released'); expect(state.getBranch('b1')!.services.init).toBeUndefined();
    expect(shell.commands).toContain('docker stop -t 10 ' + cid); expect(shell.commands).toContain('docker rm ' + cid);
    expect(shell.commands.some(c => c.startsWith('docker rm -f ') || c.startsWith('docker network rm '))).toBe(false);
    const reloaded = new StateService(path.join(root,'state.json')); reloaded.load(); await reloaded.flush(); expect(reloaded.getState().acceptanceResourceRuns![row.id]).toMatchObject({ stage: 'released', creationIntent: { reference: { id: cid } } });
  }, 30_000);
  async function failAfterCapture(boundary: 'start' | 'readiness' = 'start') {
    actualCli(); vi.spyOn(container, 'waitForContainerAlive').mockResolvedValue(undefined);
    if (boundary === 'start') shell.addResponsePatternFirst(/^docker start /, () => ({stdout:'',stderr:'controlled start failure',exitCode:1}));
    else vi.spyOn(container, 'waitForReadiness').mockResolvedValue(false);
    const result=await post();expect(result.raw).not.toContain('"ok":true');
    const row=kernel.get(owner.run.id)!;
    expect(row.stage).toBe('active');expect(row.creationIntent!.reference!.id).toBe(cid);
    expect(runs.get(row.creationIntent!.deploymentRunId!)!.status).toBe('failed');
    expect((await post(undefined,{},'','register')).status).toBe(409);
    expect(shell.commands.some(c=>c.startsWith('docker rm '))).toBe(false);
    return row;
  }
  function archive(verdict='fail') {
    return new Promise<{status:number;raw:string}>((resolve,reject)=>{
      const data=JSON.stringify({projectId:'p1',branchId:'b1',commitSha:sha,acceptanceRunId:owner.run.id,
        acceptanceOwnerToken:owner.ownerToken,title:'Controlled failure evidence',content:'Owned failed creation; local only.',format:'md',verdict});
      const req=http.request({host:'127.0.0.1',port:(server.address() as any).port,path:'/api/reports',method:'POST',agent:false,
        headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{
        let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode!,raw}));res.on('error',reject);
      });req.setTimeout(5000,()=>req.destroy(Error('report budget')));req.on('error',reject);req.end(data);
    });
  }
  it.each(['start','readiness'] as const)('explicit failed original %s creation archives fail and releases only original ID',async boundary=>{
    const original=await failAfterCapture(boundary);
    const result=await post(undefined,{},'','register-failed');expect(result.status,result.raw).toBe(200);
    const row=JSON.parse(result.raw).run;expect(row.stage).toBe('failed-registered');expect(row.creationIntent).toEqual(original.creationIntent);
    expect(row.resource.creationFailure).toMatchObject({status:'failed'});expect(row.resource.creationFailure.deploymentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(coordinator.begin({projectId:'p1',branchId:'b1',kind:'deploy',trigger:'manual'}).status).toBe('rejected');
    const report=await archive();expect(report.status,report.raw).toBe(201);const reportId=JSON.parse(report.raw).report.id;
    const finished=await post({ownerToken:owner.ownerToken,reportId},{},'','finish');expect(finished.status,finished.raw).toBe(200);
    expect(JSON.parse(finished.raw).run.terminal.verdict).toBe('fail');
    expect(coordinator.begin({projectId:'p1',branchId:'b1',kind:'deploy',trigger:'manual'}).status).toBe('rejected');
    const released=await post(undefined,{},'','release');expect(released.status,released.raw).toBe(200);
    expect(JSON.parse(released.raw).run.stage).toBe('released');expect(state.getBranch('b1')!.services.init).toBeUndefined();
    expect(shell.commands).toContain('docker rm '+cid);
    expect(shell.commands.some(c=>c.startsWith('docker rm -f ')||c.startsWith('docker network rm '))).toBe(false);
    const disk=new StateService(path.join(root,'state.json'));disk.load();await disk.flush();
    expect(disk.getState().acceptanceResourceRuns![owner.run.id]).toMatchObject({stage:'released',resource:{creationFailure:{status:'failed'}}});
  },30_000);
  it.each(['pass','conditional'])('failed resource refuses %s report before producer/archive',async verdict=>{
    await failAfterCapture();expect((await post(undefined,{},'','register-failed')).status).toBe(200);
    const before=Object.keys(state.getState().acceptanceReports||{}).length;
    const result=await archive(verdict);expect(result.status,result.raw).toBe(409);expect(result.raw).toContain('acceptance_report_mismatch');
    expect(Object.keys(state.getState().acceptanceReports||{})).toHaveLength(before);
    expect(kernel.get(owner.run.id)!.stage).toBe('failed-registered');
    expect(shell.commands.some(c=>c.startsWith('docker rm '))).toBe(false);
  });
  it.each(['owner','project','reference','identity','source','unknown','restart'] as const)('failed registration holds original resource on %s mismatch',async kind=>{
    await failAfterCapture();const row=state.getState().acceptanceResourceRuns![owner.run.id], branch=state.getBranch('b1')!;
    if(kind==='reference') delete row.creationIntent!.reference;
    if(kind==='identity') branch.services.init.containerId='d'.repeat(64);
    if(kind==='source') state.getDeploymentRun(row.creationIntent!.deploymentRunId!)!.operationId='foreign';
    if(kind==='unknown') shell.addResponsePatternFirst(/^docker inspect --format='/,()=>({stdout:'',stderr:'unknown',exitCode:1}));
    if(kind==='restart') coordinator.clearForTest();
    const result=await post(kind==='owner'?{ownerToken:'0'.repeat(64)}:undefined,kind==='project'?{'x-test-project':'foreign'}:{},'','register-failed');
    expect(result.status,result.raw).toBe(kind==='owner'||kind==='project'?403:409);
    expect(kernel.get(owner.run.id)!.stage).toBe('active');expect(shell.commands.some(c=>c.startsWith('docker rm '))).toBe(false);
  });
  it.each([1,2])('failed registration rechecks original identity after publication ACK %i',async ack=>{
    await failAfterCapture();const flush=state.flush.bind(state);let injected=false;
    vi.spyOn(state,'flush').mockImplementation(async()=>{
      await flush();const disk=JSON.parse(fs.readFileSync(path.join(root,'state.json'),'utf8'));
      const reached=ack===1?disk.acceptanceResourcePublications?.[owner.run.id]?.draft.stage==='failed-registered'
        :disk.acceptanceResourceRuns?.[owner.run.id]?.stage==='failed-registered';
      if(!injected&&reached){injected=true;state.getBranch('b1')!.services.init.containerId='d'.repeat(64);}
    });
    const result=await post(undefined,{},'','register-failed');expect(injected).toBe(true);expect(result.status,result.raw).toBe(409);
    expect(kernel.get(owner.run.id)!.stage).toBe('active');expect(shell.commands.some(c=>c.startsWith('docker rm '))).toBe(false);
  });
  it('generic writer cannot publish a first failed registration',async()=>{
    const row=await failAfterCapture();
    await expect(state.writeAcceptanceResourceRunDurably({...state.getState().acceptanceResourceRuns![row.id],seq:row.seq+1,stage:'failed-registered'},row.seq,()=>{}))
      .rejects.toThrow();expect(kernel.get(row.id)!.stage).toBe('active');
  });
  it('failed registration still refuses pass metadata forged outside the archive endpoint',async()=>{
    await failAfterCapture();expect((await post(undefined,{},'','register-failed')).status).toBe(200);
    const meta=await state.createAcceptanceReportAsync({projectId:'p1',branchId:'b1',commitSha:sha,acceptanceRunId:owner.run.id,
      title:'Rejected pass',content:'controlled',format:'md',verdict:'pass'});
    const result=await post({ownerToken:owner.ownerToken,reportId:meta.id},{},'','finish');expect(result.status,result.raw).toBe(409);
    expect(kernel.get(owner.run.id)!.stage).toBe('failed-registered');expect(shell.commands.some(c=>c.startsWith('docker rm '))).toBe(false);
  });
  it('persisted failed registration finishes and releases via a new kernel without inventing executor settlement',async()=>{
    await failAfterCapture();expect((await post(undefined,{},'','register-failed')).status).toBe(200);
    const loaded=new StateService(path.join(root,'state.json'));loaded.load();await loaded.flush();
    const freshCoordinator=new BranchOperationCoordinator(undefined,undefined,undefined,r=>acceptanceReleaseOperationAdmission(loaded,r));
    const fresh=new AcceptanceResourceRunService(loaded,undefined,undefined,{coordinator:freshCoordinator,
      lifecycle:new OwnedContainerLifecycle(shell,computeCdsInstanceId(root)),canExecute:()=>true});
    const registered=fresh.get(owner.run.id)!;expect(registered.stage).toBe('failed-registered');
    const meta=await fresh.createBoundReport({id:owner.run.id,ownerToken:owner.ownerToken,projectId:'p1',branchId:'b1',commitSha:sha,verdict:'fail'},async fence=>{
      fence();return loaded.createAcceptanceReportAsync({projectId:'p1',branchId:'b1',commitSha:sha,acceptanceRunId:owner.run.id,
        title:'Persisted failure',content:'controlled original evidence',format:'md',verdict:'fail'});
    });
    expect((await fresh.finish(owner.run.id,owner.ownerToken,meta.id)).terminal!.verdict).toBe('fail');
    expect((await fresh.release(owner.run.id,owner.ownerToken)).stage).toBe('released');
    expect(loaded.getBranch('b1')!.services.init).toBeUndefined();await loaded.flush();
    const final=new StateService(path.join(root,'state.json'));final.load();await final.flush();expect(final.getState().acceptanceResourceRuns![owner.run.id].stage).toBe('released');
    freshCoordinator.clearForTest();
  });
  it('failure registration cannot overtake revoked yet unsettled original executor',async()=>{
    actualCli();vi.spyOn(container,'waitForContainerAlive').mockResolvedValue(undefined);
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
    vi.spyOn(container,'waitForReadiness').mockImplementationOnce(async()=>{enter();await held;return false});
    const pending=post();await entered;
    try{
      const row=kernel.get(owner.run.id)!;coordinator.cancelBranch('b1','controlled');
      // Terminal metadata alone is insufficient while the actual awaited executor still runs.
      state.getDeploymentRun(row.creationIntent!.deploymentRunId!)!.status='failed';state.getDeploymentRun(row.creationIntent!.deploymentRunId!)!.finishedAt=new Date().toISOString();await state.flush();
      const result=await post(undefined,{},'','register-failed');expect(result.status,result.raw).toBe(409);
      expect(kernel.get(owner.run.id)!.stage).toBe('active');expect(shell.commands.some(c=>c.startsWith('docker rm '))).toBe(false);
    }finally{release();await pending;}
  },30_000);
  it('binds the actual new server run before the first pull and returns its own ID', async () => {
    let observed: any;
    vi.spyOn(WorktreeService.prototype, 'prepareDeploymentSource').mockImplementationOnce(async () => {
      const raw = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
      observed = Object.values(raw.deploymentRuns).find((run: any) => run.acceptanceOrigin?.acceptanceRunId === owner.run.id);
      throw Error('owned pull boundary');
    });
    const result = await post(); expect(result.status).toBe(200); expect(observed?.acceptanceOrigin).toMatchObject({ acceptanceRunId: owner.run.id, profileId: 'init', targetSha: sha });
    expect(result.headers['x-cds-deployment-run-id']).toBe(observed.id); expect(kernel.get(owner.run.id)!.creationIntent!.deploymentRunId).toBe(observed.id);
    expect(runs.get(observed.id)!.status).toBe('failed'); expect(shell.commands).toHaveLength(0); expect(result.raw).not.toContain(owner.ownerToken);
    expect(coordinator.getActiveOperations()).toHaveLength(0);
  });
});
