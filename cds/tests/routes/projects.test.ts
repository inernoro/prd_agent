/**
 * Tests for the multi-project router.
 *
 * P1 (initial shell): hardcoded "default" project, slug/name came from
 * legacyProjectName constructor arg.
 *
 * P4 Part 1 (current): the router reads real projects from StateService.
 * StateService.migrateProjects() ensures at least one "legacy default"
 * project exists with id='default' and slug/name derived from the repo
 * root (projectSlug). These tests pin the P4 Part 1 shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectsRouter, LEGACY_PROJECT_ID } from '../../src/routes/projects.js';
import { StateService } from '../../src/services/state.js';

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json' },
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
    req.end();
  });
}

describe('Projects router (P4 Part 1)', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-projects-test-'));
    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    stateService.load();

    const app = express();
    app.use(express.json());
    app.use('/api', createProjectsRouter({ stateService }));

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
    it('returns 501 not implemented with a pointer to P4 Part 2', async () => {
      const res = await request(server, 'POST', '/api/projects');

      expect(res.status).toBe(501);
      expect(res.body.error).toBe('not_implemented');
      expect(res.body.availablePhase).toBe('P4 Part 2');
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('returns 501 not implemented for any id', async () => {
      const res = await request(server, 'DELETE', '/api/projects/default');

      expect(res.status).toBe(501);
      expect(res.body.error).toBe('not_implemented');
    });
  });
});
