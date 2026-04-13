/**
 * Tests for the P1 multi-project shell router.
 *
 * These tests pin the behavior documented in doc/plan.cds-multi-project-phases.md
 * P1: the shell returns exactly one "legacy default" project reflecting
 * state.json, and create/delete endpoints return 501 with pointers to P4.
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

describe('Projects router (P1 shell)', () => {
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
    app.use('/api', createProjectsRouter({
      stateService,
      legacyProjectName: 'test-repo',
    }));

    server = app.listen(0);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/projects', () => {
    it('returns a single legacy project entry', async () => {
      const res = await request(server, 'GET', '/api/projects');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total', 1);
      expect(res.body.projects).toHaveLength(1);

      const project = res.body.projects[0];
      expect(project.id).toBe(LEGACY_PROJECT_ID);
      expect(project.slug).toBe(LEGACY_PROJECT_ID);
      expect(project.name).toBe('test-repo');
      expect(project.legacyFlag).toBe(true);
      expect(project.workspaceId).toBe('system');
      expect(project.kind).toBe('git');
      expect(project.branchCount).toBe(0);
    });

    it('reflects the current branch count from state.json', async () => {
      // Seed three branches into state.json via addBranch
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
      expect(res.body.projects[0].branchCount).toBe(3);
    });
  });

  describe('GET /api/projects/:id', () => {
    it('returns the legacy project details for id=default', async () => {
      const res = await request(server, 'GET', '/api/projects/default');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(LEGACY_PROJECT_ID);
      expect(res.body.legacyFlag).toBe(true);
    });

    it('returns 404 for any other project id', async () => {
      const res = await request(server, 'GET', '/api/projects/unknown');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('project_not_found');
    });
  });

  describe('POST /api/projects', () => {
    it('returns 501 not implemented with a pointer to P4', async () => {
      const res = await request(server, 'POST', '/api/projects');

      expect(res.status).toBe(501);
      expect(res.body.error).toBe('not_implemented');
      expect(res.body.availablePhase).toBe('P4');
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
