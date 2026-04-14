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
