import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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

import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
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

describe('resource external TCP access', () => {
  let server: http.Server | null = null;
  let tmpDir = '';

  beforeEach(() => {
    vi.stubEnv('CDS_RESOURCE_TCP_ENABLED', '1');
    vi.stubEnv('CDS_RESOURCE_TCP_HOST', '192.0.2.20');
    vi.stubEnv('CDS_RESOURCE_TCP_BIND_IP', '192.0.2.20');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await flushAllJsonStateStores();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('starts a managed TCP proxy and applies iptables allowlist before persisting policy', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-resource-ext-'));
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
    stateService.addBuildProfile({
      id: 'web',
      projectId: 'prd-agent',
      name: 'web',
      dockerImage: 'node:20',
      containerPort: 3000,
      dependsOn: ['infra:mysql-main'],
    });
    stateService.addInfraService({
      id: 'mysql-main',
      projectId: 'prd-agent',
      name: 'mysql-main',
      dockerImage: 'mysql:8',
      containerPort: 3306,
      hostPort: 3306,
      containerName: 'cds-mysql-main',
      status: 'running',
      dbName: 'main_branch',
      env: { MYSQL_USER: 'cds', MYSQL_DATABASE: 'main_branch' },
      volumes: [],
    });
    const branch: BranchEntry = {
      id: 'main-branch',
      projectId: 'prd-agent',
      branch: 'main',
      worktreePath: path.join(tmpDir, 'worktrees/main'),
      status: 'running',
      createdAt: now,
      lastDeployAt: now,
      services: {
        web: {
          profileId: 'web',
          containerName: 'cds-main-web',
          hostPort: 3000,
          status: 'running',
        },
      },
    };
    stateService.addBranch(branch);

    const shell = new MockShellExecutor();
    shell.addResponse('ss -H -ltn', { stdout: '', stderr: '', exitCode: 0 });
    shell.addResponse('docker inspect --format="{{.State.Running}}" cds-mysql-main', { stdout: 'true\n', stderr: '', exitCode: 0 });
    shell.addResponsePattern(/^iptables -C DOCKER-USER /, () => ({ stdout: '', stderr: 'not found', exitCode: 1 }));
    shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
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
        (req as any)._cdsBasicHumanAuth = true;
        (req as any).cdsUser = { username: 'owner', isSystemOwner: true, authProvider: 'legacy' };
      }
      next();
    });
    app.use('/api', createBranchRouter({ stateService, worktreeService, containerService, shell, config }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    const endpoint = '/api/branches/main-branch/resources/infra%3Amysql-main/external-access';
    const valid = { enabled: true, ttlMinutes: 120, allowlist: ['203.0.113.10'] };
    expect((await request(server!, 'PUT', endpoint, valid)).status).toBe(403);
    for (const body of [{ ...valid, ttlMinutes: 0 }, { ...valid, ttlMinutes: 1441 }, { ...valid, ttlMinutes: 1.5 }, { ...valid, allowlist: ['0.0.0.0/0'] }, { ...valid, allowlist: ['203.0.113.10/32/1'] }]) {
      expect((await request(server!, 'PUT', endpoint, body, { 'x-test-cookie-auth': '1' })).status).toBe(400);
    }
    vi.stubEnv('CDS_RESOURCE_TCP_ENABLED', '0');
    expect((await request(server!, 'PUT', endpoint, valid, { 'x-test-cookie-auth': '1' })).status).toBe(409);
    vi.stubEnv('CDS_RESOURCE_TCP_ENABLED', '1');
    expect(shell.commands.some((cmd) => cmd.startsWith('docker run -d'))).toBe(false);

    const res = await request(
      server!,
      'PUT',
      '/api/branches/main-branch/resources/infra%3Amysql-main/external-access',
      { enabled: true, ttlMinutes: 120, allowlist: ['203.0.113.10'] },
      { 'x-test-cookie-auth': '1' },
    );

    expect(res.status).toBe(200);
    expect(res.body.policy.allowlistEnforced).toBe(true);
    expect(res.body.policy.host).toBe('192.0.2.20');
    expect(shell.commands.find((cmd) => cmd.startsWith('docker run -d'))).toContain('-p 192.0.2.20:43000:15432');
    expect(shell.commands.find((cmd) => cmd.startsWith('docker run -d'))).toContain('EXPIRES_AT=');
    const expiredPolicy = stateService.upsertResourceExternalAccess({ ...res.body.policy, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await request(server!, 'GET', '/api/branches/main-branch/resources/infra%3Amysql-main/connection-string?scope=external', undefined, { 'x-test-cookie-auth': '1' });
    expect(expired.status).toBe(409);
    expect(stateService.getResourceExternalAccess('prd-agent', 'main-branch', 'infra:mysql-main')?.enabled).toBe(false);
    expect(shell.commands.some((cmd) => cmd.startsWith('docker rm -f') && cmd.includes(expiredPolicy.proxyContainerName!))).toBe(true);
    shell.addResponse(`iptables -F ${expiredPolicy.firewallChain}`, { stdout: '', stderr: 'permission denied', exitCode: 1 });
    const failedFirewall = await request(server!, 'PUT', endpoint, valid, { 'x-test-cookie-auth': '1' });
    expect(failedFirewall.status).toBe(500);
    expect(shell.commands.filter((cmd) => cmd.startsWith('docker run -d'))).toHaveLength(1);
    expect(stateService.getResourceExternalAccess('prd-agent', 'main-branch', 'infra:mysql-main')?.enabled).toBe(false);

  });

  it('reuses the resource own external port when updating an already-enabled policy (#805)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-resource-ext-'));
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
    stateService.addInfraService({
      id: 'mysql-main',
      projectId: 'prd-agent',
      name: 'mysql-main',
      dockerImage: 'mysql:8',
      containerPort: 3306,
      hostPort: 3306,
      containerName: 'cds-mysql-main',
      status: 'running',
      dbName: 'main_branch',
      env: { MYSQL_USER: 'cds', MYSQL_DATABASE: 'main_branch' },
      volumes: [],
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
    stateService.upsertResourceExternalAccess({
      projectId: 'prd-agent',
      branchId: 'main-branch',
      resourceId: 'infra:mysql-main',
      enabled: true,
      kind: 'tcp',
      address: 'tcp://miduo.org:43111',
      host: 'miduo.org',
      port: 43111,
      connectionString: 'mysql://cds:old@miduo.org:43111/main_branch',
      proxyContainerName: 'old-proxy',
      targetHost: 'cds-mysql-main',
      targetPort: 3306,
      allowlistEnforced: true,
      firewallChain: 'CDS_EXT_OLD',
      allowlist: ['203.0.113.10/32'],
      updatedBy: 'test',
    });

    const shell = new MockShellExecutor();
    shell.addResponse('ss -H -ltn', {
      stdout: 'LISTEN 0 4096 0.0.0.0:43111 0.0.0.0:*\n',
      stderr: '',
      exitCode: 0,
    });
    shell.addResponse('docker inspect --format="{{.State.Running}}" cds-mysql-main', { stdout: 'true\n', stderr: '', exitCode: 0 });
    shell.addResponsePattern(/^iptables -C DOCKER-USER /, () => ({ stdout: '', stderr: 'not found', exitCode: 1 }));
    shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
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
        (req as any)._cdsBasicHumanAuth = true;
        (req as any).cdsUser = { username: 'owner', isSystemOwner: true, authProvider: 'legacy' };
      }
      next();
    });
    app.use('/api', createBranchRouter({ stateService, worktreeService, containerService, shell, config }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(
      server!,
      'PUT',
      '/api/branches/main-branch/resources/infra%3Amysql-main/external-access',
      { enabled: true, ttlMinutes: 120, allowlist: ['203.0.113.10'] },
      { 'x-test-cookie-auth': '1' },
    );

    expect(res.status).toBe(200);
    expect(res.body.policy.port).toBe(43111);
    expect(shell.commands.find((cmd) => cmd.startsWith('docker run -d'))).toContain('-p 192.0.2.20:43111:15432');
  });

  it('rejects enabling public TCP access without an allowlist', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-resource-ext-'));
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
    stateService.addInfraService({
      id: 'mysql-main',
      projectId: 'prd-agent',
      name: 'mysql-main',
      dockerImage: 'mysql:8',
      containerPort: 3306,
      hostPort: 3306,
      containerName: 'cds-mysql-main',
      status: 'running',
      dbName: 'main_branch',
      env: { MYSQL_USER: 'cds', MYSQL_DATABASE: 'main_branch' },
      volumes: [],
    });
    stateService.addBranch({
      id: 'main-branch',
      projectId: 'prd-agent',
      branch: 'main',
      worktreePath: path.join(tmpDir, 'worktrees/main'),
      status: 'running',
      createdAt: now,
      lastDeployAt: now,
      services: {},
    });
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
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
        (req as any)._cdsBasicHumanAuth = true;
        (req as any).cdsUser = { username: 'owner', isSystemOwner: true, authProvider: 'legacy' };
      }
      next();
    });
    app.use('/api', createBranchRouter({ stateService, worktreeService, containerService, shell, config }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(
      server!,
      'PUT',
      '/api/branches/main-branch/resources/infra%3Amysql-main/external-access',
      { enabled: true, ttlMinutes: 120, allowlist: [] },
      { 'x-test-cookie-auth': '1' },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('allowlist');
    expect(shell.commands.some((cmd) => cmd.startsWith('docker run -d'))).toBe(false);
  });
});
