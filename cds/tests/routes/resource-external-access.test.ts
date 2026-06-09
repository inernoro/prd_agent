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

describe('resource external TCP access', () => {
  let server: http.Server | null = null;
  let tmpDir = '';

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
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
    app.use('/api', createBranchRouter({ stateService, worktreeService, containerService, shell, config }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    const res = await request(
      server!,
      'PUT',
      '/api/branches/main-branch/resources/infra%3Amysql-main/external-access',
      { enabled: true, ttlMinutes: 120, allowlist: ['203.0.113.10'] },
    );

    expect(res.status).toBe(200);
    expect(res.body.policy.enabled).toBe(true);
    expect(res.body.policy.kind).toBe('tcp');
    expect(res.body.policy.address).toMatch(/^tcp:\/\/miduo\.org:/);
    expect(res.body.policy.connectionString).toMatch(/^mysql:\/\/cds:\*\*\*\*\*\*@miduo\.org:/);
    expect(res.body.policy.proxyContainerName).toMatch(/^cds-ext-/);
    expect(res.body.policy.targetHost).toBe('cds-mysql-main');
    expect(res.body.policy.targetPort).toBe(3306);
    expect(res.body.policy.allowlist).toEqual(['203.0.113.10/32']);
    expect(res.body.policy.allowlistEnforced).toBe(true);
    expect(res.body.resource.externalAccess.allowlistEnforced).toBe(true);
    expect(res.body.resource.connectionString).toBe(res.body.policy.connectionString);

    const joined = shell.commands.join('\n');
    expect(joined).toContain('docker run -d');
    expect(joined).toContain('cds.type=resource-external-access');
    expect(joined).toContain('-p 0.0.0.0:');
    expect(joined).toContain('iptables -N CDS_EXT_');
    expect(joined).toContain('iptables -A CDS_EXT_');
    expect(joined).toContain('-s 203.0.113.10/32 -j ACCEPT');
    expect(joined).toContain('-j DROP');
    expect(joined).toContain('iptables -I DOCKER-USER 1 -p tcp -m conntrack --ctorigdstport');
  });
});
