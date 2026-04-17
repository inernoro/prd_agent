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

    const app = express();
    app.use(express.json());
    app.use('/api', createBranchRouter({
      stateService, worktreeService, containerService, shell: mock, config,
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

    it('P4 Part 3b: filters by ?project= query param', async () => {
      // The migration creates a legacy 'default' project automatically,
      // but we need an 'alt' project to exist before POST /branches
      // will accept a branch stamped with projectId='alt'.
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'alt',
        slug: 'alt',
        name: 'Alt Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });

      // Seed: one branch on the legacy default project, one on 'alt'
      await request(server, 'POST', '/api/branches', {
        branch: 'legacy-branch',
      });
      await request(server, 'POST', '/api/branches', {
        branch: 'alt-branch',
        projectId: 'alt',
      });

      // Default filter → only legacy
      const legacyRes = await request(server, 'GET', '/api/branches?project=default');
      const legacyBranches = (legacyRes.body as any).branches;
      expect(legacyBranches.map((b: any) => b.id)).toEqual(['legacy-branch']);

      // Alt filter → only alt
      const altRes = await request(server, 'GET', '/api/branches?project=alt');
      const altBranches = (altRes.body as any).branches;
      expect(altBranches.map((b: any) => b.id)).toEqual(['alt-branch']);

      // No filter → both
      const allRes = await request(server, 'GET', '/api/branches');
      expect((allRes.body as any).branches).toHaveLength(2);
    });

    it('P4 Part 3b: POST rejects an unknown projectId with 400', async () => {
      const res = await request(server, 'POST', '/api/branches', {
        branch: 'x',
        projectId: 'no-such-project',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('未知项目');
    });

    it('P4 Part 3b: POST stamps the projectId onto the created branch', async () => {
      // 'alt' project will exist because addBranch pre-validates it.
      // We use the default project id to exercise the happy path since
      // that's guaranteed to exist after StateService.migrateProjects().
      const res = await request(server, 'POST', '/api/branches', {
        branch: 'stamped',
        projectId: 'default',
      });
      expect(res.status).toBe(201);
      expect((res.body as any).branch.projectId).toBe('default');
    });

    // P4 Part 18 (G1.5): a branch cannot be created under a project
    // whose clone hasn't finished. The guard triggers on any
    // non-'ready' cloneStatus and preserves legacy projects (whose
    // cloneStatus is simply absent) unchanged.
    describe('P4 Part 18 (G1.5): project not-ready guard', () => {
      const NOW = new Date().toISOString();

      function addProject(id: string, cloneStatus?: 'pending' | 'cloning' | 'ready' | 'error', cloneError?: string) {
        stateService.addProject({
          id,
          slug: id,
          name: id,
          kind: 'git',
          createdAt: NOW,
          updatedAt: NOW,
          ...(cloneStatus ? { cloneStatus } : {}),
          ...(cloneError ? { cloneError } : {}),
          ...(cloneStatus ? { repoPath: `/test-repos/${id}` } : {}),
        });
      }

      it('refuses with 409 when cloneStatus is pending', async () => {
        addProject('p-pending', 'pending');
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'x',
          projectId: 'p-pending',
        });
        expect(res.status).toBe(409);
        expect((res.body as any).error).toBe('project_not_ready');
        expect((res.body as any).cloneStatus).toBe('pending');
      });

      it('refuses with 409 when cloneStatus is cloning', async () => {
        addProject('p-cloning', 'cloning');
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'x',
          projectId: 'p-cloning',
        });
        expect(res.status).toBe(409);
        expect((res.body as any).cloneStatus).toBe('cloning');
      });

      it('refuses with 409 when cloneStatus is error and surfaces cloneError', async () => {
        addProject('p-error', 'error', 'fatal: repository not found');
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'x',
          projectId: 'p-error',
        });
        expect(res.status).toBe(409);
        expect((res.body as any).cloneStatus).toBe('error');
        expect((res.body as any).message).toContain('fatal: repository not found');
      });

      it('allows when cloneStatus is ready', async () => {
        addProject('p-ready', 'ready');
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'ready-branch',
          projectId: 'p-ready',
        });
        expect(res.status).toBe(201);
      });

      it('legacy project (no cloneStatus) is unaffected by the guard', async () => {
        // The migration creates 'default' without cloneStatus — legacy
        // single-repo behaviour. POST /branches should still work.
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'legacy-flow',
          projectId: 'default',
        });
        expect(res.status).toBe(201);
      });
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

    // P4 Part 17 (G14): routing rules created from a non-default project
    // page must land in that project, not silently in 'default'. This
    // mirrors the B1 fix on POST /build-profiles and POST /infra. Three
    // tests cover body.projectId, fallback to 'default', and rejection
    // of unknown projectId.
    it('P4 Part 17 (G14): POST /routing-rules honors body.projectId', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'rules-alt',
        slug: 'rules-alt',
        name: 'Rules Alt',
        kind: 'git',
        dockerNetwork: 'cds-proj-rules-alt',
        legacyFlag: false,
        createdAt: now,
        updatedAt: now,
      });

      const res = await request(server, 'POST', '/api/routing-rules', {
        id: 'r-alt',
        name: 'Alt rule',
        type: 'domain',
        match: '*.alt.dev',
        branch: 'main',
        projectId: 'rules-alt',
      });
      expect(res.status).toBe(201);

      const altList = await request(server, 'GET', '/api/routing-rules?project=rules-alt');
      expect((altList.body as any).rules).toHaveLength(1);
      expect((altList.body as any).rules[0].projectId).toBe('rules-alt');
    });

    it('P4 Part 17 (G14): POST /routing-rules defaults to "default" when no projectId', async () => {
      const res = await request(server, 'POST', '/api/routing-rules', {
        id: 'r-def',
        name: 'Default rule',
        type: 'domain',
        match: '*.dev',
        branch: 'main',
      });
      expect(res.status).toBe(201);

      const list = await request(server, 'GET', '/api/routing-rules?project=default');
      expect((list.body as any).rules).toHaveLength(1);
      expect((list.body as any).rules[0].projectId).toBe('default');
    });

    it('P4 Part 17 (G14): POST /routing-rules rejects unknown projectId with 400', async () => {
      const res = await request(server, 'POST', '/api/routing-rules', {
        id: 'r-bad',
        name: 'Bad rule',
        type: 'domain',
        match: '*.dev',
        branch: 'main',
        projectId: 'no-such-project',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('未知项目');
    });
  });

  // ── Build profiles ──

  describe('build profiles CRUD', () => {
    it('should create and list profiles', async () => {
      const profile = { id: 'api', name: 'API', dockerImage: 'dotnet:8', command: 'dotnet run', workDir: '.', containerPort: 8080 };
      const createRes = await request(server, 'POST', '/api/build-profiles', profile);
      expect(createRes.status).toBe(201);

      const listRes = await request(server, 'GET', '/api/build-profiles');
      expect((listRes.body as any).profiles).toHaveLength(1);
    });

    it('should delete profiles', async () => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'x', command: 'x' });
      await request(server, 'DELETE', '/api/build-profiles/api');

      const list = await request(server, 'GET', '/api/build-profiles');
      expect((list.body as any).profiles).toHaveLength(0);
    });

    it('P4 Part 16 (B1): POST /build-profiles honors body.projectId', async () => {
      // Pre-create the target project
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'alt-proj',
        slug: 'alt-proj',
        name: 'Alt Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });

      const res = await request(server, 'POST', '/api/build-profiles', {
        id: 'web',
        name: 'Web',
        dockerImage: 'nginx',
        command: 'nginx -g "daemon off;"',
        projectId: 'alt-proj',
      });
      expect(res.status).toBe(201);

      // Profile lands in alt-proj, not default
      const altList = await request(server, 'GET', '/api/build-profiles?project=alt-proj');
      expect((altList.body as any).profiles).toHaveLength(1);
      expect((altList.body as any).profiles[0].projectId).toBe('alt-proj');

      const defaultList = await request(server, 'GET', '/api/build-profiles?project=default');
      expect((defaultList.body as any).profiles).toHaveLength(0);
    });

    it('P4 Part 16 (B1): POST /build-profiles defaults to "default" when no projectId', async () => {
      const res = await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
      });
      expect(res.status).toBe(201);

      const list = await request(server, 'GET', '/api/build-profiles?project=default');
      expect((list.body as any).profiles).toHaveLength(1);
      expect((list.body as any).profiles[0].projectId).toBe('default');
    });

    it('P4 Part 16 (B1): POST /build-profiles rejects unknown projectId with 400', async () => {
      const res = await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        projectId: 'nonexistent',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('未知项目');
    });

    // P4 Part 17 (G2 fix): the deploy hot path was reading the global
    // getBuildProfiles() instead of getBuildProfilesForProject(). That
    // meant deploying a branch in project A would silently pull in
    // every profile from project B as well — total cross-project bleed.
    //
    // This test proves the fix: a branch in project 'default' with an
    // 'alt'-scoped profile must hit the "no profiles configured" 400
    // because the deploy reader now respects the branch's projectId.
    it('P4 Part 17 (G2): POST /branches/:id/deploy is project-scoped', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'alt-deploy',
        slug: 'alt-deploy',
        name: 'Alt Deploy',
        kind: 'git',
        dockerNetwork: 'cds-proj-alt-deploy',
        legacyFlag: false,
        createdAt: now,
        updatedAt: now,
      });

      // Profile lives in 'alt-deploy', NOT in default
      const profileRes = await request(server, 'POST', '/api/build-profiles', {
        id: 'web',
        name: 'Web',
        dockerImage: 'nginx',
        command: 'nginx -g "daemon off;"',
        projectId: 'alt-deploy',
      });
      expect(profileRes.status).toBe(201);

      // Branch lives in default
      const branchRes = await request(server, 'POST', '/api/branches', { branch: 'main' });
      expect(branchRes.status).toBe(201);

      // Deploying the default branch must NOT see the alt-deploy profile.
      // Pre-G2 fix this returned 200 + started deploying with the leaked
      // profile. After the fix we expect 400 "尚未配置构建配置".
      const deployRes = await request(server, 'POST', '/api/branches/main/deploy');
      expect(deployRes.status).toBe(400);
      expect((deployRes.body as any).error).toContain('尚未配置构建配置');
    });
  });

  // ── Config ──

  describe('GET /api/config', () => {
    it('should return masked config', async () => {
      const res = await request(server, 'GET', '/api/config');
      expect(res.status).toBe(200);
      expect((res.body as any).jwt.secret).toBe('***');
    });

    it('should use GITHUB_REPO_URL from customEnv when set', async () => {
      // Set GITHUB_REPO_URL in custom env
      await request(server, 'PUT', '/api/env/GITHUB_REPO_URL', { value: 'https://github.com/my-org/my-repo' });

      const res = await request(server, 'GET', '/api/config');
      expect(res.status).toBe(200);
      expect((res.body as any).githubRepoUrl).toBe('https://github.com/my-org/my-repo');
    });

    it('should fallback to git remote when GITHUB_REPO_URL not set', async () => {
      mock.addResponsePattern(/git remote get-url origin/, () => ({
        stdout: 'git@github.com:test-org/test-repo.git\n', stderr: '', exitCode: 0,
      }));

      const res = await request(server, 'GET', '/api/config');
      expect(res.status).toBe(200);
      expect((res.body as any).githubRepoUrl).toBe('https://github.com/test-org/test-repo');
    });
  });

  // ── Config sync via env vars ──

  describe('CDS config sync via env vars', () => {
    it('should sync CDS_REPO_ROOT into config when setting env var', async () => {
      await request(server, 'PUT', '/api/env/CDS_REPO_ROOT', { value: '/custom/repo' });

      const configRes = await request(server, 'GET', '/api/config');
      expect((configRes.body as any).repoRoot).toBe('/custom/repo');
    });

    it('should sync CDS_WORKTREE_BASE into config when setting env var', async () => {
      await request(server, 'PUT', '/api/env/CDS_WORKTREE_BASE', { value: '/custom/worktrees' });

      const configRes = await request(server, 'GET', '/api/config');
      expect((configRes.body as any).worktreeBase).toBe('/custom/worktrees');
    });

    it('should sync CDS_REPO_ROOT via bulk env update', async () => {
      await request(server, 'PUT', '/api/env', {
        CDS_REPO_ROOT: '/bulk/repo',
        CDS_WORKTREE_BASE: '/bulk/worktrees',
        GITHUB_REPO_URL: 'https://github.com/bulk-org/bulk-repo',
      });

      const configRes = await request(server, 'GET', '/api/config');
      expect((configRes.body as any).repoRoot).toBe('/bulk/repo');
      expect((configRes.body as any).worktreeBase).toBe('/bulk/worktrees');
      expect((configRes.body as any).githubRepoUrl).toBe('https://github.com/bulk-org/bulk-repo');
    });
  });

  // ── Infra services (P4 Part 16: B1 fix) ──

  describe('POST /api/infra (project scoping)', () => {
    it('honors body.projectId on creation', async () => {
      // Pre-create the target project
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'redis-proj',
        slug: 'redis-proj',
        name: 'Redis Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });

      const res = await request(server, 'POST', '/api/infra', {
        id: 'redis',
        name: 'Redis',
        dockerImage: 'redis:7-alpine',
        containerPort: 6379,
        projectId: 'redis-proj',
      });
      expect(res.status).toBe(201);
      expect((res.body as any).service.projectId).toBe('redis-proj');

      // Verify scope: appears in redis-proj filter, NOT in default
      const altList = await request(server, 'GET', '/api/infra?project=redis-proj');
      expect((altList.body as any).services).toHaveLength(1);

      const defaultList = await request(server, 'GET', '/api/infra?project=default');
      expect((defaultList.body as any).services).toHaveLength(0);
    });

    it('defaults to "default" projectId when none supplied', async () => {
      const res = await request(server, 'POST', '/api/infra', {
        id: 'mongo',
        name: 'MongoDB',
        dockerImage: 'mongo:8.0',
        containerPort: 27017,
      });
      expect(res.status).toBe(201);
      expect((res.body as any).service.projectId).toBe('default');
    });

    it('rejects unknown projectId with 400', async () => {
      const res = await request(server, 'POST', '/api/infra', {
        id: 'pg',
        name: 'Postgres',
        dockerImage: 'postgres:16',
        containerPort: 5432,
        projectId: 'nonexistent',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('未知项目');
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
