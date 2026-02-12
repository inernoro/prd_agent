import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { SwitcherService } from '../../src/services/switcher.js';
import { BuilderService } from '../../src/services/builder.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BtConfig } from '../../src/types.js';

function makeConfig(tmpDir: string): BtConfig {
  return {
    repoRoot: '/repo',
    worktreeBase: path.join(tmpDir, 'worktrees'),
    deployDir: 'deploy',
    gateway: { containerName: 'prdagent-gateway', port: 5500 },
    docker: {
      network: 'prdagent-network',
      apiDockerfile: 'prd-api/Dockerfile',
      apiImagePrefix: 'prdagent-server',
      containerPrefix: 'prdagent-api',
    },
    mongodb: { containerHost: 'mongodb', port: 27017, defaultDbName: 'prdagent' },
    redis: { connectionString: 'redis:6379' },
    jwt: { secret: 'test-secret', issuer: 'prdagent' },
    dashboard: { port: 9900 },
  };
}

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode!, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('Branch Routes', () => {
  let tmpDir: string;
  let server: http.Server;
  let mock: MockShellExecutor;
  let stateService: StateService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-routes-'));
    const config = makeConfig(tmpDir);
    mock = new MockShellExecutor();

    // Default mock responses for common operations
    mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git worktree add/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git worktree remove/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git ls-remote/, () => ({
      stdout: 'abc123\trefs/heads/feature/test\n',
      stderr: '',
      exitCode: 0,
    }));
    mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid123', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rmi/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker inspect/, () => ({ stdout: 'true', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker build/, () => ({ stdout: 'built', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker exec.*nginx -t/, () => ({ stdout: '', stderr: 'ok', exitCode: 0 }));
    mock.addResponsePattern(/docker exec.*nginx -s reload/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/pnpm install/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/pnpm build/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/cp -r/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/rsync/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();

    const nginxConfPath = path.join(tmpDir, 'nginx.conf');
    fs.writeFileSync(nginxConfPath, 'original');
    const distPath = path.join(tmpDir, 'dist');
    fs.mkdirSync(distPath);

    const worktreeService = new WorktreeService(mock, config.repoRoot);
    const containerService = new ContainerService(mock, config);
    const switcherService = new SwitcherService(mock, {
      nginxConfPath,
      distPath,
      gatewayContainerName: config.gateway.containerName,
    });
    const builderService = new BuilderService(mock, config);

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createBranchRouter({
        stateService,
        worktreeService,
        containerService,
        switcherService,
        builderService,
        config,
      }),
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  describe('GET /api/branches', () => {
    it('should return empty branches initially', async () => {
      const res = await request(server, 'GET', '/api/branches');
      expect(res.status).toBe(200);
      const body = res.body as { branches: object; activeBranchId: null };
      expect(body.branches).toEqual({});
      expect(body.activeBranchId).toBeNull();
    });
  });

  describe('POST /api/branches', () => {
    it('should add a new branch', async () => {
      const res = await request(server, 'POST', '/api/branches', {
        branch: 'feature/test',
      });
      expect(res.status).toBe(201);
      const body = res.body as { branch: { id: string; branch: string } };
      expect(body.branch.id).toBe('feature-test');
      expect(body.branch.branch).toBe('feature/test');
    });

    it('should return 400 if branch name missing', async () => {
      const res = await request(server, 'POST', '/api/branches', {});
      expect(res.status).toBe(400);
    });

    it('should return 409 if branch already exists', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      expect(res.status).toBe(409);
    });
  });

  describe('POST /api/branches/:id/start', () => {
    it('should start a branch container', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'POST', '/api/branches/feature-test/start');
      expect(res.status).toBe(200);
    });

    it('should return 404 for unknown branch', async () => {
      const res = await request(server, 'POST', '/api/branches/nope/start');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/branches/:id/stop', () => {
    it('should stop a branch container', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      await request(server, 'POST', '/api/branches/feature-test/start');
      const res = await request(server, 'POST', '/api/branches/feature-test/stop');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/branches/:id/activate', () => {
    it('should activate a running branch', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      await request(server, 'POST', '/api/branches/feature-test/start');
      const res = await request(server, 'POST', '/api/branches/feature-test/activate');
      expect(res.status).toBe(200);
      const body = res.body as { activeBranchId: string };
      expect(body.activeBranchId).toBe('feature-test');
    });

    it('should return 400 if branch not running', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      // Override docker inspect to return false for this test
      mock.addResponse(
        `docker inspect --format="{{.State.Running}}" prdagent-api-feature-test`,
        { stdout: 'false', stderr: '', exitCode: 0 },
      );
      const res = await request(server, 'POST', '/api/branches/feature-test/activate');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/rollback', () => {
    it('should rollback to previous branch', async () => {
      // Setup two branches
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      await request(server, 'POST', '/api/branches/feature-test/start');
      await request(server, 'POST', '/api/branches/feature-test/activate');

      // Manually add a second branch and activate it
      stateService.addBranch({
        id: 'branch-b',
        branch: 'branch/b',
        worktreePath: '/tmp/b',
        containerName: 'prdagent-api-branch-b',
        imageName: 'prdagent-server:branch-b',
        dbName: 'prdagent_2',
        status: 'running',
        createdAt: new Date().toISOString(),
      });
      stateService.activate('branch-b');
      stateService.save();

      const res = await request(server, 'POST', '/api/rollback');
      expect(res.status).toBe(200);
      const body = res.body as { activeBranchId: string };
      expect(body.activeBranchId).toBe('feature-test');
    });

    it('should return 400 if no history', async () => {
      const res = await request(server, 'POST', '/api/rollback');
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/branches/:id', () => {
    it('should delete a branch', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'DELETE', '/api/branches/feature-test');
      expect(res.status).toBe(200);

      const listRes = await request(server, 'GET', '/api/branches');
      const body = listRes.body as { branches: object };
      expect(Object.keys(body.branches)).toHaveLength(0);
    });
  });

  describe('GET /api/history', () => {
    it('should return activation history', async () => {
      const res = await request(server, 'GET', '/api/history');
      expect(res.status).toBe(200);
      const body = res.body as { history: string[] };
      expect(body.history).toEqual([]);
    });
  });
});
