/**
 * Tests for the pending-import router — agent-submitted CDS compose
 * YAML awaiting operator approval.
 *
 * Covers the lifecycle:
 *   1. POST /api/projects/:id/pending-import (agent submits)
 *   2. GET  /api/pending-imports           (dashboard lists pending)
 *   3. GET  /api/pending-imports/:id       (drawer fetches full YAML)
 *   4. POST /api/pending-imports/:id/approve (operator approves → apply)
 *   5. POST /api/pending-imports/:id/reject  (operator rejects → audit)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPendingImportRouter } from '../../src/routes/pending-import.js';
import { StateService } from '../../src/services/state.js';

function request(
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

const SAMPLE_YAML = `
x-cds-project:
  name: "Sample"
  description: "test compose"

x-cds-env:
  JWT_SECRET: "s3cret"
  MONGO_DB_NAME: "prdagent-test"

services:
  api:
    image: mcr.microsoft.com/dotnet/sdk:8.0
    working_dir: /app
    volumes:
      - ./prd-api:/app
    ports:
      - "5000"
    environment:
      ASPNETCORE_ENVIRONMENT: "Development"
    command: dotnet run --urls http://0.0.0.0:5000

  mongodb:
    image: mongo:7
    ports:
      - "27017"
`;

describe('Pending-import router', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pending-import-'));
    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    stateService.load();

    // Seed a non-legacy project (clone ready) for submission tests.
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'proj1',
      slug: 'sample',
      name: 'Sample',
      kind: 'git',
      cloneStatus: 'ready',
      createdAt: now,
      updatedAt: now,
    });
    projectId = 'proj1';

    const app = express();
    app.use(express.json());
    app.use('/api', createPendingImportRouter({ stateService }));

    server = app.listen(0);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('POST /api/projects/:id/pending-import', () => {
    it('accepts a valid submission and returns importId + summary', async () => {
      const res = await request(server, 'POST', `/api/projects/${projectId}/pending-import`, {
        agentName: 'Claude Code',
        purpose: 'test import',
        composeYaml: SAMPLE_YAML,
      });
      expect(res.status).toBe(201);
      expect(res.body.importId).toMatch(/^[a-f0-9]{12}$/);
      expect(res.body.summary.addedProfiles).toContain('api');
      expect(res.body.summary.addedInfra).toContain('mongodb');
      expect(res.body.summary.addedEnvKeys).toEqual(
        expect.arrayContaining(['JWT_SECRET', 'MONGO_DB_NAME']),
      );
      expect(res.body.approveUrl).toContain(res.body.importId);
    });

    it('rejects an empty agentName with 400', async () => {
      const res = await request(server, 'POST', `/api/projects/${projectId}/pending-import`, {
        agentName: '',
        composeYaml: SAMPLE_YAML,
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('agentName');
    });

    it('rejects empty composeYaml with 400', async () => {
      const res = await request(server, 'POST', `/api/projects/${projectId}/pending-import`, {
        agentName: 'x',
        composeYaml: '',
      });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('composeYaml');
    });

    it('rejects unparseable YAML with 400 parse_failed', async () => {
      const res = await request(server, 'POST', `/api/projects/${projectId}/pending-import`, {
        agentName: 'x',
        composeYaml: 'this is not yaml: services: [{{{{',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('parse_failed');
    });

    it('returns 404 for unknown project', async () => {
      const res = await request(server, 'POST', '/api/projects/no-such/pending-import', {
        agentName: 'x',
        composeYaml: SAMPLE_YAML,
      });
      expect(res.status).toBe(404);
    });

    it('returns 409 when target project clone is not ready', async () => {
      stateService.updateProject(projectId, { cloneStatus: 'cloning' });
      const res = await request(server, 'POST', `/api/projects/${projectId}/pending-import`, {
        agentName: 'x',
        composeYaml: SAMPLE_YAML,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('project_not_ready');
    });

    it('returns 413 on oversized composeYaml', async () => {
      const huge = 'x'.repeat(300_000);
      const res = await request(server, 'POST', `/api/projects/${projectId}/pending-import`, {
        agentName: 'x',
        composeYaml: huge,
      });
      expect(res.status).toBe(413);
    });
  });

  describe('GET /api/pending-imports', () => {
    it('lists pending items, pending first, with counters', async () => {
      // Seed two submissions
      await request(server, 'POST', `/api/projects/${projectId}/pending-import`, {
        agentName: 'A', purpose: 'first', composeYaml: SAMPLE_YAML,
      });
      await request(server, 'POST', `/api/projects/${projectId}/pending-import`, {
        agentName: 'B', purpose: 'second', composeYaml: SAMPLE_YAML,
      });
      const res = await request(server, 'GET', '/api/pending-imports');
      expect(res.status).toBe(200);
      expect(res.body.pendingCount).toBe(2);
      expect(res.body.imports).toHaveLength(2);
      // Raw YAML must NOT leak in the list view
      expect(res.body.imports[0].composeYaml).toBeUndefined();
      expect(res.body.imports[0].summary.addedProfiles).toContain('api');
    });
  });

  describe('GET /api/pending-imports/:id', () => {
    it('returns the full record including raw YAML', async () => {
      const create = await request(server, 'POST', `/api/projects/${projectId}/pending-import`, {
        agentName: 'A', composeYaml: SAMPLE_YAML,
      });
      const res = await request(server, 'GET', `/api/pending-imports/${create.body.importId}`);
      expect(res.status).toBe(200);
      expect(res.body.import.composeYaml).toContain('services:');
    });

    it('returns 404 for unknown id', async () => {
      const res = await request(server, 'GET', '/api/pending-imports/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/pending-imports/:id/approve', () => {
    it('applies profiles, env, and infra to the target project', async () => {
      const create = await request(server, 'POST', `/api/projects/${projectId}/pending-import`, {
        agentName: 'A', composeYaml: SAMPLE_YAML,
      });
      const importId = create.body.importId;

      const res = await request(server, 'POST', `/api/pending-imports/${importId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.applied).toBe(true);
      // Non-legacy project → id is suffixed with project slug
      expect(res.body.appliedProfiles).toContain('api-sample');
      expect(res.body.appliedInfra).toContain('mongodb');
      expect(res.body.appliedEnvKeys).toEqual(
        expect.arrayContaining(['JWT_SECRET', 'MONGO_DB_NAME']),
      );

      // State reflects the apply
      const profile = stateService.getBuildProfile('api-sample');
      expect(profile).toBeDefined();
      expect(profile?.projectId).toBe(projectId);

      const infra = stateService.getInfraServicesForProject(projectId);
      const mongo = infra.find((s) => s.id === 'mongodb');
      expect(mongo).toBeDefined();
      // Regression for the P1 isolation gap: importing infra into a
      // non-legacy project must scope the container name with the
      // project's slug (matches the manual create path at
      // branches.ts:4300-4302). Otherwise two projects each importing
      // "mongodb" both get `cds-infra-mongodb` and collide on docker run.
      expect(mongo!.containerName).toBe('cds-infra-sample-mongodb');

      // 2026-04-18: pending-import writes into the target project's
      // scope so env keys don't leak cross-project. Passing projectId
      // merges _global + project overrides.
      const env = stateService.getCustomEnv(projectId);
      expect(env['JWT_SECRET']).toBe('s3cret');

      // Item itself marked approved
      const updated = stateService.getPendingImport(importId)!;
      expect(updated.status).toBe('approved');
      expect(updated.decidedAt).toBeDefined();
    });

    it('imported infra into the legacy default project keeps the bare cds-infra-<id> name', async () => {
      // Legacy projects (legacyFlag=true) keep the historical bare
      // container name for back-compat with already-running containers.
      // This mirrors branches.ts:4300-4302 which uses the same
      // legacyFlag-conditioned formula.
      const create = await request(server, 'POST', `/api/projects/default/pending-import`, {
        agentName: 'A', composeYaml: SAMPLE_YAML,
      });
      // The default project from migration is legacy; clone status is
      // absent so the not-ready guard doesn't fire.
      const importId = create.body.importId;
      const res = await request(server, 'POST', `/api/pending-imports/${importId}/approve`);
      expect(res.status).toBe(200);
      const infra = stateService.getInfraServicesForProject('default');
      const mongo = infra.find((s) => s.id === 'mongodb');
      expect(mongo).toBeDefined();
      expect(mongo!.containerName).toBe('cds-infra-mongodb');
    });

    it('refuses to approve twice', async () => {
      const create = await request(server, 'POST', `/api/projects/${projectId}/pending-import`, {
        agentName: 'A', composeYaml: SAMPLE_YAML,
      });
      const importId = create.body.importId;
      await request(server, 'POST', `/api/pending-imports/${importId}/approve`);
      const res = await request(server, 'POST', `/api/pending-imports/${importId}/approve`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('already_decided');
    });

    it('does not clobber existing env keys', async () => {
      stateService.setCustomEnvVar('JWT_SECRET', 'pre-existing');
      const create = await request(server, 'POST', `/api/projects/${projectId}/pending-import`, {
        agentName: 'A', composeYaml: SAMPLE_YAML,
      });
      await request(server, 'POST', `/api/pending-imports/${create.body.importId}/approve`);
      const env = stateService.getCustomEnv();
      expect(env['JWT_SECRET']).toBe('pre-existing');
    });
  });

  describe('POST /api/pending-imports/:id/reject', () => {
    it('marks rejected without applying', async () => {
      const create = await request(server, 'POST', `/api/projects/${projectId}/pending-import`, {
        agentName: 'A', composeYaml: SAMPLE_YAML,
      });
      const importId = create.body.importId;

      const res = await request(server, 'POST', `/api/pending-imports/${importId}/reject`, {
        reason: 'wrong project',
      });
      expect(res.status).toBe(200);
      expect(res.body.rejected).toBe(true);

      const updated = stateService.getPendingImport(importId)!;
      expect(updated.status).toBe('rejected');
      expect(updated.rejectReason).toBe('wrong project');

      // Nothing was applied
      expect(stateService.getBuildProfile('api-sample')).toBeUndefined();
    });
  });
});
