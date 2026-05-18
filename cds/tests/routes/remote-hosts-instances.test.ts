import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRemoteHostsRouter } from '../../src/routes/remote-hosts.js';
import { CdsPairingService } from '../../src/services/connection/pairing-service.js';
import { StateService } from '../../src/services/state.js';
import type { BuildProfile, Project } from '../../src/types.js';

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
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
  let runtimeServer: http.Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (runtimeServer) await new Promise<void>((resolve) => runtimeServer!.close(() => resolve()));
    runtimeServer = undefined;
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

  async function startMockOfficialSdkRuntime(): Promise<{ port: number; requests: any[] }> {
    const requests: any[] = [];
    runtimeServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/readyz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ready: true,
          agentAdapter: 'claude-agent-sdk',
          adapterDiagnostics: {
            adapter: 'claude-agent-sdk',
            loopOwner: 'claude-agent-sdk',
            sdkLoopEnabled: true,
          },
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/agent/run') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk.toString(); });
        req.on('end', () => {
          requests.push({
            authorization: req.headers.authorization,
            body: JSON.parse(raw),
          });
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('event: runtime_init\n');
          res.write(`data: ${JSON.stringify({
            type: 'runtime_init',
            message: 'claude-agent-sdk adapter started',
            content: {
              adapter: 'claude-agent-sdk',
              loopOwner: 'claude-agent-sdk',
              sdkLoopEnabled: true,
              mapRole: 'control-plane',
              cdsRole: 'sandbox-runtime',
            },
          })}\n\n`);
          res.write('event: text_delta\n');
          res.write(`data: ${JSON.stringify({ type: 'text_delta', text: 'official runtime ok' })}\n\n`);
          res.write('event: done\n');
          res.write(`data: ${JSON.stringify({ type: 'done', final_text: 'official runtime ok' })}\n\n`);
          res.end();
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => {
      runtimeServer!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = runtimeServer.address() as { port: number };
    return { port: addr.port, requests };
  }

  function addSharedOfficialSdkRuntime(projectId: string, port: number): void {
    const profile: BuildProfile = {
      id: 'claude-agent-sdk-runtime',
      projectId,
      name: 'Claude Agent SDK Runtime',
      dockerImage: 'ghcr.io/inernoro/prd-agent/claude-sidecar:test',
      workDir: 'claude-sdk-sidecar',
      command: 'uvicorn app.main:app --host 0.0.0.0 --port 7400',
      containerPort: 7400,
      env: {
        SIDECAR_AGENT_ADAPTER: 'claude-agent-sdk',
        SIDECAR_TOKEN: 'dev-skip',
      },
    };
    stateService.addBuildProfile(profile);
    stateService.addBranch({
      id: 'shared-runtime-main',
      projectId,
      branch: 'main',
      worktreePath: path.join(tmpDir, 'shared-runtime-main'),
      status: 'running',
      services: {
        'claude-agent-sdk-runtime': {
          profileId: 'claude-agent-sdk-runtime',
          containerName: 'cds-claude-agent-sdk-runtime',
          hostPort: port,
          status: 'running',
        },
      },
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      githubCommitSha: 'runtime123',
    });
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
        'admin-prd-agent': {
          profileId: 'admin-prd-agent',
          containerName: 'cds-shared-sidecar-admin',
          hostPort: 17480,
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
    expect(res.body.discovery).toMatchObject({
      projectKind: 'shared-service',
      deploymentCount: 0,
      runningDeploymentCount: 0,
      branchCount: 1,
      runningBranchCount: 1,
      runningBranchServiceCount: 2,
      runtimeBranchServiceCount: 1,
      skippedBranchServiceCount: 1,
      previewRootConfigured: true,
    });
    expect(res.body.instances).toHaveLength(1);
    expect(res.body.instances[0]).toMatchObject({
      deploymentId: 'branch:shared-main:api-prd-agent',
      profileId: 'api-prd-agent',
      branchId: 'shared-main',
      branch: 'main',
      serviceKind: 'branch-service',
      projectKind: 'shared-service',
      host: 'cds-shared-sidecar-api',
      port: 17400,
      baseUrl: 'https://main-shared-sidecar-pool.preview.example.test',
      healthy: true,
      version: 'abc1234',
      tags: ['system', 'default', 'cds-sidecar', 'profile:api-prd-agent', 'branch:main'],
      hostName: 'api-prd-agent',
      hostId: 'shared-main',
    });
  });

  it('does not expose branch services for regular projects through instance discovery', async () => {
    process.env.CDS_PREVIEW_DOMAIN = 'preview.example.test';
    await startServer();
    const pairing = new CdsPairingService(
      stateService,
      () => 'https://cds.example.test',
      () => 'cds-test',
      () => 'CDS Test',
    );
    const project: Project = {
      id: 'business-project',
      slug: 'business-project',
      name: 'Business Project',
      kind: 'git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    stateService.addProject(project);
    const issued = pairing.issue({ name: 'map-test' });
    const accepted = pairing.accept(
      {
        pairingToken: issued.pairingToken,
        partnerKind: 'map',
        partnerId: 'map-test',
        partnerName: 'MAP Test',
        partnerBaseUrl: 'https://map.example.test',
        projectIntent: { kind: 'shared-service', name: 'ignored' },
      },
      () => project,
    );
    stateService.addBranch({
      id: 'business-main',
      projectId: project.id,
      branch: 'main',
      worktreePath: path.join(tmpDir, 'business-main'),
      status: 'running',
      services: {
        'api-prd-agent': {
          profileId: 'api-prd-agent',
          containerName: 'cds-business-api',
          hostPort: 18080,
          status: 'running',
        },
      },
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      githubCommitSha: 'def5678',
    });

    const res = await request(server, 'GET', `/api/projects/${project.id}/instances`, accepted.cdsLongToken);

    expect(res.status).toBe(200);
    expect(res.body.discovery).toMatchObject({
      projectKind: 'git',
      deploymentCount: 0,
      branchCount: 0,
      runningBranchCount: 0,
      runningBranchServiceCount: 0,
      runtimeBranchServiceCount: 0,
      skippedBranchServiceCount: 0,
      previewRootConfigured: false,
    });
    expect(res.body.instances).toHaveLength(0);
  });

  it('keeps non-fake agent session execution owned by CDS instead of delegating back to MAP', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();

    const created = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      { runtime: 'claude-sdk', model: 'claude-sonnet-4-20250514' },
    );

    expect(created.status).toBe(201);
    const sessionId = created.body.item.id;

    const sent = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: 'review this repository' },
    );

    expect(sent.status).toBe(202);
    expect(sent.body.accepted).toBe(false);
    expect(sent.body.runtimeOwnedBy).toBe('cds-managed-runtime');
    expect(sent.body.item.status).toBe('failed');
    expect(sent.body.error).toMatchObject({
      code: 'cds_managed_runtime_unavailable',
      mapRole: 'control-plane-client',
      cdsRole: 'runtime-container-sandbox-manager',
      fallbackScope: 'operator-debug-only',
      runtime: 'claude-sdk',
    });
    expect(sent.body.error.message).not.toContain('MAP sidecar bridge');
    expect(sent.body.error.nextActions.join('\n')).not.toContain('CDS_REMOTE_HOST');

    const stream = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/logs`,
      longToken,
    );
    expect(stream.status).toBe(200);
    expect(stream.body.logs).toContain('owner=cds-managed-runtime');
    expect(stream.body.logs).not.toContain('delegated');
  });

  it('routes non-fake agent sessions to a CDS-managed official SDK runtime transport', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    const runtime = await startMockOfficialSdkRuntime();
    addSharedOfficialSdkRuntime(projectId, runtime.port);

    const created = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      { runtime: 'claude-sdk', model: 'claude-sonnet-4-20250514' },
    );

    expect(created.status).toBe(201);
    const sessionId = created.body.item.id;

    const sent = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: 'review this repository through the official SDK runtime' },
    );

    expect(sent.status).toBe(202);
    expect(sent.body.accepted).toBe(true);
    expect(sent.body.runtimeOwnedBy).toBe('cds-managed-runtime');
    expect(sent.body.item.status).toBe('idle');
    expect(sent.body.transport).toMatchObject({
      source: 'cds-branch-service',
      runtimeOwnedBy: 'cds-managed-runtime',
      profileId: 'claude-agent-sdk-runtime',
      runtimeAdapter: 'claude-agent-sdk',
      loopOwner: 'claude-agent-sdk',
      auth: { configured: true, source: 'build-profile-env' },
    });
    expect(sent.body.transport.baseUrl).toBe(`http://127.0.0.1:${runtime.port}`);
    expect(sent.body.transport).not.toHaveProperty('authToken');
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0].authorization).toBe('Bearer dev-skip');
    expect(runtime.requests[0].body).toMatchObject({
      runtimeAdapter: 'claude-agent-sdk',
      model: 'claude-sonnet-4-20250514',
      mapSessionId: sessionId,
    });

    const stream = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/stream`,
      longToken,
    );
    expect(stream.status).toBe(200);
    expect(stream.body).toContain('runtime_init');
    expect(stream.body).toContain('claude-agent-sdk');
    expect(stream.body).toContain('official runtime ok');
    expect(stream.body).not.toContain('CDS_REMOTE_HOST');

    const logs = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/logs`,
      longToken,
    );
    expect(logs.status).toBe(200);
    expect(logs.body.logs).toContain('owner=cds-managed-runtime');
    expect(logs.body.logs).toContain('loopOwner=claude-agent-sdk');
    expect(logs.body.logs).not.toContain('MAP sidecar bridge');
  });
});
