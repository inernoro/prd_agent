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
  headers: Record<string, string> = {},
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
          ...headers,
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
  app.use((req, _res, next) => {
    if (req.headers['x-test-cookie-auth'] === '1') {
      (req as any)._cdsCookieAuth = true;
    }
    if (req.headers['x-test-project-key'] === '1') {
      (req as any).cdsProjectKey = { projectId: 'prd-agent', keyId: 'test-key' };
    }
    if (req.headers['x-test-ai-session'] === '1') {
      (req as any)._aiSession = { id: 'test-ai', agentName: 'test', token: 'token', approvedAt: '', expiresAt: '' };
    }
    next();
  });
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

  it('selects an existing business MongoDB database when the configured default is missing', async () => {
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
    harness.shell.addResponsePattern(/listDatabases/, () => ({
      stdout: '[{"name":"admin","sizeOnDisk":0},{"name":"config","sizeOnDisk":0},{"name":"local","sizeOnDisk":0},{"name":"prdagent","sizeOnDisk":4096}]\n',
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
      '/api/branches/main-branch/resources/infra%3Amongo-main/data/mongo/databases',
    );

    expect(res.status).toBe(200);
    expect(res.body.configuredDatabase).toBe('app');
    expect(res.body.currentDatabase).toBe('prdagent');
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

  it('runs audited MongoDB writes with admin confirmation', async () => {
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
    harness.shell.addResponsePattern(/insertOne/, () => ({
      stdout: '{"acknowledged":true,"insertedId":"abc123"}\n',
      stderr: '',
      exitCode: 0,
    }));
    harness.shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(
      server!,
      'POST',
      '/api/branches/main-branch/resources/infra%3Amongo-main/data/mongo/write',
      {
        action: 'insertOne',
        database: 'app',
        collection: 'users',
        document: { name: 'Ada' },
        confirmResourceName: 'mongo-main',
      },
      { 'x-test-cookie-auth': '1' },
    );

    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ acknowledged: true, insertedId: 'abc123' });
    expect(harness.shell.commands.some((cmd) => cmd.includes('insertOne'))).toBe(true);
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
      undefined,
      { 'x-test-project-key': '1' },
    );

    expect(res.status).toBe(200);
    expect(res.body.connectionString).toBe('redis://:redis-secret@miduo.org:43111');
    expect(res.body.maskedConnectionString).toBe('redis://:******@miduo.org:43111');
  });

  it('expires temporary external access before returning connection strings', async () => {
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
      connectionString: 'redis://:redis-secret@miduo.org:43111',
      proxyContainerName: 'cds-ext-redis-main',
      targetHost: 'cds-redis-main',
      targetPort: 6379,
      allowlistEnforced: true,
      firewallChain: 'CDS_EXT_REDIS',
      allowlist: ['203.0.113.10/32'],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      updatedBy: 'test',
    });
    harness.shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(
      server!,
      'GET',
      '/api/branches/main-branch/resources/infra%3Aredis-main/connection-string?scope=external',
      undefined,
      { 'x-test-project-key': '1' },
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('资源尚未开启公网访问，无法生成外部连接串');
    const policy = harness.stateService.getResourceExternalAccess('prd-agent', 'main-branch', 'infra:redis-main');
    expect(policy?.enabled).toBe(false);
    expect(harness.shell.commands.some((cmd) => cmd.includes('docker rm -f') && cmd.includes('cds-ext-redis-main'))).toBe(true);
  });

  it('blocks connection string reveal for unscoped AI callers', async () => {
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
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(
      server!,
      'GET',
      '/api/branches/main-branch/resources/infra%3Aredis-main/connection-string?scope=internal',
      undefined,
      { 'x-test-ai-session': '1' },
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden_secret_reveal');
  });

  it('does not trust client-supplied resource role headers for destructive actions', async () => {
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
      env: {},
      volumes: [],
    });
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(
      server!,
      'POST',
      '/api/branches/main-branch/resources/infra%3Aredis-main/clear-data',
      { confirmResourceName: 'Redis 7' },
      { 'x-cds-resource-role': 'admin' },
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('resource_permission_denied');
    expect(res.body.role).toBe('member');
  });

  it('uses the target Mongo database as authSource for branch-created users', async () => {
    const harness = makeHarness();
    tmpDir = harness.tmpDir;
    harness.stateService.addInfraService({
      id: 'mongo-main',
      projectId: 'prd-agent',
      name: 'MongoDB 8',
      dockerImage: 'mongo:7',
      containerPort: 27017,
      hostPort: 27017,
      containerName: 'cds-mongo-main',
      status: 'running',
      dbName: 'app',
      env: {
        MONGO_INITDB_ROOT_USERNAME: 'root',
        MONGO_INITDB_ROOT_PASSWORD: 'root-pw',
      },
      volumes: [],
    });
    harness.shell.addResponsePattern(/docker exec .* mongosh /, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    harness.shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(
      server!,
      'POST',
      '/api/branches/main-branch/resources/infra%3Amongo-main/credentials/reset',
      { confirmResourceName: 'MongoDB 8' },
      { 'x-test-cookie-auth': '1' },
    );

    expect(res.status).toBe(200);
    expect(res.body.injectedEnv.MONGODB_URL).toContain('/app?authSource=app');
    expect(res.body.injectedEnv.MONGODB_AUTH_SOURCE).toBe('app');
  });

  it('uses branch Mongo authSource when reading data with branch-created users', async () => {
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
      dbName: 'shared',
      env: {
        MONGO_INITDB_ROOT_USERNAME: 'root',
        MONGO_INITDB_ROOT_PASSWORD: 'root-pw',
      },
      volumes: [],
    });
    harness.stateService.setCustomEnvVar('MONGODB_DATABASE', 'branchdb', 'main-branch');
    harness.stateService.setCustomEnvVar('MONGODB_USERNAME', 'cds_main', 'main-branch');
    harness.stateService.setCustomEnvVar('MONGODB_PASSWORD', 'branch-pw', 'main-branch');
    harness.stateService.setCustomEnvVar('MONGODB_AUTH_SOURCE', 'branchdb', 'main-branch');
    harness.shell.addResponsePattern(/mongodb:\/\/cds_main:branch-pw@localhost:27017\/branchdb\?authSource=branchdb/, () => ({
      stdout: '[{"name":"orders","type":"collection"}]\n',
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
      '/api/branches/main-branch/resources/infra%3Amongo-main/data/mongo/collections',
    );

    expect(res.status).toBe(200);
    expect(res.body.database).toBe('branchdb');
    expect(res.body.collections).toEqual([{ name: 'orders', type: 'collection' }]);
    expect(harness.shell.commands.some((cmd) => cmd.includes('/branchdb?authSource=branchdb'))).toBe(true);
  });

  it('lists Redis backups for cache resources', async () => {
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
      env: {},
      volumes: [],
    });
    harness.shell.addResponsePattern(/find .*redis-main-main-branch/, () => ({
      stdout: 'redis-main-main-branch-instance-redis-manual-20260610T000000Z.rdb\t12\t1710000000\n',
      stderr: '',
      exitCode: 0,
    }));
    harness.shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(server!, 'GET', '/api/branches/main-branch/resources/infra%3Aredis-main/backups');

    expect(res.status).toBe(200);
    expect(res.body.runtime).toBe('redis');
    expect(res.body.supported).toBe(true);
    expect(res.body.backups).toHaveLength(1);
    expect(res.body.backups[0].name).toBe('redis-main-main-branch-instance-redis-manual-20260610T000000Z.rdb');
  });

  it('rejects restoring a backup owned by another resource or branch', async () => {
    const harness = makeHarness();
    tmpDir = harness.tmpDir;
    harness.stateService.addInfraService({
      id: 'postgres-main',
      projectId: 'prd-agent',
      name: 'PostgreSQL 16',
      dockerImage: 'postgres:16',
      containerPort: 5432,
      hostPort: 5432,
      containerName: 'cds-postgres-main',
      status: 'running',
      dbName: 'app',
      env: { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'app' },
      volumes: [],
    });
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(
      server!,
      'POST',
      '/api/branches/main-branch/resources/infra%3Apostgres-main/restore-backup',
      {
        backupName: 'other-main-branch-app-postgres-manual-20260610T000000Z.sql.gz',
        confirmResourceName: 'PostgreSQL 16',
      },
      { 'x-test-cookie-auth': '1' },
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('备份文件不属于当前资源或分支');
    expect(harness.shell.commands).toHaveLength(0);
  });

  it('refuses to delete shared databases without branch-owned database env', async () => {
    const harness = makeHarness();
    tmpDir = harness.tmpDir;
    harness.stateService.addInfraService({
      id: 'mysql-main',
      projectId: 'prd-agent',
      name: 'MySQL 8',
      dockerImage: 'mysql:8',
      containerPort: 3306,
      hostPort: 3306,
      containerName: 'cds-mysql-main',
      status: 'running',
      dbName: 'shared_app',
      env: { MYSQL_ROOT_PASSWORD: 'root-pw', MYSQL_DATABASE: 'shared_app' },
      volumes: [],
    });
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(
      server!,
      'DELETE',
      '/api/branches/main-branch/resources/infra%3Amysql-main',
      { confirmResourceName: 'MySQL 8' },
      { 'x-test-cookie-auth': '1' },
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('拒绝删除共享数据库');
    expect(harness.shell.commands.some((cmd) => cmd.includes('DROP DATABASE') || cmd.includes('mysqldump'))).toBe(false);
  });

  it('describes ready workbench capability for SQL database resources', async () => {
    const harness = makeHarness();
    tmpDir = harness.tmpDir;
    harness.stateService.addInfraService({
      id: 'mysql-main',
      projectId: 'prd-agent',
      name: 'MySQL 8',
      dockerImage: 'mysql:8',
      containerPort: 3306,
      hostPort: 3306,
      containerName: 'cds-mysql-main',
      status: 'running',
      dbName: 'app',
      env: { MYSQL_ROOT_PASSWORD: 'root-pw', MYSQL_DATABASE: 'app' },
      volumes: [],
    });
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(server!, 'GET', '/api/branches/main-branch/resources/infra%3Amysql-main/workbench-capability');

    expect(res.status).toBe(200);
    expect(res.body.capability.runtimeKey).toBe('mysql');
    expect(res.body.capability.runner).toBe('sql');
    expect(res.body.capability.ready).toBe(true);
    expect(res.body.capability.resultModes).toEqual(['table', 'json', 'output']);
  });

  it('keeps PostgreSQL schema in table tree and preview queries', async () => {
    const harness = makeHarness();
    tmpDir = harness.tmpDir;
    harness.stateService.addInfraService({
      id: 'postgres-main',
      projectId: 'prd-agent',
      name: 'PostgreSQL 16',
      dockerImage: 'postgres:16',
      containerPort: 5432,
      hostPort: 5432,
      containerName: 'cds-postgres-main',
      status: 'running',
      dbName: 'app',
      env: { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'app' },
      volumes: [],
    });
    harness.shell.addResponsePattern(/information_schema\.tables/, () => ({
      stdout: 'table_schema\ttable_name\ttable_type\npublic\tusers\tBASE TABLE\naudit\tevents\tBASE TABLE\n',
      stderr: '',
      exitCode: 0,
    }));
    harness.shell.addResponsePattern(/SELECT \* FROM "audit"\."events" LIMIT 50/, () => ({
      stdout: 'id\tname\n1\tcreated\n',
      stderr: '',
      exitCode: 0,
    }));
    harness.shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const tables = await request(server!, 'GET', '/api/branches/main-branch/resources/infra%3Apostgres-main/data/tables');
    const preview = await request(server!, 'GET', '/api/branches/main-branch/resources/infra%3Apostgres-main/data/preview?schema=audit&table=events');

    expect(tables.status).toBe(200);
    expect(tables.body.tables).toEqual([
      { schema: 'public', name: 'users', fullName: 'public.users', type: 'BASE TABLE' },
      { schema: 'audit', name: 'events', fullName: 'audit.events', type: 'BASE TABLE' },
    ]);
    expect(preview.status).toBe(200);
    expect(preview.body.schema).toBe('audit');
    expect(preview.body.table).toBe('events');
    expect(harness.shell.commands.some((cmd) => cmd.includes('SELECT * FROM "audit"."events" LIMIT 50'))).toBe(true);
  });

  it('runs MySQL DDL and CRUD against the branch-selected database', async () => {
    const harness = makeHarness();
    tmpDir = harness.tmpDir;
    harness.stateService.addInfraService({
      id: 'mysql-main',
      projectId: 'prd-agent',
      name: 'MySQL 8',
      dockerImage: 'mysql:8',
      containerPort: 3306,
      hostPort: 3306,
      containerName: 'cds-mysql-main',
      status: 'running',
      dbName: 'shared_app',
      env: { MYSQL_ROOT_PASSWORD: 'root-pw', MYSQL_DATABASE: 'shared_app' },
      volumes: [],
    });
    harness.stateService.setCustomEnvVar('MYSQL_DATABASE', 'branch_app', 'main-branch');
    harness.stateService.setCustomEnvVar('MYSQL_USER', 'cds_main', 'main-branch');
    harness.stateService.setCustomEnvVar('MYSQL_PASSWORD', 'branch-pw', 'main-branch');
    harness.shell.addResponsePattern(/docker exec .* mysql /, (match) => {
      const cmd = match.input || '';
      if (cmd.includes('SELECT * FROM `cds_workbench_acceptance`')) {
        return { stdout: 'id\tname\n1\tAda\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const base = '/api/branches/main-branch/resources/infra%3Amysql-main/data';
    const headers = { 'x-test-cookie-auth': '1' };
    const confirmResourceName = 'MySQL 8';
    const create = await request(server!, 'POST', `${base}/query-write`, { sql: 'CREATE TABLE cds_workbench_acceptance (id INT PRIMARY KEY, name VARCHAR(64))', confirmResourceName }, headers);
    const insert = await request(server!, 'POST', `${base}/query-write`, { sql: "INSERT INTO cds_workbench_acceptance (id, name) VALUES (1, 'Ada')", confirmResourceName }, headers);
    const select = await request(server!, 'POST', `${base}/query`, { sql: 'SELECT * FROM `cds_workbench_acceptance`' });
    const update = await request(server!, 'POST', `${base}/query-write`, { sql: "UPDATE cds_workbench_acceptance SET name = 'Grace' WHERE id = 1", confirmResourceName }, headers);
    const remove = await request(server!, 'POST', `${base}/query-write`, { sql: 'DELETE FROM cds_workbench_acceptance WHERE id = 1', confirmResourceName }, headers);
    const drop = await request(server!, 'POST', `${base}/query-write`, { sql: 'DROP TABLE cds_workbench_acceptance', confirmResourceName }, headers);

    expect([create.status, insert.status, select.status, update.status, remove.status, drop.status]).toEqual([200, 200, 200, 200, 200, 200]);
    expect(select.body.database).toBe('branch_app');
    expect(select.body.rows).toEqual([['1', 'Ada']]);
    const mysqlCommands = harness.shell.commands.filter((cmd) => cmd.includes(' mysql '));
    expect(mysqlCommands).toHaveLength(6);
    expect(mysqlCommands.every((cmd) => cmd.includes("-u'cds_main'") && cmd.includes("-p'branch-pw'") && cmd.includes("'branch_app'"))).toBe(true);
    expect(mysqlCommands.some((cmd) => cmd.includes("'shared_app'"))).toBe(false);
  });

  it('runs PostgreSQL DDL and CRUD against the branch-selected database', async () => {
    const harness = makeHarness();
    tmpDir = harness.tmpDir;
    harness.stateService.addInfraService({
      id: 'postgres-main',
      projectId: 'prd-agent',
      name: 'PostgreSQL 16',
      dockerImage: 'postgres:16',
      containerPort: 5432,
      hostPort: 5432,
      containerName: 'cds-postgres-main',
      status: 'running',
      dbName: 'shared_pg',
      env: { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'admin-pw', POSTGRES_DB: 'shared_pg' },
      volumes: [],
    });
    harness.stateService.setCustomEnvVar('POSTGRES_DB', 'branch_pg', 'main-branch');
    harness.stateService.setCustomEnvVar('POSTGRES_USER', 'cds_main', 'main-branch');
    harness.stateService.setCustomEnvVar('POSTGRES_PASSWORD', 'branch-pw', 'main-branch');
    harness.shell.addResponsePattern(/docker exec .* psql /, (match) => {
      const cmd = match.input || '';
      if (cmd.includes('SELECT * FROM "public"."cds_workbench_acceptance"')) {
        return { stdout: 'id\tname\n1\tAda\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('CREATE TABLE')) return { stdout: 'CREATE TABLE\n', stderr: '', exitCode: 0 };
      if (cmd.includes('INSERT INTO')) return { stdout: 'INSERT 0 1\n', stderr: '', exitCode: 0 };
      if (cmd.includes('UPDATE')) return { stdout: 'UPDATE 1\n', stderr: '', exitCode: 0 };
      if (cmd.includes('DELETE FROM')) return { stdout: 'DELETE 1\n', stderr: '', exitCode: 0 };
      if (cmd.includes('DROP TABLE')) return { stdout: 'DROP TABLE\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const base = '/api/branches/main-branch/resources/infra%3Apostgres-main/data';
    const headers = { 'x-test-cookie-auth': '1' };
    const confirmResourceName = 'PostgreSQL 16';
    const create = await request(server!, 'POST', `${base}/query-write`, { sql: 'CREATE TABLE "public"."cds_workbench_acceptance" (id INT PRIMARY KEY, name TEXT)', confirmResourceName }, headers);
    const insert = await request(server!, 'POST', `${base}/query-write`, { sql: "INSERT INTO \"public\".\"cds_workbench_acceptance\" (id, name) VALUES (1, 'Ada')", confirmResourceName }, headers);
    const select = await request(server!, 'POST', `${base}/query`, { sql: 'SELECT * FROM "public"."cds_workbench_acceptance"' });
    const update = await request(server!, 'POST', `${base}/query-write`, { sql: "UPDATE \"public\".\"cds_workbench_acceptance\" SET name = 'Grace' WHERE id = 1", confirmResourceName }, headers);
    const remove = await request(server!, 'POST', `${base}/query-write`, { sql: 'DELETE FROM "public"."cds_workbench_acceptance" WHERE id = 1', confirmResourceName }, headers);
    const drop = await request(server!, 'POST', `${base}/query-write`, { sql: 'DROP TABLE "public"."cds_workbench_acceptance"', confirmResourceName }, headers);

    expect([create.status, insert.status, select.status, update.status, remove.status, drop.status]).toEqual([200, 200, 200, 200, 200, 200]);
    expect(select.body.database).toBe('branch_pg');
    expect(select.body.rows).toEqual([['1', 'Ada']]);
    const pgCommands = harness.shell.commands.filter((cmd) => cmd.includes(' psql '));
    expect(pgCommands).toHaveLength(6);
    expect(pgCommands.every((cmd) => cmd.includes("PGPASSWORD='branch-pw'") && cmd.includes("-U 'cds_main'") && cmd.includes("-d 'branch_pg'"))).toBe(true);
    expect(pgCommands.some((cmd) => cmd.includes("'shared_pg'"))).toBe(false);
  });

  it('resolves PostgreSQL service env templates before workbench queries and init SQL', async () => {
    const harness = makeHarness();
    tmpDir = harness.tmpDir;
    harness.stateService.addInfraService({
      id: 'postgres-main',
      projectId: 'prd-agent',
      name: 'PostgreSQL 16',
      dockerImage: 'postgres:16',
      containerPort: 5432,
      hostPort: 5432,
      containerName: 'cds-postgres-main',
      status: 'running',
      dbName: '${CDS_POSTGRES_DB}',
      env: {
        POSTGRES_USER: '${CDS_POSTGRES_USER}',
        POSTGRES_PASSWORD: '${CDS_POSTGRES_PASSWORD}',
        POSTGRES_DB: '${CDS_POSTGRES_DB}',
      },
      volumes: [],
    });
    harness.stateService.setCustomEnvVar('CDS_POSTGRES_USER', 'resolved_user', 'prd-agent');
    harness.stateService.setCustomEnvVar('CDS_POSTGRES_PASSWORD', 'resolved-pw', 'prd-agent');
    harness.stateService.setCustomEnvVar('CDS_POSTGRES_DB', 'resolved_db', 'prd-agent');
    harness.shell.addResponsePattern(/information_schema\.tables/, () => ({
      stdout: 'table_schema\ttable_name\ttable_type\npublic\tusers\tBASE TABLE\n',
      stderr: '',
      exitCode: 0,
    }));
    harness.shell.addResponsePattern(/printf %s .* docker exec -i -e PGPASSWORD=.* psql /, () => ({
      stdout: 'CREATE TABLE\n',
      stderr: '',
      exitCode: 0,
    }));
    harness.shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const tables = await request(server!, 'GET', '/api/branches/main-branch/resources/infra%3Apostgres-main/data/tables');
    const init = await request(
      server!,
      'POST',
      '/api/branches/main-branch/resources/infra%3Apostgres-main/data/init-sql',
      { sql: 'CREATE TABLE init_postgres (id INT PRIMARY KEY);', confirmResourceName: 'PostgreSQL 16' },
      { 'x-test-cookie-auth': '1' },
    );

    expect(tables.status).toBe(200);
    expect(tables.body.database).toBe('resolved_db');
    expect(tables.body.tables).toEqual([{ schema: 'public', name: 'users', fullName: 'public.users', type: 'BASE TABLE' }]);
    expect(init.status).toBe(200);
    expect(init.body.database).toBe('resolved_db');
    const pgCommands = harness.shell.commands.filter((cmd) => cmd.includes(' psql '));
    expect(pgCommands.length).toBeGreaterThanOrEqual(2);
    expect(pgCommands.every((cmd) => cmd.includes("PGPASSWORD='resolved-pw'") && cmd.includes("-U 'resolved_user'") && cmd.includes("-d 'resolved_db'"))).toBe(true);
    expect(pgCommands.some((cmd) => cmd.includes('${'))).toBe(false);
  });

  it('executes initialization SQL through the branch resource database, not the shared infra default', async () => {
    const harness = makeHarness();
    tmpDir = harness.tmpDir;
    harness.stateService.addInfraService({
      id: 'mysql-main',
      projectId: 'prd-agent',
      name: 'MySQL 8',
      dockerImage: 'mysql:8',
      containerPort: 3306,
      hostPort: 3306,
      containerName: 'cds-mysql-main',
      status: 'running',
      dbName: 'shared_app',
      env: { MYSQL_ROOT_PASSWORD: 'root-pw', MYSQL_DATABASE: 'shared_app' },
      volumes: [],
    });
    harness.stateService.addInfraService({
      id: 'postgres-main',
      projectId: 'prd-agent',
      name: 'PostgreSQL 16',
      dockerImage: 'postgres:16',
      containerPort: 5432,
      hostPort: 5432,
      containerName: 'cds-postgres-main',
      status: 'running',
      dbName: 'shared_pg',
      env: { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'admin-pw', POSTGRES_DB: 'shared_pg' },
      volumes: [],
    });
    harness.stateService.setCustomEnvVar('MYSQL_DATABASE', 'branch_app', 'main-branch');
    harness.stateService.setCustomEnvVar('MYSQL_USER', 'cds_main', 'main-branch');
    harness.stateService.setCustomEnvVar('MYSQL_PASSWORD', 'branch-pw', 'main-branch');
    harness.stateService.setCustomEnvVar('POSTGRES_DB', 'branch_pg', 'main-branch');
    harness.stateService.setCustomEnvVar('POSTGRES_USER', 'cds_main', 'main-branch');
    harness.stateService.setCustomEnvVar('POSTGRES_PASSWORD', 'branch-pw', 'main-branch');
    harness.shell.addResponsePattern(/printf %s .* docker exec -i .* mysql /, () => ({ stdout: 'mysql init ok\n', stderr: '', exitCode: 0 }));
    harness.shell.addResponsePattern(/printf %s .* docker exec -i -e PGPASSWORD=.* psql /, () => ({ stdout: 'postgres init ok\n', stderr: '', exitCode: 0 }));
    harness.shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const headers = { 'x-test-cookie-auth': '1' };
    const mysql = await request(
      server!,
      'POST',
      '/api/branches/main-branch/resources/infra%3Amysql-main/data/init-sql',
      { sql: 'CREATE TABLE init_mysql (id INT PRIMARY KEY);', confirmResourceName: 'MySQL 8' },
      headers,
    );
    const postgres = await request(
      server!,
      'POST',
      '/api/branches/main-branch/resources/infra%3Apostgres-main/data/init-sql',
      { sql: 'CREATE TABLE init_postgres (id INT PRIMARY KEY);', confirmResourceName: 'PostgreSQL 16' },
      headers,
    );

    expect(mysql.status).toBe(200);
    expect(mysql.body.database).toBe('branch_app');
    expect(postgres.status).toBe(200);
    expect(postgres.body.database).toBe('branch_pg');
    const mysqlInitCommand = harness.shell.commands.find((cmd) => cmd.includes('init_mysql')) || '';
    const postgresInitCommand = harness.shell.commands.find((cmd) => cmd.includes('init_postgres')) || '';
    expect(mysqlInitCommand).toContain("'branch_app'");
    expect(mysqlInitCommand).not.toContain("'shared_app'");
    expect(postgresInitCommand).toContain("-d 'branch_pg'");
    expect(postgresInitCommand).not.toContain("-d 'shared_pg'");
  });

  it('runs MongoDB workbench find command and rejects write-like commands', async () => {
    const harness = makeHarness();
    tmpDir = harness.tmpDir;
    harness.stateService.addInfraService({
      id: 'mongo-main',
      projectId: 'prd-agent',
      name: 'MongoDB 7',
      dockerImage: 'mongo:7',
      containerPort: 27017,
      hostPort: 27017,
      containerName: 'cds-mongo-main',
      status: 'running',
      dbName: 'orders',
      env: {
        MONGO_INITDB_ROOT_USERNAME: 'app',
        MONGO_INITDB_ROOT_PASSWORD: 'pw',
        MONGO_INITDB_DATABASE: 'orders',
      },
      volumes: [],
    });
    harness.shell.addResponsePattern(/getCollection\("users"\)\.find\(\{\}\)\.limit\(50\)\)\.toArray/, () => ({
      stdout: '[{"_id":"u1","name":"Ann"}]\n',
      stderr: '',
      exitCode: 0,
    }));
    harness.shell.addResponsePattern(/updateMany/, () => ({
      stdout: '{"acknowledged":true,"matchedCount":2,"modifiedCount":2}\n',
      stderr: '',
      exitCode: 0,
    }));
    harness.shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const ok = await request(
      server!,
      'POST',
      '/api/branches/main-branch/resources/infra%3Amongo-main/data/mongo/command',
      { database: 'orders', command: 'db.getCollection("users").find({}).limit(50);' },
    );
    // 定点写：带写权限 + 资源名确认 → 200 + write-result
    const write = await request(
      server!,
      'POST',
      '/api/branches/main-branch/resources/infra%3Amongo-main/data/mongo/command',
      { database: 'orders', command: 'db.getCollection("users").updateMany({ active: false }, { $set: { archived: true } });', confirmResourceName: 'mongo-main' },
      { 'x-test-cookie-auth': '1' },
    );
    // 定点写但缺资源名确认 → 409
    const writeNoConfirm = await request(
      server!,
      'POST',
      '/api/branches/main-branch/resources/infra%3Amongo-main/data/mongo/command',
      { database: 'orders', command: 'db.getCollection("users").updateMany({ active: false }, { $set: { archived: true } });' },
      { 'x-test-cookie-auth': '1' },
    );
    // 高危操作（drop）：无论权限一律 400 拦截
    const rejected = await request(
      server!,
      'POST',
      '/api/branches/main-branch/resources/infra%3Amongo-main/data/mongo/command',
      { database: 'orders', command: 'db.getCollection("users").drop();' },
      { 'x-test-cookie-auth': '1' },
    );

    expect(ok.status).toBe(200);
    expect(ok.body.collection).toBe('users');
    expect(ok.body.kind).toBe('documents');
    expect(ok.body.documents).toEqual([{ _id: 'u1', name: 'Ann' }]);
    expect(write.status).toBe(200);
    expect(write.body.kind).toBe('write-result');
    expect(write.body.isWrite).toBe(true);
    expect(write.body.documents).toEqual([{ acknowledged: true, matchedCount: 2, modifiedCount: 2 }]);
    expect(writeNoConfirm.status).toBe(409);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain('高危操作');
  });

  it('describes planned workbench capability for SQL Server and RabbitMQ resources', async () => {
    const harness = makeHarness();
    tmpDir = harness.tmpDir;
    harness.stateService.addInfraService({
      id: 'mssql-main',
      projectId: 'prd-agent',
      name: 'SQL Server',
      dockerImage: 'mcr.microsoft.com/mssql/server:2022-latest',
      containerPort: 1433,
      hostPort: 1433,
      containerName: 'cds-mssql-main',
      status: 'running',
      dbName: 'app',
      env: { ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: 'pw' },
      volumes: [],
    });
    harness.stateService.addInfraService({
      id: 'rabbit-main',
      projectId: 'prd-agent',
      name: 'RabbitMQ',
      dockerImage: 'rabbitmq:3-management',
      containerPort: 5672,
      hostPort: 5672,
      containerName: 'cds-rabbit-main',
      status: 'running',
      env: {},
      volumes: [],
    });
    await new Promise<void>((resolve) => {
      server = harness.app.listen(0, '127.0.0.1', resolve);
    });

    const sqlServer = await request(server!, 'GET', '/api/branches/main-branch/resources/infra%3Amssql-main/workbench-capability');
    const rabbit = await request(server!, 'GET', '/api/branches/main-branch/resources/infra%3Arabbit-main/workbench-capability');

    expect(sqlServer.status).toBe(200);
    expect(sqlServer.body.capability.runtimeKey).toBe('sqlserver');
    expect(sqlServer.body.capability.runtime).toBe('sql');
    expect(sqlServer.body.capability.runner).toBe('planned');
    expect(sqlServer.body.capability.defaultCommand).toContain('SELECT TOP 50');

    expect(rabbit.status).toBe(200);
    expect(rabbit.body.capability.runtimeKey).toBe('rabbitmq');
    expect(rabbit.body.capability.runtime).toBe('queue');
    expect(rabbit.body.capability.runner).toBe('planned');
    expect(rabbit.body.capability.treeLabel).toContain('queue');
  });
});
