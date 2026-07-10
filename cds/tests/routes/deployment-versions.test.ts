import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentVersionsRouter } from '../../src/routes/deployment-versions.js';
import { DeploymentVersionService } from '../../src/services/deployment-version.js';
import { StateService } from '../../src/services/state.js';
import type { BranchEntry, BuildProfile, DeploymentVersion } from '../../src/types.js';

describe('Deployment versions router', () => {
  let tmpDir: string;
  let stateService: StateService;
  let versionService: DeploymentVersionService;
  let server: http.Server;
  let branch: BranchEntry;
  let profile: BuildProfile;
  let dispatchVersion: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-deployment-version-route-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'));
    stateService.load();
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as any);
    branch = {
      id: 'b1', projectId: 'p1', branch: 'feat/version', worktreePath: '/tmp/b1',
      status: 'running', createdAt: '2026-07-10T00:00:00.000Z', services: {
        web: {
          profileId: 'web', containerName: 'cds-b1-web', hostPort: 10001, status: 'running',
          deployedImage: 'ghcr.io/acme/web:sha-1234567', deployedMode: 'express',
        },
      },
    };
    stateService.addBranch(branch);
    profile = {
      id: 'web', projectId: 'p1', name: 'Web', dockerImage: 'ghcr.io/acme/web:sha-1234567',
      workDir: '.', command: 'node server.js', containerPort: 3000, prebuiltImage: true,
    };
    versionService = new DeploymentVersionService(stateService);
    dispatchVersion = vi.fn(async () => ({ accepted: true, status: 200, runId: 'dr_dispatched' }));

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const projectId = req.header('x-test-project');
      if (projectId) (req as any).cdsProjectKey = { projectId, keyId: 'test' };
      next();
    });
    app.use('/api', createDeploymentVersionsRouter({
      deploymentVersionService: versionService,
      assertProjectAccess: (req, projectId) => {
        const key = (req as any).cdsProjectKey as { projectId: string } | undefined;
        return !key || key.projectId === projectId ? null : { status: 403, body: { error: 'project_mismatch' } };
      },
      dispatchVersion,
    }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stateService.flush();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createVersion(commitSha: string, configChar: string): DeploymentVersion {
    return versionService.create({
      projectId: 'p1', branchId: 'b1', commitSha, configHash: configChar.repeat(64),
      profiles: [profile], branch, createdByRunId: `dr_${commitSha}`,
    });
  }

  it('lists and reads immutable versions with project scoping', async () => {
    const version = createVersion('abc1234', 'a');
    const list = await request(server, 'GET', '/api/deployment-versions?project=p1&branch=b1', undefined, { 'x-test-project': 'p1' });
    expect(list.status).toBe(200);
    expect(list.body.versions).toHaveLength(1);
    expect(list.body.versions[0].id).toBe(version.id);

    const forbidden = await request(server, 'GET', `/api/deployment-versions/${version.id}`, undefined, { 'x-test-project': 'p2' });
    expect(forbidden.status).toBe(403);
  });

  it('dispatches a reusable version and returns the new runId', async () => {
    const version = createVersion('abc1234', 'a');
    const response = await request(server, 'POST', `/api/deployment-versions/${version.id}/deploy`);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ accepted: true, versionId: version.id, runId: 'dr_dispatched' });
    expect(dispatchVersion).toHaveBeenCalledWith(version, 'manual');
  });

  it('refuses a legacy version that cannot be reproduced without rebuilding', async () => {
    branch.services.web.deployedImage = 'node:22';
    const legacy = versionService.create({
      projectId: 'p1', branchId: 'b1', commitSha: 'legacy1', configHash: 'b'.repeat(64),
      profiles: [{ ...profile, dockerImage: 'node:22', prebuiltImage: false }], branch, createdByRunId: 'dr_legacy',
    });

    const response = await request(server, 'POST', `/api/deployment-versions/${legacy.id}/deploy`);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('deployment_version_not_reusable');
    expect(dispatchVersion).not.toHaveBeenCalled();
  });

  it('rolls back to the latest reusable version before currentVersionId', async () => {
    const previous = createVersion('abc1234', 'a');
    const current = createVersion('def5678', 'b');
    branch.currentVersionId = current.id;
    stateService.save();

    const response = await request(server, 'POST', '/api/branches/b1/rollback', {});
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ rollback: true, versionId: previous.id, runId: 'dr_dispatched' });
    expect(dispatchVersion).toHaveBeenCalledWith(previous, 'rollback');
  });
});

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const address = server.address() as { port: number };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: address.port, path: urlPath, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
