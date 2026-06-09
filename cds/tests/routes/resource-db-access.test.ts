import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BranchEntry, CdsConfig } from '../../src/types.js';

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode!, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeHarness(): {
  tmpDir: string;
  config: CdsConfig;
  stateService: StateService;
  shell: MockShellExecutor;
  app: express.Express;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-resource-db-'));
  const config: CdsConfig = {
    repoRoot: tmpDir,
    worktreeBase: path.join(tmpDir, 'worktrees'),
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds-network',
    portStart: 10001,
    sharedEnv: {},
    rootDomains: ['miduo.org'],
    jwt: { secret: 'test-secret', issuer: 'cds' },
  };
  fs.mkdirSync(config.worktreeBase, { recursive: true });
  const stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
  stateService.load();
  const now = new Date().toISOString();
  stateService.addProject({
    id: 'prd-agent',
    slug: 'prd-agent',
    name: 'prd_agent',
    kind: 'git',
    dockerNetwork: 'cds-proj-prd-agent',
    legacyFlag: false,
    createdAt: now,
    updatedAt: now,
  });
  const branch: BranchEntry = {
    id: 'main-branch',
    projectId: 'prd-agent',
    branch: 'main',
    worktreePath: path.join(tmpDir, 'worktrees/main'),
    status: 'running',
    createdAt: now,
    lastDeployAt: now,
    services: {},
  };
  stateService.addBranch(branch);
  const shell = new MockShellExecutor();
  const worktreeService = new WorktreeService(shell);
  const containerService = new ContainerService(shell, config, {
    getDockerNetwork: () => 'cds-proj-prd-agent',
    getProjectSlug: () => 'prd-agent',
  });
  const app = express();
  app.use(express.json());
  app.use('/api', createBranchRouter({ stateService, worktreeService, containerService, shell, config }));
  return { tmpDir, config, stateService, shell, app };
}

describe('resource database access', () => {
  let server: http.Server | null = null;
  let tmpDir = '';

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('queries MongoDB collections against the selected database', async () => {
    const harness = makeHarness();
    tmpDir = harness.tmpDir;
    harness.stateService.addInfraService({
      id: 'mongo-main',
      projectId: 'prd-agent',
      name: 'mongo-main',
      dockerImage: 'mongo:7',
      containerPort: 27017,
      hostPort: 27017,
      containerName: 'cds-mongo-main',
      status: 'running',
      dbName: 'app',
      env: {
        MONGO_INITDB_ROOT_USERNAME: 'app',
        MONGO_INITDB_ROOT_PASSWORD: 'pw',
        MONGO_INITDB_DATABASE: 'app',
      },
      volumes: [],
    });
    harness.shell.addResponsePattern(/mongosh 'mongodb:\/\/app:pw@localhost:27017\/orders\?authSource=admin'/, () => ({
      stdout: '[{"name":"users","type":"collection"}]\n',
      stderr: '',
      exitCode: 0,
    }));
    harness.shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(
      server!,
      'GET',
      '/api/branches/main-branch/resources/infra%3Amongo-main/data/mongo/collections?database=orders',
    );

    expect(res.status).toBe(200);
    expect(res.body.database).toBe('orders');
    expect(res.body.collections).toEqual([{ name: 'users', type: 'collection' }]);
    expect(harness.shell.commands.some((cmd) => cmd.includes('/orders?authSource=admin'))).toBe(true);
  });

  it('returns a usable Redis external connection string with the real password', async () => {
    const harness = makeHarness();
    tmpDir = harness.tmpDir;
    harness.stateService.addInfraService({
      id: 'redis-main',
      projectId: 'prd-agent',
      name: 'redis-main',
      dockerImage: 'redis:7',
      containerPort: 6379,
      hostPort: 6379,
      containerName: 'cds-redis-main',
      status: 'running',
      env: { REDIS_PASSWORD: 'redis-secret' },
      volumes: [],
    });
    harness.stateService.upsertResourceExternalAccess({
      projectId: 'prd-agent',
      branchId: 'main-branch',
      resourceId: 'infra:redis-main',
      enabled: true,
      kind: 'tcp',
      address: 'tcp://miduo.org:43111',
      host: 'miduo.org',
      port: 43111,
      allowlist: ['203.0.113.10/32'],
      allowlistEnforced: true,
      updatedBy: 'test',
    });
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(
      server!,
      'GET',
      '/api/branches/main-branch/resources/infra%3Aredis-main/connection-string?scope=external',
    );

    expect(res.status).toBe(200);
    expect(res.body.connectionString).toBe('redis://:redis-secret@miduo.org:43111');
    expect(res.body.maskedConnectionString).toBe('redis://:******@miduo.org:43111');
  });
});
