import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedProjectsRouter } from '../../src/routes/managed-projects.js';
import { ManagedProjectService } from '../../src/services/managed-project.js';
import { StateService } from '../../src/services/state.js';

async function request(server: http.Server, method: string, urlPath: string, body?: unknown) {
  return await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const address = server.address() as { port: number };
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: address.port, path: urlPath, method,
      headers: raw ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {},
    }, (res) => {
      let output = '';
      res.on('data', (chunk) => { output += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: output ? JSON.parse(output) : null }));
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

describe('managed project delivery routes', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;
  let managedProjectService: ManagedProjectService;
  let denied: boolean;
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-managed-routes-'));
    const worktree = path.join(tmpDir, 'worktree');
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({
      scripts: { build: 'vite build', start: 'vite --host 0.0.0.0' },
      dependencies: { vite: '^6.0.0' },
    }));
    stateService = new StateService(path.join(tmpDir, 'state.json'));
    stateService.load();
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1', kind: 'git' } as any);
    stateService.addBranch({
      id: 'b1', projectId: 'p1', branch: 'main', worktreePath: worktree,
      services: {}, status: 'idle', createdAt: 't', githubCommitSha: 'abc1234',
    });
    git(worktree, 'init'); git(worktree, 'add', 'package.json');
    git(worktree, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
    managedProjectService = new ManagedProjectService(stateService);
    denied = false;
    const app = express();
    app.use(express.json());
    app.use('/api', createManagedProjectsRouter({
      stateService,
      managedProjectService,
      assertProjectAccess: () => denied ? {status:403,body:{error:'fixture denied'}} : null,
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await stateService.flush();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults legacy projects to compose mode', async () => {
    const response = await request(server, 'GET', '/api/projects/p1/delivery');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ mode: 'compose', effectiveProfiles: [] });
  });

  it('validates and saves a managed spec, then exposes the generated effective plan', async () => {
    const update = await request(server, 'PUT', '/api/projects/p1/delivery', {
      mode: 'managed',
      managedSpec: {
        apps: [{ id: 'web', appPath: '.', workload: 'web', health: { type: 'http', path: '/' } }],
        capabilities: [],
      },
    });
    expect(update.status).toBe(200);

    const plan = await request(server, 'POST', '/api/projects/p1/managed-plan', { branchId: 'b1' });
    expect(plan.status).toBe(200);
    expect(plan.body.plan.profiles[0]).toMatchObject({
      id: 'web',
      managedBuild: { artifactImage: expect.stringMatching(/^cds-managed\//) },
    });

    const get = await request(server, 'GET', '/api/projects/p1/delivery');
    expect(get.body).toMatchObject({ mode: 'managed' });
    expect(get.body.effectiveProfiles).toHaveLength(1);
  });

  it('rejects invalid app paths and capability environment keys', async () => {
    const response = await request(server, 'PUT', '/api/projects/p1/delivery', {
      mode: 'managed',
      managedSpec: {
        apps: [{ id: 'web', appPath: '.', workload: 'invalid' }],
        capabilities: [{ id: 'secret', kind: 'secrets', bindingId: 'env', envKeys: ['bad-key'] }],
      },
    });
    expect(response.status).toBe(400);
  });
  const spec = { apps: [{ id: 'web', appPath: '.', workload: 'web' }], capabilities: [] };
  const atomicRead = () => request(server, 'GET', '/api/projects/p1/delivery?branchId=b1');

  it('atomically computes before one save, while a generation failure keeps old configuration with zero saves', async () => {
    let snapshot = await atomicRead();
    const saves = vi.spyOn(stateService, 'save');
    const success = await request(server, 'PUT', '/api/projects/p1/delivery', { mode:'managed', managedSpec:spec, generatePlan:true, branchId:'b1', expectedRevision:snapshot.body.revision });
    expect(success.status).toBe(200); expect(saves).toHaveBeenCalledTimes(1);
    expect(stateService.getProject('p1')?.managedProfiles).toHaveLength(1);
    snapshot = await atomicRead();
    const before = structuredClone(stateService.getProject('p1'));
    saves.mockClear();
    const failed = await request(server, 'PUT', '/api/projects/p1/delivery', { mode:'managed', managedSpec:{...spec,apps:[{...spec.apps[0],appPath:'missing-directory'}]}, generatePlan:true, branchId:'b1', expectedRevision:snapshot.body.revision });
    expect(failed.status).toBe(422); expect(saves).not.toHaveBeenCalled();
    expect(stateService.getProject('p1')).toEqual(before);
  });

  it('rejects stale project and repository revisions without saving', async () => {
    const snapshot = await atomicRead();
    stateService.updateProject('p1', { name:'new project name' });
    const saves = vi.spyOn(stateService,'save');
    const stale = await request(server,'PUT','/api/projects/p1/delivery',{mode:'managed',managedSpec:spec,generatePlan:true,branchId:'b1',expectedRevision:snapshot.body.revision});
    expect(stale.status).toBe(409);expect(saves).not.toHaveBeenCalled();
    const fresh = await atomicRead();
    const root=path.join(tmpDir,'worktree');fs.writeFileSync(path.join(root,'new-source.txt'),'new revision');git(root,'add','new-source.txt');git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','new source');
    const moved = await request(server,'PUT','/api/projects/p1/delivery',{mode:'managed',managedSpec:spec,generatePlan:true,branchId:'b1',expectedRevision:fresh.body.revision});
    expect(moved.status).toBe(409);expect(saves).not.toHaveBeenCalled();
  });

  it('rechecks source after candidate computation and rejects dirty or untracked workspaces', async () => {
    const snapshot=await atomicRead();
    const root=path.join(tmpDir,'worktree');
    const original=managedProjectService.planForProject.bind(managedProjectService);
    vi.spyOn(managedProjectService,'planForProject').mockImplementationOnce((...args)=>{
      const plan=original(...args);fs.writeFileSync(path.join(root,'pending-source.txt'),'uncommitted source');return plan;
    });
    const saves=vi.spyOn(stateService,'save');
    const changed=await request(server,'PUT','/api/projects/p1/delivery',{mode:'managed',managedSpec:spec,generatePlan:true,branchId:'b1',expectedRevision:snapshot.body.revision});
    expect(changed.status).toBe(409);expect(saves).not.toHaveBeenCalled();
    const dirty=await atomicRead();expect(dirty.body.generationSource.commitSha).toBeNull();
    const blocked=await request(server,'PUT','/api/projects/p1/delivery',{mode:'managed',managedSpec:spec,generatePlan:true,branchId:'b1',expectedRevision:dirty.body.revision});
    expect(blocked.status).toBe(409);expect(saves).not.toHaveBeenCalled();
  });

  it('preserves project access checks for atomic saves', async () => {
    const snapshot=await atomicRead();denied=true;const saves=vi.spyOn(stateService,'save');
    const response=await request(server,'PUT','/api/projects/p1/delivery',{mode:'managed',managedSpec:spec,generatePlan:true,branchId:'b1',expectedRevision:snapshot.body.revision});
    expect(response.status).toBe(403);expect(saves).not.toHaveBeenCalled();
  });

  it('reports a write-stage exception as unknown instead of claiming the previous configuration survived', async () => {
    const snapshot=await atomicRead();
    const saves=vi.spyOn(stateService,'save').mockImplementationOnce(()=>{throw new Error('synthetic persistence failure');});
    const response=await request(server,'PUT','/api/projects/p1/delivery',{mode:'managed',managedSpec:spec,generatePlan:true,branchId:'b1',expectedRevision:snapshot.body.revision});
    expect(response.status).toBe(500);expect(response.body.error).toContain('未能确认保存结果');
    expect(saves).toHaveBeenCalledTimes(1);
    // 内存写入已发生；本测试专门防止把它误报成422/零变更/可直接重试。
    expect(stateService.getProject('p1')?.deliveryMode).toBe('managed');
    saves.mockRestore();
  });

});
