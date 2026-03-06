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
import { ProxyService } from '../../src/services/proxy.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig } from '../../src/types.js';

function makeConfig(tmpDir: string): CdsConfig {
  return {
    repoRoot: tmpDir,
    worktreeBase: path.join(tmpDir, 'worktrees'),
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds-network',
    portStart: 10001,
    sharedEnv: { MONGODB_HOST: 'db:27017' },
    jwt: { secret: 'test-secret', issuer: 'prdagent' },
  };
}

async function request(
  server: http.Server, method: string, urlPath: string, body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-routes-'));
    const config = makeConfig(tmpDir);
    mock = new MockShellExecutor();

    // Default mocks
    mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git worktree add/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git worktree remove/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git worktree prune/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/test -d/, () => ({ stdout: '', stderr: '', exitCode: 1 }));
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid123', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker inspect/, () => ({ stdout: 'true', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker logs/, () => ({ stdout: 'log output', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git log --oneline/, () => ({ stdout: 'abc1234 some commit', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git rev-parse/, () => ({ stdout: 'abc1234', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git reset --hard/, () => ({ stdout: 'HEAD is now at abc1234', stderr: '', exitCode: 0 }));

    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();

    const worktreeService = new WorktreeService(mock, config.repoRoot);
    const containerService = new ContainerService(mock, config);
    const proxyService = new ProxyService(stateService);

    const app = express();
    app.use(express.json());
    app.use('/api', createBranchRouter({
      stateService, worktreeService, containerService, proxyService, shell: mock, config,
    }));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  // ── Remote branches ──

  describe('GET /api/remote-branches', () => {
    it('should return list of remote branches', async () => {
      const SEP = '<SEP>';
      mock.addResponsePattern(/git for-each-ref/, () => ({
        stdout: [`main${SEP}2026-02-12${SEP}Dev${SEP}msg`, `feature/ui${SEP}2026-02-12${SEP}Dev${SEP}msg`].join('\n'),
        stderr: '', exitCode: 0,
      }));

      const res = await request(server, 'GET', '/api/remote-branches');
      expect(res.status).toBe(200);
      const body = res.body as { branches: Array<{ name: string }> };
      expect(body.branches.map(b => b.name)).toEqual(['main', 'feature/ui']);
    });
  });

  // ── Branch CRUD ──

  describe('POST /api/branches', () => {
    it('should add a new branch', async () => {
      const res = await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      expect(res.status).toBe(201);
      expect((res.body as any).branch.id).toBe('feature-test');
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

  describe('GET /api/branches', () => {
    it('should return empty branches initially', async () => {
      const res = await request(server, 'GET', '/api/branches');
      expect(res.status).toBe(200);
      expect((res.body as any).branches).toEqual([]);
      expect((res.body as any).defaultBranch).toBeNull();
    });

    it('should return added branches', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'main' });
      const res = await request(server, 'GET', '/api/branches');
      expect((res.body as any).branches).toHaveLength(1);
      expect((res.body as any).branches[0].id).toBe('main');
    });
  });

  describe('POST /api/branches/:id/pull', () => {
    it('should pull latest code', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'POST', '/api/branches/feature-test/pull');
      expect(res.status).toBe(200);
      expect((res.body as any).head).toBeDefined();
    });

    it('should return 404 for unknown branch', async () => {
      const res = await request(server, 'POST', '/api/branches/nope/pull');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/branches/:id/stop', () => {
    it('should stop all services', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'POST', '/api/branches/feature-test/stop');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/branches/:id/set-default', () => {
    it('should set default branch', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'main' });
      const res = await request(server, 'POST', '/api/branches/main/set-default');
      expect(res.status).toBe(200);

      const list = await request(server, 'GET', '/api/branches');
      expect((list.body as any).defaultBranch).toBe('main');
    });
  });

  describe('POST /api/branches/:id/reset', () => {
    it('should reset error status to idle', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const branch = stateService.getBranch('feature-test')!;
      branch.status = 'error';
      branch.errorMessage = 'build failed';
      stateService.save();

      const res = await request(server, 'POST', '/api/branches/feature-test/reset');
      expect(res.status).toBe(200);

      const list = await request(server, 'GET', '/api/branches');
      expect((list.body as any).branches[0].status).toBe('idle');
    });
  });

  // ── Routing rules ──

  describe('routing rules CRUD', () => {
    it('should create and list rules', async () => {
      const rule = { id: 'r1', name: 'Test', type: 'domain', match: '*.dev.com', branch: 'main', priority: 0, enabled: true };
      const createRes = await request(server, 'POST', '/api/routing-rules', rule);
      expect(createRes.status).toBe(201);

      const listRes = await request(server, 'GET', '/api/routing-rules');
      expect((listRes.body as any).rules).toHaveLength(1);
    });

    it('should update and delete rules', async () => {
      await request(server, 'POST', '/api/routing-rules', { id: 'r1', name: 'T', type: 'domain', match: 'a', branch: 'b' });
      await request(server, 'PUT', '/api/routing-rules/r1', { enabled: false });

      let list = await request(server, 'GET', '/api/routing-rules');
      expect((list.body as any).rules[0].enabled).toBe(false);

      await request(server, 'DELETE', '/api/routing-rules/r1');
      list = await request(server, 'GET', '/api/routing-rules');
      expect((list.body as any).rules).toHaveLength(0);
    });
  });

  // ── Build profiles ──

  describe('build profiles CRUD', () => {
    it('should create and list profiles', async () => {
      const profile = { id: 'api', name: 'API', dockerImage: 'dotnet:8', runCommand: 'dotnet run', workDir: '.', containerPort: 8080 };
      const createRes = await request(server, 'POST', '/api/build-profiles', profile);
      expect(createRes.status).toBe(201);

      const listRes = await request(server, 'GET', '/api/build-profiles');
      expect((listRes.body as any).profiles).toHaveLength(1);
    });

    it('should delete profiles', async () => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'x', runCommand: 'x' });
      await request(server, 'DELETE', '/api/build-profiles/api');

      const list = await request(server, 'GET', '/api/build-profiles');
      expect((list.body as any).profiles).toHaveLength(0);
    });
  });

  // ── Config ──

  describe('GET /api/config', () => {
    it('should return masked config', async () => {
      const res = await request(server, 'GET', '/api/config');
      expect(res.status).toBe(200);
      expect((res.body as any).jwt.secret).toBe('***');
    });
  });

  // ── Logs ──

  describe('GET /api/branches/:id/logs', () => {
    it('should return empty logs for new branch', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'GET', '/api/branches/feature-test/logs');
      expect(res.status).toBe(200);
      expect((res.body as any).logs).toEqual([]);
    });
  });
});
