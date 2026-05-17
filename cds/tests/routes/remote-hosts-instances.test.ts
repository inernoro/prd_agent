import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRemoteHostsRouter } from '../../src/routes/remote-hosts.js';
import { CdsPairingService } from '../../src/services/connection/pairing-service.js';
import { StateService } from '../../src/services/state.js';
import type { Project } from '../../src/types.js';

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  token?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
    req.end();
  });
}

const previewEnvKeys = [
  'CDS_PREVIEW_DOMAIN',
  'PREVIEW_DOMAIN',
  'CDS_MAIN_DOMAIN',
  'MAIN_DOMAIN',
  'CDS_DASHBOARD_DOMAIN',
  'DASHBOARD_DOMAIN',
  'CDS_ROOT_DOMAINS',
  'ROOT_DOMAINS',
];

describe('Remote hosts project instances route', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of previewEnvKeys) delete process.env[key];
  });

  async function startServer() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-instances-route-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    const app = express();
    app.use(express.json());
    app.use('/api', createRemoteHostsRouter({ stateService }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
  }

  function authorizeSharedServiceProject(): { projectId: string; longToken: string } {
    const pairing = new CdsPairingService(
      stateService,
      () => 'https://cds.example.test',
      () => 'cds-test',
      () => 'CDS Test',
    );
    const issued = pairing.issue({ name: 'map-test' });
    const accepted = pairing.accept(
      {
        pairingToken: issued.pairingToken,
        partnerKind: 'map',
        partnerId: 'map-test',
        partnerName: 'MAP Test',
        partnerBaseUrl: 'https://map.example.test',
        projectIntent: { kind: 'shared-service', name: 'shared-sidecar-pool' },
      },
      (intent) => {
        const project: Project = {
          id: 'shared-sidecar-pool',
          slug: 'shared-sidecar-pool',
          name: intent.name,
          kind: 'shared-service',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        stateService.addProject(project);
        return project;
      },
    );
    return { projectId: accepted.projectId, longToken: accepted.cdsLongToken };
  }

  it('exposes running branch services for shared-service sidecar pools', async () => {
    process.env.CDS_PREVIEW_DOMAIN = 'preview.example.test';
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    stateService.addBranch({
      id: 'shared-main',
      projectId,
      branch: 'main',
      worktreePath: path.join(tmpDir, 'shared-main'),
      status: 'running',
      services: {
        'api-prd-agent': {
          profileId: 'api-prd-agent',
          containerName: 'cds-shared-sidecar-api',
          hostPort: 17400,
          status: 'running',
        },
      },
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      githubCommitSha: 'abc1234',
    });

    const res = await request(server, 'GET', `/api/projects/${projectId}/instances`, longToken);

    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe(projectId);
    expect(res.body.instances).toHaveLength(1);
    expect(res.body.instances[0]).toMatchObject({
      deploymentId: 'branch:shared-main:api-prd-agent',
      host: 'cds-shared-sidecar-api',
      port: 17400,
      baseUrl: 'https://main-shared-sidecar-pool.preview.example.test',
      healthy: true,
      version: 'abc1234',
      tags: ['system', 'default', 'cds-sidecar'],
      hostName: 'api-prd-agent',
      hostId: 'shared-main',
    });
  });
});
