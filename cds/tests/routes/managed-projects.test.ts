import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    const app = express();
    app.use(express.json());
    app.use('/api', createManagedProjectsRouter({
      stateService,
      managedProjectService: new ManagedProjectService(stateService),
      assertProjectAccess: () => null,
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
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
});
