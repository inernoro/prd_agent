/**
 * Tests for the multi-project router.
 *
 * P1 (initial shell): hardcoded "default" project.
 *
 * P4 Part 1: the router reads real projects from StateService + the
 * auto-created "legacy default" from migrateProjects().
 *
 * P4 Part 2 (current): POST/DELETE become real. POST validates input,
 * creates a docker network, and persists. DELETE protects the legacy
 * project, removes the docker network, and unpersists. Both paths are
 * tested against a MockShellExecutor that pretends to be docker.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectsRouter, LEGACY_PROJECT_ID } from '../../src/routes/projects.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

/**
 * Stateful docker network mock. Tracks which networks currently "exist"
 * so that `inspect` correctly reports 0 after a successful `create` and
 * `rm` actually flips the state back. Without this, delete tests fail
 * because removeDockerNetwork() early-returns when inspect reports
 * "network gone" immediately after we just created it.
 */
function mockDockerNetworkHappyPath(shell: MockShellExecutor): Set<string> {
  const existing = new Set<string>();

  function parseNetworkName(cmd: string): string {
    return cmd.split(/\s+/).pop() || '';
  }

  shell.addResponsePattern(/^docker network inspect /, (m) => {
    const name = parseNetworkName(m[0]);
    return existing.has(name)
      ? { stdout: 'exists', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: 'no network', exitCode: 1 };
  });
  shell.addResponsePattern(/^docker network create /, (m) => {
    const name = parseNetworkName(m[0]);
    existing.add(name);
    return { stdout: 'network-id', stderr: '', exitCode: 0 };
  });
  shell.addResponsePattern(/^docker network rm /, (m) => {
    const name = parseNetworkName(m[0]);
    existing.delete(name);
    return { stdout: 'removed', stderr: '', exitCode: 0 };
  });

  return existing;
}

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
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

describe('Projects router (P4 Part 2)', () => {
  let tmpDir: string;
  let stateService: StateService;
  let shell: MockShellExecutor;
  let server: http.Server;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-projects-test-'));
    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    stateService.load();

    shell = new MockShellExecutor();
    mockDockerNetworkHappyPath(shell);

    const app = express();
    app.use(express.json());
    app.use('/api', createProjectsRouter({ stateService, shell }));

    server = app.listen(0);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/projects', () => {
    it('returns the migration-created legacy project', async () => {
      const res = await request(server, 'GET', '/api/projects');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total', 1);
      expect(res.body.projects).toHaveLength(1);

      const project = res.body.projects[0];
      expect(project.id).toBe(LEGACY_PROJECT_ID);
      // P4 Part 1: slug is derived from repoRoot basename (projectSlug)
      // rather than hardcoded to 'default'. It must be a non-empty
      // kebab-safe string — the exact value depends on the tmp dir name.
      expect(typeof project.slug).toBe('string');
      expect(project.slug.length).toBeGreaterThan(0);
      expect(project.legacyFlag).toBe(true);
      expect(project.kind).toBe('git');
      expect(project.branchCount).toBe(0);
      expect(typeof project.createdAt).toBe('string');
      expect(typeof project.updatedAt).toBe('string');
    });

    it('reflects the current branch count from state.json', async () => {
      const now = new Date().toISOString();
      const baseBranch = {
        status: 'pending' as const,
        serviceStates: {},
        urls: {},
        createdAt: now,
        updatedAt: now,
        lastAccessed: now,
        webPort: 0,
        apiPort: 0,
        envVars: {},
      };
      stateService.addBranch({ id: 'b1', name: 'feat/one', ...baseBranch });
      stateService.addBranch({ id: 'b2', name: 'feat/two', ...baseBranch });
      stateService.addBranch({ id: 'b3', name: 'feat/three', ...baseBranch });

      const res = await request(server, 'GET', '/api/projects');

      expect(res.status).toBe(200);
      // All 3 branches roll up to the legacy project until Part 3 adds
      // per-branch projectId filtering.
      expect(res.body.projects[0].branchCount).toBe(3);
    });

    // P4 Part 17 (G9 fix): non-legacy projects must show their real
    // branch count instead of always 0. Before the fix, countBranchesFor
    // hardcoded `legacyFlag ? total : 0` which made every new project
    // permanently show 0 branches in the projects.html grid even after
    // the user added branches under it. Verifies (a) the new project
    // counts only its own branches, and (b) the legacy project does NOT
    // get polluted by branches that explicitly belong to another project.
    it('counts branches per project after Part 3 projectId tagging', async () => {
      // Pre-create an 'alt' project so addBranch can stamp it.
      stateService.addProject({
        id: 'alt',
        slug: 'alt-project',
        name: 'Alt Project',
        kind: 'git',
        dockerNetwork: 'cds-proj-alt',
        legacyFlag: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const now = new Date().toISOString();
      const baseBranch = {
        status: 'pending' as const,
        serviceStates: {},
        urls: {},
        createdAt: now,
        updatedAt: now,
        lastAccessed: now,
        webPort: 0,
        apiPort: 0,
        envVars: {},
      };
      // 1 legacy branch (no projectId → defaults to 'default') + 2 alt branches
      stateService.addBranch({ id: 'legacy-1', name: 'main', ...baseBranch });
      stateService.addBranch({ id: 'alt-1', name: 'feat/a', projectId: 'alt', ...baseBranch });
      stateService.addBranch({ id: 'alt-2', name: 'feat/b', projectId: 'alt', ...baseBranch });

      const res = await request(server, 'GET', '/api/projects');
      expect(res.status).toBe(200);

      const byId = Object.fromEntries(res.body.projects.map((p: any) => [p.id, p]));
      expect(byId[LEGACY_PROJECT_ID].branchCount).toBe(1);
      expect(byId.alt.branchCount).toBe(2);
    });
  });

  describe('GET /api/projects/:id', () => {
    it('returns the legacy project details for id=default', async () => {
      const res = await request(server, 'GET', '/api/projects/default');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(LEGACY_PROJECT_ID);
      expect(res.body.legacyFlag).toBe(true);
      expect(res.body.branchCount).toBe(0);
    });

    it('returns 404 for any other project id', async () => {
      const res = await request(server, 'GET', '/api/projects/unknown');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('project_not_found');
    });
  });

  describe('POST /api/projects', () => {
    it('creates a project and runs docker network create', async () => {
      const res = await request(server, 'POST', '/api/projects', {
        name: 'My API',
        description: 'backend service',
      });

      expect(res.status).toBe(201);
      expect(res.body.project.name).toBe('My API');
      expect(res.body.project.slug).toBe('my-api');
      expect(res.body.project.description).toBe('backend service');
      expect(res.body.project.legacyFlag).toBe(false);
      expect(res.body.project.kind).toBe('git');
      expect(res.body.project.dockerNetwork).toMatch(/^cds-proj-[0-9a-f]{12}$/);
      expect(typeof res.body.project.id).toBe('string');
      expect(res.body.project.id.length).toBe(12);

      // Shell was asked to inspect (fail) then create (success)
      const createCmds = shell.commands.filter((c) => c.startsWith('docker network create'));
      expect(createCmds).toHaveLength(1);
      expect(createCmds[0]).toContain(res.body.project.dockerNetwork);

      // And the state was persisted — a second GET should now include it
      const list = await request(server, 'GET', '/api/projects');
      expect(list.body.projects).toHaveLength(2); // legacy + new
    });

    it('accepts an explicit slug when it passes validation', async () => {
      const res = await request(server, 'POST', '/api/projects', {
        name: 'Whatever',
        slug: 'custom-slug',
      });

      expect(res.status).toBe(201);
      expect(res.body.project.slug).toBe('custom-slug');
    });

    it('rejects an empty name with 400', async () => {
      const res = await request(server, 'POST', '/api/projects', { name: '' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation');
      expect(res.body.field).toBe('name');
    });

    it('rejects a name over 60 chars', async () => {
      const res = await request(server, 'POST', '/api/projects', {
        name: 'x'.repeat(61),
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('name');
    });

    it('rejects a slug with illegal characters', async () => {
      const res = await request(server, 'POST', '/api/projects', {
        name: 'ok',
        slug: 'Bad Slug!',
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('slug');
    });

    it('rejects a duplicate slug with 409', async () => {
      // First create succeeds
      const first = await request(server, 'POST', '/api/projects', { name: 'dup' });
      expect(first.status).toBe(201);

      // Second create with the same slug fails
      const second = await request(server, 'POST', '/api/projects', { name: 'dup' });
      expect(second.status).toBe(409);
      expect(second.body.field).toBe('slug');
    });

    it('returns 500 with a docker error when network create fails', async () => {
      // Override the pattern so create fails
      shell.clearPatterns();
      shell.addResponsePattern(/^docker network inspect /, () => ({
        stdout: '', stderr: 'no network', exitCode: 1,
      }));
      shell.addResponsePattern(/^docker network create /, () => ({
        stdout: '', stderr: 'no daemon', exitCode: 1,
      }));

      const res = await request(server, 'POST', '/api/projects', { name: 'no-docker' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('docker');

      // Nothing persisted
      const list = await request(server, 'GET', '/api/projects');
      expect(list.body.projects).toHaveLength(1);
    });

    it('is idempotent when the docker network already exists', async () => {
      // Override the pattern so inspect succeeds (network exists)
      shell.clearPatterns();
      shell.addResponsePattern(/^docker network inspect /, () => ({
        stdout: 'already', stderr: '', exitCode: 0,
      }));
      shell.addResponsePattern(/^docker network create /, () => ({
        stdout: '', stderr: 'should-not-run', exitCode: 99,
      }));

      const res = await request(server, 'POST', '/api/projects', { name: 'existing' });
      expect(res.status).toBe(201);
      // Create was NOT called because inspect already returned 0
      expect(shell.commands.filter((c) => c.startsWith('docker network create'))).toHaveLength(0);
    });
  });

  describe('PUT /api/projects/:id (P4 Part 13)', () => {
    it('updates name + description on the legacy project', async () => {
      const res = await request(server, 'PUT', '/api/projects/default', {
        name: 'Renamed Project',
        description: 'A test description',
      });
      expect(res.status).toBe(200);
      expect(res.body.project.name).toBe('Renamed Project');
      expect(res.body.project.description).toBe('A test description');

      // GET reflects the change
      const get = await request(server, 'GET', '/api/projects/default');
      expect(get.body.name).toBe('Renamed Project');
    });

    it('rejects empty name with 400', async () => {
      const res = await request(server, 'PUT', '/api/projects/default', { name: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('name');
    });

    it('rejects name > 60 chars with 400', async () => {
      const res = await request(server, 'PUT', '/api/projects/default', {
        name: 'x'.repeat(61),
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('name');
    });

    it('returns 404 for unknown project id', async () => {
      const res = await request(server, 'PUT', '/api/projects/no-such-id', { name: 'x' });
      expect(res.status).toBe(404);
    });

    it('only patches supplied fields', async () => {
      // First set both
      await request(server, 'PUT', '/api/projects/default', {
        name: 'First Name',
        description: 'First Desc',
      });
      // Then patch only description
      const res = await request(server, 'PUT', '/api/projects/default', {
        description: 'Second Desc',
      });
      expect(res.status).toBe(200);
      expect(res.body.project.name).toBe('First Name'); // unchanged
      expect(res.body.project.description).toBe('Second Desc');
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('deletes a non-legacy project and runs docker network rm', async () => {
      // Create a project first
      const created = await request(server, 'POST', '/api/projects', { name: 'to-delete' });
      expect(created.status).toBe(201);
      const pid = created.body.project.id;
      const network = created.body.project.dockerNetwork;

      const del = await request(server, 'DELETE', '/api/projects/' + pid);
      // P4 Part 17 (G8 fix): DELETE now returns 200 + cascade summary
      // (was 204 before so the operator can see what was cleaned up).
      // Frontend already accepted both 200 and 204.
      expect(del.status).toBe(200);
      expect(del.body.ok).toBe(true);
      expect(del.body.cascade).toBeDefined();
      expect(del.body.cascade.branches).toEqual([]);
      expect(del.body.cascade.buildProfiles).toEqual([]);
      expect(del.body.cascade.infraServices).toEqual([]);
      expect(del.body.cascade.routingRules).toEqual([]);

      // Shell was asked to inspect + rm the network
      const rmCmds = shell.commands.filter((c) => c.startsWith('docker network rm'));
      expect(rmCmds).toHaveLength(1);
      expect(rmCmds[0]).toContain(network);

      // State no longer contains it
      const list = await request(server, 'GET', '/api/projects');
      expect(list.body.projects).toHaveLength(1); // legacy only
    });

    it('refuses to delete the legacy project with 403', async () => {
      const res = await request(server, 'DELETE', '/api/projects/default');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('legacy_protected');
    });

    it('returns 404 for unknown project ids', async () => {
      const res = await request(server, 'DELETE', '/api/projects/no-such-id');
      expect(res.status).toBe(404);
    });

    // P4 Part 17 (G8 fix): cascade-removes branches / buildProfiles /
    // infraServices / routingRules belonging to the deleted project so
    // state.json doesn't accumulate orphans. Pre-fix, removeProject
    // only spliced the projects[] array and left every related entry
    // behind.
    it('P4 Part 17 (G8): cascade-removes related state entries', async () => {
      const created = await request(server, 'POST', '/api/projects', { name: 'cascade-target' });
      expect(created.status).toBe(201);
      const pid = created.body.project.id;

      // Plant 2 branches, 2 build profiles, 1 infra, 1 routing rule
      // belonging to the cascade-target project, plus 1 branch in the
      // legacy default project to verify isolation.
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'cascade-b1',
        projectId: pid,
        branch: 'main',
        worktreePath: '/tmp/wt-1',
        services: {},
        status: 'idle',
        createdAt: now,
      });
      stateService.addBranch({
        id: 'cascade-b2',
        projectId: pid,
        branch: 'feat',
        worktreePath: '/tmp/wt-2',
        services: {},
        status: 'idle',
        createdAt: now,
      });
      stateService.addBranch({
        id: 'legacy-keep',
        projectId: 'default',
        branch: 'keep',
        worktreePath: '/tmp/wt-keep',
        services: {},
        status: 'idle',
        createdAt: now,
      });
      stateService.addBuildProfile({
        id: 'cascade-p1',
        projectId: pid,
        name: 'web',
        dockerImage: 'nginx',
        command: 'nginx -g "daemon off;"',
        workDir: '.',
        containerPort: 80,
      });
      stateService.addBuildProfile({
        id: 'cascade-p2',
        projectId: pid,
        name: 'api',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      stateService.addInfraService({
        id: 'cascade-i1',
        projectId: pid,
        name: 'redis',
        dockerImage: 'redis:7',
        env: {},
        ports: [],
        volumes: [],
        status: 'idle',
      });
      stateService.addRoutingRule({
        id: 'cascade-r1',
        projectId: pid,
        type: 'domain',
        match: '*.cascade.dev',
        branch: 'main',
        priority: 0,
        enabled: true,
      });
      stateService.save();

      const del = await request(server, 'DELETE', '/api/projects/' + pid);
      expect(del.status).toBe(200);
      expect(del.body.cascade.branches.sort()).toEqual(['cascade-b1', 'cascade-b2']);
      expect(del.body.cascade.buildProfiles.sort()).toEqual(['cascade-p1', 'cascade-p2']);
      expect(del.body.cascade.infraServices).toEqual(['cascade-i1']);
      expect(del.body.cascade.routingRules).toEqual(['cascade-r1']);

      // Legacy branch must NOT be touched.
      const state = stateService.getState();
      expect(Object.keys(state.branches)).toEqual(['legacy-keep']);
      expect(state.buildProfiles).toEqual([]);
      expect(state.infraServices).toEqual([]);
      expect(state.routingRules).toEqual([]);
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// P4 Part 18 (G1.3): multi-repo clone flow tests.
// ────────────────────────────────────────────────────────────────────
//
// These tests run the router with `config.reposBase` set, which
// triggers the auto-repoPath + cloneStatus='pending' behavior on
// POST /projects, and exercise the new POST /:id/clone SSE endpoint.
// The default-config describe block above explicitly does NOT set
// reposBase, so it verifies the legacy single-repo fallback (no
// repoPath, no cloneStatus on freshly-created projects).

/**
 * Minimal SSE client that collects events from an HTTP response
 * stream. Returns once the server ends the response.
 *
 * Event format is standard: each record is a blank-line-terminated
 * block with `event: <name>` and `data: <json>` lines. We parse the
 * JSON so tests can assert against structured objects.
 */
function sseRequest(
  server: http.Server,
  method: string,
  urlPath: string,
): Promise<{ status: number; events: Array<{ event: string; data: any }> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        res.on('end', () => {
          const events: Array<{ event: string; data: any }> = [];
          for (const block of raw.split(/\n\n+/)) {
            const eventMatch = block.match(/^event: (.+)$/m);
            const dataMatch = block.match(/^data: (.+)$/m);
            if (eventMatch && dataMatch) {
              try {
                events.push({
                  event: eventMatch[1].trim(),
                  data: JSON.parse(dataMatch[1].trim()),
                });
              } catch {
                events.push({ event: eventMatch[1].trim(), data: dataMatch[1].trim() });
              }
            }
          }
          resolve({ status: res.statusCode!, events });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Projects router — multi-repo clone (P4 Part 18 G1.3)', () => {
  let tmpDir: string;
  let stateService: StateService;
  let shell: MockShellExecutor;
  let server: http.Server;
  const REPOS_BASE = '/test-repos';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-projects-clone-test-'));
    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    stateService.load();

    shell = new MockShellExecutor();
    mockDockerNetworkHappyPath(shell);

    // Build a minimal config with just reposBase — the rest of
    // CdsConfig is unused by the projects router.
    const config = { reposBase: REPOS_BASE } as any;

    const app = express();
    app.use(express.json());
    app.use('/api', createProjectsRouter({ stateService, shell, config }));

    server = app.listen(0);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('POST /api/projects — auto repoPath when reposBase is set', () => {
    it('stamps repoPath + cloneStatus=pending when gitRepoUrl is provided', async () => {
      const res = await request(server, 'POST', '/api/projects', {
        name: 'Clone Me',
        gitRepoUrl: 'https://github.com/example/repo.git',
      });

      expect(res.status).toBe(201);
      expect(res.body.project.repoPath).toBe(`${REPOS_BASE}/${res.body.project.id}`);
      expect(res.body.project.cloneStatus).toBe('pending');
      expect(res.body.project.gitRepoUrl).toBe('https://github.com/example/repo.git');
    });

    it('does NOT set repoPath when gitRepoUrl is missing (no-op project)', async () => {
      const res = await request(server, 'POST', '/api/projects', {
        name: 'No Git',
      });

      expect(res.status).toBe(201);
      expect(res.body.project.repoPath).toBeUndefined();
      expect(res.body.project.cloneStatus).toBeUndefined();
    });
  });

  describe('POST /api/projects/:id/clone', () => {
    it('streams start → progress → complete on a happy-path clone', async () => {
      // Mock git clone to succeed and emit a couple of progress lines
      shell.addResponsePattern(/^mkdir -p /, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      shell.addResponsePattern(/^test -d /, () => ({ stdout: '', stderr: '', exitCode: 1 }));
      shell.addResponsePattern(/git clone /, () => ({
        stdout: 'Cloning into /test-repos/proj\nReceiving objects: 100% (125/125), done.\n',
        stderr: '',
        exitCode: 0,
      }));

      // Create project first
      const create = await request(server, 'POST', '/api/projects', {
        name: 'Clone Test',
        gitRepoUrl: 'https://github.com/example/test.git',
      });
      expect(create.status).toBe(201);
      const pid = create.body.project.id;

      // Clone
      const clone = await sseRequest(server, 'POST', `/api/projects/${pid}/clone`);
      expect(clone.status).toBe(200);

      const eventNames = clone.events.map((e) => e.event);
      expect(eventNames[0]).toBe('start');
      expect(eventNames).toContain('complete');
      expect(eventNames).not.toContain('error');

      const startEvent = clone.events.find((e) => e.event === 'start')!;
      expect(startEvent.data.projectId).toBe(pid);
      expect(startEvent.data.repoPath).toBe(`${REPOS_BASE}/${pid}`);
      expect(startEvent.data.gitRepoUrl).toBe('https://github.com/example/test.git');

      const completeEvent = clone.events.find((e) => e.event === 'complete')!;
      expect(completeEvent.data.projectId).toBe(pid);
      expect(completeEvent.data.repoPath).toBe(`${REPOS_BASE}/${pid}`);

      // State was updated to 'ready'
      const after = stateService.getProject(pid)!;
      expect(after.cloneStatus).toBe('ready');
      expect(after.cloneError).toBeUndefined();

      // The git clone command was actually executed. P4 Part 18
      // (Phase E audit fix #1): the command is now prefixed with
      // `GIT_TERMINAL_PROMPT=0` so private repos fail fast instead
      // of prompting for credentials — so we match a substring.
      const cloneCmds = shell.commands.filter((c) => c.includes('git clone'));
      expect(cloneCmds).toHaveLength(1);
      expect(cloneCmds[0]).toContain('https://github.com/example/test.git');
      expect(cloneCmds[0]).toContain(`${REPOS_BASE}/${pid}`);
      expect(cloneCmds[0]).toContain('GIT_TERMINAL_PROMPT=0');
    });

    it('sets cloneStatus=error and streams error event when git clone fails', async () => {
      shell.addResponsePattern(/^mkdir -p /, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      shell.addResponsePattern(/^test -d /, () => ({ stdout: '', stderr: '', exitCode: 1 }));
      shell.addResponsePattern(/git clone /, () => ({
        stdout: '',
        stderr: 'fatal: repository https://nope.git not found',
        exitCode: 128,
      }));

      const create = await request(server, 'POST', '/api/projects', {
        name: 'Bad Clone',
        gitRepoUrl: 'https://nope.git',
      });
      const pid = create.body.project.id;

      const clone = await sseRequest(server, 'POST', `/api/projects/${pid}/clone`);
      expect(clone.status).toBe(200);

      const errorEvent = clone.events.find((e) => e.event === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.data.message).toContain('fatal');
      expect(clone.events.find((e) => e.event === 'complete')).toBeUndefined();

      const after = stateService.getProject(pid)!;
      expect(after.cloneStatus).toBe('error');
      expect(after.cloneError).toContain('fatal');
    });

    it('returns 404 when the project does not exist', async () => {
      const res = await request(server, 'POST', '/api/projects/ghost/clone');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('project_not_found');
    });

    it('returns 400 when the project has no gitRepoUrl', async () => {
      const create = await request(server, 'POST', '/api/projects', {
        name: 'No URL',
      });
      const pid = create.body.project.id;

      const res = await request(server, 'POST', `/api/projects/${pid}/clone`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('no_git_url');
    });

    it('returns 409 when the project is already ready', async () => {
      shell.addResponsePattern(/^mkdir -p /, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      shell.addResponsePattern(/^test -d /, () => ({ stdout: '', stderr: '', exitCode: 1 }));
      shell.addResponsePattern(/git clone /, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const create = await request(server, 'POST', '/api/projects', {
        name: 'Double',
        gitRepoUrl: 'https://ok.git',
      });
      const pid = create.body.project.id;

      // First clone → ready
      const first = await sseRequest(server, 'POST', `/api/projects/${pid}/clone`);
      expect(first.events.find((e) => e.event === 'complete')).toBeDefined();

      // Second clone → 409
      const second = await request(server, 'POST', `/api/projects/${pid}/clone`);
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('already_ready');
    });

    it('allows re-clone after an errored attempt', async () => {
      // First clone fails
      shell.addResponsePattern(/^mkdir -p /, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      shell.addResponsePattern(/^test -d /, () => ({ stdout: '', stderr: '', exitCode: 1 }));
      let cloneCall = 0;
      shell.addResponsePattern(/git clone /, () => {
        cloneCall++;
        return cloneCall === 1
          ? { stdout: '', stderr: 'fatal: temporary', exitCode: 128 }
          : { stdout: 'ok', stderr: '', exitCode: 0 };
      });

      const create = await request(server, 'POST', '/api/projects', {
        name: 'Retry',
        gitRepoUrl: 'https://retry.git',
      });
      const pid = create.body.project.id;

      // First attempt fails
      const first = await sseRequest(server, 'POST', `/api/projects/${pid}/clone`);
      expect(stateService.getProject(pid)!.cloneStatus).toBe('error');
      expect(first.events.find((e) => e.event === 'error')).toBeDefined();

      // Second attempt succeeds
      const second = await sseRequest(server, 'POST', `/api/projects/${pid}/clone`);
      expect(stateService.getProject(pid)!.cloneStatus).toBe('ready');
      expect(second.events.find((e) => e.event === 'complete')).toBeDefined();
    });
  });
});
