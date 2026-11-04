import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnControl = vi.hoisted(() => ({ children: [] as Array<any> }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((command: string, argv: string[]) => {
      const child = new EventEmitter() as any;
      child.command = command;
      child.argv = argv;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      spawnControl.children.push(child);
      setImmediate(() => child.stdout.write(Buffer.from('archive-byte')));
      return child;
    }),
  };
});

import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

describe('peer migration process lifecycle', () => {
  let server: http.Server | null = null;
  let tmpDir = '';

  afterEach(async () => {
    await flushAllJsonStateStores();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    spawnControl.children.length = 0;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects legacy peer push before a dump, connection or running state, and directs the owner to pull', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-peer-push-preflight-'));
    const stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir); stateService.load();
    const source = { type: 'remote' as const, host: 'must-not-connect.invalid', port: 27017, database: 'qa' };
    const target = { type: 'cds' as const, host: '', port: 27017, cdsPeerId: 'must-not-contact', database: 'qa', projectId: 'project-a', serviceId: 'mongo-a' };
    const migration = { id: 'legacy-push', name: 'legacy push', dbType: 'mongodb' as const, source, target, status: 'pending' as const, progress: 0, createdAt: new Date().toISOString() };
    stateService.addDataMigration(migration);
    const shell = new MockShellExecutor();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any)._cdsCookieAuth = true; (req as any)._cdsBasicHumanAuth = true; (req as any).cdsUser = { username: 'owner', isSystemOwner: true, authProvider: 'legacy' }; next(); });
    app.use('/api', createBranchRouter({ stateService, shell, config: { repoRoot: tmpDir, worktreeBase: path.join(tmpDir, 'worktrees'), masterPort: 9900, workerPort: 5500, dockerNetwork: 'cds-network', portStart: 10001, sharedEnv: {}, rootDomains: ['mycds.test'], jwt: { secret: 'test', issuer: 'cds' } }, worktreeService: {} as any, containerService: {} as any }));
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    const port = (server!.address() as { port: number }).port;
    for (const [method, route, body] of [
      ['POST', '/api/data-migrations/legacy-push/execute', {}],
      ['POST', '/api/data-migrations', { name: 'new push', dbType: 'mongodb', source, target }],
      ['PUT', '/api/data-migrations/legacy-push', { target }],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(409); expect(response.headers.get('content-type')).toContain('application/json');
      const result = await response.json() as { code: string; error: string };
      expect(result.code).toBe('migration_peer_push_requires_target_pull'); expect(result.error).toContain('目标系统所有者发起拉取');
    }
    expect(stateService.getDataMigration('legacy-push')?.status).toBe('pending');
    expect(stateService.getDataMigration('legacy-push')?.startedAt).toBeUndefined();
    expect(stateService.getDataMigrations()).toHaveLength(1);
    const pull = await fetch(`http://127.0.0.1:${port}/api/data-migrations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'owner pull', dbType: 'mongodb', source: target, target: { type: 'local', host: '', port: 27017, database: 'qa', projectId: 'project-a', serviceId: 'mongo-a' } }) });
    expect(pull.status).toBe(200);
    const accepted = await pull.json() as { source: { type: string }; target: { type: string }; status: string };
    expect(accepted.source.type).toBe('cds'); expect(accepted.target.type).toBe('local'); expect(accepted.status).toBe('pending');
    expect(spawnControl.children).toHaveLength(0); expect(shell.commands).toHaveLength(0);
  });

  it('keeps the maintenance job active after disconnect until mongodump closes', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-peer-dump-lifecycle-'));
    const stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    stateService.addInfraService({
      id: 'mongodb', projectId: 'project-a', name: 'MongoDB', dockerImage: 'mongo:7',
      containerPort: 27017, hostPort: 27018, containerName: 'mongo-a', status: 'running',
      env: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'peer-canary-secret' },
      volumes: [], createdAt: new Date().toISOString(),
    });
    const config: CdsConfig = {
      repoRoot: tmpDir, worktreeBase: path.join(tmpDir, 'worktrees'), masterPort: 9900,
      workerPort: 5500, dockerNetwork: 'cds-network', portStart: 10001,
      sharedEnv: {}, rootDomains: ['miduo.org'], jwt: { secret: 'test', issuer: 'cds' },
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createBranchRouter({
      stateService,
      shell: new MockShellExecutor(),
      config,
      worktreeService: {} as any,
      containerService: {} as any,
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      const payload = JSON.stringify({ projectId: 'project-a', serviceId: 'mongodb', database: 'app' });
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/data-migrations/local-dump', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      });
      req.on('response', (res) => {
        res.once('data', () => {
          res.destroy();
          resolve();
        });
      });
      req.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve();
        else reject(error);
      });
      req.end(payload);
    });
    for (let attempt = 0; attempt < 20 && !spawnControl.children[0]?.kill.mock.calls.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(spawnControl.children).toHaveLength(1);
    expect(JSON.stringify([spawnControl.children[0].command, ...spawnControl.children[0].argv])).not.toContain('peer-canary-secret');
    expect(spawnControl.children[0].kill).toHaveBeenCalled();
    expect(stateService.listActiveInfraMaintenanceJobs({ projectId: 'project-a', serviceId: 'mongodb' })).toHaveLength(1);

    spawnControl.children[0].emit('close', 137);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stateService.listActiveInfraMaintenanceJobs({ projectId: 'project-a', serviceId: 'mongodb' })).toHaveLength(0);
    expect(stateService.getState().infraMaintenanceJobs?.at(-1)?.status).toBe('failed');
    expect(JSON.stringify(stateService.getState().infraMaintenanceJobs)).not.toContain('peer-canary-secret');
  });
});
