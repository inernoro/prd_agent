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
    repoRoot: tmpDir,
    worktreeBase: path.join(tmpDir, 'worktrees'),
    deployDir: 'deploy',
    gateway: { containerName: 'prdagent-gateway', port: 5500 },
    docker: {
      network: 'prdagent-network',
      apiDockerfile: 'prd-api/Dockerfile',
      apiImagePrefix: 'prdagent-server',
      containerPrefix: 'prdagent-api',
    },
    mongodb: { containerHost: 'prdagent-mongodb', port: 27017, defaultDbName: 'prdagent' },
    redis: { connectionString: 'prdagent-redis:6379' },
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
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network create/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
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
    mock.addResponsePattern(/git log --oneline/, () => ({ stdout: 'abc1234 some commit', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git rev-parse/, () => ({ stdout: 'abc1234', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/curl/, () => ({
      stdout: '{"commit":"abc1234","branch":"feature/test","builtAt":"2026-02-12T00:00:00Z"}',
      stderr: '',
      exitCode: 0,
    }));

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
        shell: mock,
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

  describe('GET /api/remote-branches', () => {
    const SEP = '<SEP>';
    const makeRefLine = (name: string, author = 'Dev') =>
      `${name}${SEP}2026-02-12 10:00:00 +0800${SEP}${author}${SEP}commit msg`;

    it('should return list of remote branches', async () => {
      mock.addResponsePattern(/git for-each-ref/, () => ({
        stdout: [
          makeRefLine('main'),
          makeRefLine('feature/new-ui'),
          makeRefLine('hotfix/bug-123'),
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }));

      const res = await request(server, 'GET', '/api/remote-branches');
      expect(res.status).toBe(200);
      const body = res.body as { branches: Array<{ name: string }> };
      const names = body.branches.map((b) => b.name);
      expect(names).toEqual(['main', 'feature/new-ui', 'hotfix/bug-123']);
    });

    it('should exclude already-added branches', async () => {
      mock.addResponsePattern(/git for-each-ref/, () => ({
        stdout: [makeRefLine('main'), makeRefLine('feature/test')].join('\n'),
        stderr: '',
        exitCode: 0,
      }));
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });

      const res = await request(server, 'GET', '/api/remote-branches');
      const body = res.body as { branches: Array<{ name: string }> };
      expect(body.branches.map((b) => b.name)).toEqual(['main']);
    });

    it('should return 502 when git for-each-ref fails', async () => {
      mock.addResponsePattern(/git for-each-ref/, () => ({
        stdout: '',
        stderr: 'fatal: not a git repository',
        exitCode: 128,
      }));

      const res = await request(server, 'GET', '/api/remote-branches');
      expect(res.status).toBe(502);
    });
  });

  describe('POST /api/branches/:id/deploy (one-click)', () => {
    it('should build + start + activate in one call', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'POST', '/api/branches/feature-test/deploy');
      expect(res.status).toBe(200);

      const list = await request(server, 'GET', '/api/branches');
      const body = list.body as any;
      expect(body.branches['feature-test'].status).toBe('running');
      expect(body.activeBranchId).toBe('feature-test');
    });

    it('should skip build if already built, just start + activate', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      await request(server, 'POST', '/api/branches/feature-test/build');

      const res = await request(server, 'POST', '/api/branches/feature-test/deploy');
      expect(res.status).toBe(200);

      // docker build should NOT be called again (only once from the explicit build)
      const buildCalls = mock.commands.filter(c => c.includes('docker build'));
      expect(buildCalls).toHaveLength(1);
    });

    it('should skip build+start if already running, just activate', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      await request(server, 'POST', '/api/branches/feature-test/build');
      await request(server, 'POST', '/api/branches/feature-test/start');

      const res = await request(server, 'POST', '/api/branches/feature-test/deploy');
      expect(res.status).toBe(200);

      // SSE response is not JSON — verify state via GET
      const list = await request(server, 'GET', '/api/branches');
      expect((list.body as any).activeBranchId).toBe('feature-test');
    });
  });

  describe('POST /api/branches/:id/deploy (SSE streaming)', () => {
    it('should stream build log chunks during deploy', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });

      // Perform deploy and collect raw SSE text
      const addr = server.address() as { port: number };
      const raw: string = await new Promise((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port: addr.port, path: '/api/branches/feature-test/deploy', method: 'POST',
            headers: { 'Content-Type': 'application/json' } },
          (res) => { let buf = ''; res.on('data', (c: Buffer) => buf += c.toString()); res.on('end', () => resolve(buf)); },
        );
        req.on('error', reject);
        req.end();
      });

      // Parse SSE events
      const events = raw.split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
        .filter(Boolean);

      // Should have env, build_api running, build_api done, build_admin running, build_admin done, etc.
      const buildApiEvents = events.filter((e: any) => e.step === 'build_api');
      expect(buildApiEvents.length).toBeGreaterThanOrEqual(2); // at least running + done
      expect(buildApiEvents[0].status).toBe('running');
      expect(buildApiEvents[buildApiEvents.length - 1].status).toBe('done');

      // Should have a complete event
      const complete = events.find((e: any) => e.step === 'complete');
      expect(complete).toBeDefined();
    });
  });

  describe('operation guards', () => {
    it('should reject build if already building', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      stateService.updateStatus('feature-test', 'building');
      stateService.save();

      const res = await request(server, 'POST', '/api/branches/feature-test/build');
      expect(res.status).toBe(409);
    });

    it('should reject start if already running', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      stateService.updateStatus('feature-test', 'running');
      stateService.save();

      const res = await request(server, 'POST', '/api/branches/feature-test/start');
      expect(res.status).toBe(409);
    });

    it('should reject delete on active branch', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      await request(server, 'POST', '/api/branches/feature-test/start');
      await request(server, 'POST', '/api/branches/feature-test/activate');

      const res = await request(server, 'DELETE', '/api/branches/feature-test');
      expect(res.status).toBe(400);
    });
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

  describe('POST /api/branches/:id/build', () => {
    it('should build and set status to built', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'POST', '/api/branches/feature-test/build');
      expect(res.status).toBe(200);

      // Verify status is 'built', not 'idle'
      const listRes = await request(server, 'GET', '/api/branches');
      const body = listRes.body as { branches: Record<string, { status: string }> };
      expect(body.branches['feature-test'].status).toBe('built');
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

  describe('full lifecycle: add → build → start → activate', () => {
    it('should go through idle → built → running → active', async () => {
      // Step 1: Add — status = idle
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      let list = await request(server, 'GET', '/api/branches');
      let branches = (list.body as any).branches;
      expect(branches['feature-test'].status).toBe('idle');

      // Step 2: Build — status = built
      await request(server, 'POST', '/api/branches/feature-test/build');
      list = await request(server, 'GET', '/api/branches');
      branches = (list.body as any).branches;
      expect(branches['feature-test'].status).toBe('built');

      // Step 3: Start — status = running
      await request(server, 'POST', '/api/branches/feature-test/start');
      list = await request(server, 'GET', '/api/branches');
      branches = (list.body as any).branches;
      expect(branches['feature-test'].status).toBe('running');

      // Step 4: Activate — becomes active
      await request(server, 'POST', '/api/branches/feature-test/activate');
      list = await request(server, 'GET', '/api/branches');
      expect((list.body as any).activeBranchId).toBe('feature-test');
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

  // ─── Run / Re-run (source-based, separate container) ───────

  /** Helper: make SSE request and parse events */
  async function sseRequest(
    srv: http.Server,
    urlPath: string,
  ): Promise<{ status: number; events: Array<Record<string, any>> }> {
    const addr = srv.address() as { port: number };
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1', port: addr.port, path: urlPath,
          method: 'POST', headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let buf = '';
          res.on('data', (c: Buffer) => (buf += c.toString()));
          res.on('end', () => {
            const events = buf
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
              .filter(Boolean);
            resolve({ status: res.statusCode!, events });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  describe('POST /api/branches/:id/run (source-based)', () => {
    it('should run from source with exposed port, no build, no nginx', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });

      const { status, events } = await sseRequest(server, '/api/branches/feature-test/run');
      expect(status).toBe(200);

      // Verify env step — source mode
      const env = events.find((e) => e.step === 'env');
      expect(env).toBeDefined();
      expect(env!.detail.mode).toBe('source');
      expect(env!.detail.hostPort).toBeGreaterThanOrEqual(9001);
      expect(env!.detail.runContainerName).toBe('prdagent-run-feature-test');
      expect(env!.detail.baseImage).toContain('dotnet/sdk');

      // Verify NO build step (source-based, not artifact-based)
      const buildApi = events.find((e) => e.step === 'build_api');
      expect(buildApi).toBeUndefined();

      // Verify start happened — uses run container name
      const start = events.find((e) => e.step === 'start' && e.status === 'done');
      expect(start).toBeDefined();
      expect(start!.detail.runContainerName).toBe('prdagent-run-feature-test');
      expect(start!.detail.sourceMount).toContain('prd-api');

      // Verify no activate step
      const activate = events.find((e) => e.step === 'activate');
      expect(activate).toBeUndefined();

      // Docker run command: -p port, -v source mount, SDK image
      const runCmd = mock.commands.find(
        (c) => c.includes('docker run') && c.includes('prdagent-run-'),
      );
      expect(runCmd).toBeDefined();
      expect(runCmd).toContain('-p');
      expect(runCmd).toContain('-v');
      expect(runCmd).toContain('dotnet/sdk');
      expect(runCmd).toContain('dotnet run');

      // State: runStatus = running, deploy status unchanged
      const list = await request(server, 'GET', '/api/branches');
      const br = (list.body as any).branches['feature-test'];
      expect(br.runStatus).toBe('running');
      expect(br.runContainerName).toBe('prdagent-run-feature-test');
      expect(br.status).toBe('idle'); // deploy status NOT changed
      expect((list.body as any).activeBranchId).toBeNull();
    });

    it('should return 409 if branch already running (isolation guard)', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      await sseRequest(server, '/api/branches/feature-test/run');

      // Second run → 409
      const res = await request(server, 'POST', '/api/branches/feature-test/run');
      expect(res.status).toBe(409);
    });

    it('should return 404 for unknown branch', async () => {
      const res = await request(server, 'POST', '/api/branches/nope/run');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/branches/:id/rerun', () => {
    it('should pull latest code + restart source container', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      // First run
      await sseRequest(server, '/api/branches/feature-test/run');

      // Mock pull-related commands
      mock.addResponsePattern(/git diff --stat/, () => ({
        stdout: ' src/main.ts | 5 +++--\n 1 file changed\n', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git reset --hard/, () => ({
        stdout: 'HEAD is now at abc1234', stderr: '', exitCode: 0,
      }));

      const { status, events } = await sseRequest(server, '/api/branches/feature-test/rerun');
      expect(status).toBe(200);

      // Verify pull step
      const pull = events.find((e) => e.step === 'pull' && e.status === 'done');
      expect(pull).toBeDefined();
      expect(pull!.detail.changes).toBeDefined();

      // Verify stop step (old container stopped)
      const stop = events.find((e) => e.step === 'stop' && e.status === 'done');
      expect(stop).toBeDefined();

      // Verify start step (new container)
      const start = events.find((e) => e.step === 'start' && e.status === 'done');
      expect(start).toBeDefined();

      // Still NO build step
      expect(events.find((e) => e.step === 'build_api')).toBeUndefined();

      // Complete
      expect(events.find((e) => e.step === 'complete')).toBeDefined();
    });
  });

  describe('POST /api/branches/:id/stop-run', () => {
    it('should stop the run container', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      await sseRequest(server, '/api/branches/feature-test/run');

      const res = await request(server, 'POST', '/api/branches/feature-test/stop-run');
      expect(res.status).toBe(200);

      const list = await request(server, 'GET', '/api/branches');
      expect((list.body as any).branches['feature-test'].runStatus).toBe('stopped');
    });

    it('should return 400 if no run container active', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'POST', '/api/branches/feature-test/stop-run');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/branches/:id/logs', () => {
    it('should return empty logs for new branch', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'GET', '/api/branches/feature-test/logs');
      expect(res.status).toBe(200);
      expect((res.body as any).logs).toEqual([]);
    });

    it('should return 404 for unknown branch', async () => {
      const res = await request(server, 'GET', '/api/branches/nope/logs');
      expect(res.status).toBe(404);
    });

    it('should contain deploy log after deploy', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      await sseRequest(server, '/api/branches/feature-test/deploy');

      const res = await request(server, 'GET', '/api/branches/feature-test/logs');
      const logs = (res.body as any).logs;
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].type).toBe('deploy');
      expect(logs[0].status).toBe('completed');
      expect(logs[0].events.length).toBeGreaterThan(0);
    });

    it('should contain run log after run', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      await sseRequest(server, '/api/branches/feature-test/run');

      const res = await request(server, 'GET', '/api/branches/feature-test/logs');
      const logs = (res.body as any).logs;
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].type).toBe('run');
      expect(logs[0].status).toBe('completed');
    });
  });

  describe('POST /api/branches/:id/reset', () => {
    it('should reset error status to idle', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      stateService.updateStatus('feature-test', 'error');
      stateService.getBranch('feature-test')!.errorMessage = 'build failed';
      stateService.save();

      const res = await request(server, 'POST', '/api/branches/feature-test/reset');
      expect(res.status).toBe(200);

      const list = await request(server, 'GET', '/api/branches');
      const br = (list.body as any).branches['feature-test'];
      expect(br.status).toBe('idle');
      expect(br.errorMessage).toBeUndefined();
    });

    it('should stop running containers on reset', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      stateService.updateStatus('feature-test', 'running');
      stateService.save();

      const res = await request(server, 'POST', '/api/branches/feature-test/reset');
      expect(res.status).toBe(200);

      // docker stop should have been called
      const stopCmds = mock.commands.filter((c) => c.includes('docker stop'));
      expect(stopCmds.length).toBeGreaterThan(0);

      const list = await request(server, 'GET', '/api/branches');
      expect((list.body as any).branches['feature-test'].status).toBe('idle');
    });

    it('should return 404 for unknown branch', async () => {
      const res = await request(server, 'POST', '/api/branches/nope/reset');
      expect(res.status).toBe(404);
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
