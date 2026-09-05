import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRemoteHostsRouter } from '../../src/routes/remote-hosts.js';
import { CdsPairingService } from '../../src/services/connection/pairing-service.js';
import { cdsEventsBus } from '../../src/services/cds-events-bus.js';
import {
  AgentWorkspaceRuntimeError,
  AgentWorkspaceSessionRuntime,
} from '../../src/services/agent-workspace-session-runtime.js';
import type { ServerEventLogSink, ServerEventRecord } from '../../src/services/server-event-log-store.js';
import { StateService } from '../../src/services/state.js';
import type { BuildProfile, ExecResult, IShellExecutor, Project } from '../../src/types.js';

import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
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

function streamRequest(
  server: http.Server,
  urlPath: string,
  token: string,
): {
  firstEvent: Promise<string>;
  completed: Promise<{ status: number; body: string }>;
  abort: () => void;
} {
  let resolveFirstEvent!: (value: string) => void;
  const firstEvent = new Promise<string>((resolve) => {
    resolveFirstEvent = resolve;
  });
  let aborted = false;
  let req: http.ClientRequest;
  const completed = new Promise<{ status: number; body: string }>((resolve, reject) => {
    let settled = false;
    const finish = (value: { status: number; body: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const addr = server.address() as { port: number };
    req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let raw = '';
        let firstResolved = false;
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
          if (!firstResolved && raw.includes('\n\n')) {
            firstResolved = true;
            resolveFirstEvent(raw.slice(0, raw.indexOf('\n\n') + 2));
          }
        });
        res.on('end', () => finish({ status: res.statusCode!, body: raw }));
        res.on('close', () => {
          if (aborted) finish({ status: 0, body: raw });
        });
      },
    );
    req.on('error', (error) => {
      if (aborted) {
        finish({ status: 0, body: '' });
        return;
      }
      reject(error);
    });
    req.end();
  });
  return {
    firstEvent,
    completed,
    abort: () => {
      aborted = true;
      req.destroy();
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
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
  'CDS_AGENT_SESSION_HOST_LIMIT',
  'CDS_AGENT_SESSION_PROJECT_LIMIT',
  'CDS_AGENT_SESSION_PRINCIPAL_LIMIT',
];

describe('Remote hosts project instances route', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;
  let runtimeServer: http.Server | undefined;

  afterEach(async () => {
    await flushAllJsonStateStores();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (runtimeServer) await new Promise<void>((resolve) => runtimeServer!.close(() => resolve()));
    runtimeServer = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    for (const key of previewEnvKeys) delete process.env[key];
  });

  async function startServer(routerOverrides: Partial<Parameters<typeof createRemoteHostsRouter>[0]> = {}) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-instances-route-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    const app = express();
    app.use(express.json());
    app.use('/api', createRemoteHostsRouter({ stateService, ...routerOverrides }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
  }

  function authorizeSharedServiceProject(options: {
    projectId?: string;
    partnerId?: string;
  } = {}): { projectId: string; longToken: string } {
    const projectId = options.projectId ?? 'shared-sidecar-pool';
    const partnerId = options.partnerId ?? 'map-test';
    const pairing = new CdsPairingService(
      stateService,
      () => 'https://cds.example.test',
      () => 'cds-test',
      () => 'CDS Test',
    );
    const issued = pairing.issue({ name: partnerId });
    const accepted = pairing.accept(
      {
        pairingToken: issued.pairingToken,
        partnerKind: 'map',
        partnerId,
        partnerName: 'MAP Test',
        partnerBaseUrl: 'https://map.example.test',
        projectIntent: { kind: 'shared-service', name: 'shared-sidecar-pool' },
      },
      (intent) => {
        const project: Project = {
          id: projectId,
          slug: projectId,
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

  async function startMockOfficialSdkRuntime(options: { omitTerminal?: boolean; holdOpen?: boolean } = {}): Promise<{ port: number; requests: any[]; closedRequests: any[] }> {
    const requests: any[] = [];
    const closedRequests: any[] = [];
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
          res.on('close', () => closedRequests.push({ runId: JSON.parse(raw).runId }));
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
          if (options.holdOpen) return;
          if (!options.omitTerminal) {
            res.write('event: done\n');
            res.write(`data: ${JSON.stringify({ type: 'done', final_text: 'official runtime ok' })}\n\n`);
          }
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
    return { port: addr.port, requests, closedRequests };
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
      capacityRole: 'runtime-service',
      runtimeOwnedBy: 'cds-managed-runtime',
      runtimeAdapter: 'unknown',
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
    expect(res.body.capacity).toMatchObject({
      requirement: 'CDS_MANAGED_RUNTIME_CAPACITY',
      status: 'missing',
      runtimeOwnedBy: 'cds-managed-runtime',
      loopOwner: 'claude-agent-sdk',
      productPath: {
        runningOfficialSdkRuntimeCount: 0,
        branchRuntimeServiceCount: 1,
      },
      legacyFallback: {
        scope: 'operator-debug-only',
      },
    });
  });

  it('exposes CDS-managed runtime capacity as product gate separate from fallback hosts', async () => {
    process.env.CDS_PREVIEW_DOMAIN = 'preview.example.test';
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();

    const missing = await request(server, 'GET', `/api/projects/${projectId}/runtime-capacity`, longToken);

    expect(missing.status).toBe(200);
    expect(missing.body.capacity).toMatchObject({
      requirement: 'CDS_MANAGED_RUNTIME_CAPACITY',
      status: 'missing',
      runtimeOwnedBy: 'cds-managed-runtime',
      loopOwner: 'claude-agent-sdk',
      productPath: {
        projectKind: 'shared-service',
        runningOfficialSdkRuntimeCount: 0,
      },
      legacyFallback: {
        enabledRemoteHostCount: 0,
        runningFallbackInstanceCount: 0,
        scope: 'operator-debug-only',
      },
    });
    expect(missing.body.capacity.nextAction).toContain('CDS-managed official SDK runtime');
    expect(missing.body.capacity.nextAction).not.toContain('CDS_REMOTE_HOST');

    const runtime = await startMockOfficialSdkRuntime();
    addSharedOfficialSdkRuntime(projectId, runtime.port);

    const available = await request(server, 'GET', `/api/projects/${projectId}/runtime-capacity`, longToken);

    expect(available.status).toBe(200);
    expect(available.body.instances).toHaveLength(1);
    expect(available.body.instances[0]).toMatchObject({
      capacityRole: 'product-runtime',
      runtimeOwnedBy: 'cds-managed-runtime',
      runtimeAdapter: 'claude-agent-sdk',
      loopOwner: 'claude-agent-sdk',
    });
    expect(available.body.capacity).toMatchObject({
      requirement: 'CDS_MANAGED_RUNTIME_CAPACITY',
      status: 'available',
      productPath: {
        runningOfficialSdkRuntimeCount: 1,
      },
      legacyFallback: {
        enabledRemoteHostCount: 0,
        runningFallbackInstanceCount: 0,
      },
    });
  });

  it('publishes OpenDesign as implemented but not selectable without an injected container runtime', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();

    const catalog = await request(server, 'GET', `/api/projects/${projectId}/agent-runtime-providers`, longToken);

    expect(catalog.status).toBe(200);
    expect(catalog.body).toMatchObject({
      runtimeOwnedBy: 'cds-remote-agent',
      isolationOwnedBy: 'cds-remote-agent',
    });
    expect(catalog.body.items.find((item: any) => item.id === 'open-design')).toMatchObject({
      adapterKind: 'design-daemon',
      implementationStatus: 'available',
      healthy: false,
      selectable: false,
      requiredIsolationMode: 'session-container',
      resourcePolicyEnforcedPerSession: false,
    });

    const rejected = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      { runtime: 'open-design', workloadKind: 'design-artifact' },
    );
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toMatchObject({
      code: 'resource_policy_not_enforced',
      runtime: 'open-design',
      requestedIsolationMode: 'session-container',
      isolationOwnedBy: 'cds-remote-agent',
      resourcePolicyEnforcedPerSession: false,
    });
  });

  it('keeps OpenDesign unselectable when its configured image is absent', async () => {
    const shell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        if (command.startsWith('docker version')) {
          return { stdout: '27.0.0\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('docker image inspect')) {
          return { stdout: '', stderr: 'No such image', exitCode: 1 };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    };
    const workspaceRuntime = new AgentWorkspaceSessionRuntime(shell, { capabilityCacheMs: 0 });
    // Provider 目录现在只读非阻塞快照；先完成一次探针，才能断言缺镜像的具体原因，
    // 否则首个请求按设计只会得到 fail-closed 的“正在验证”。
    await workspaceRuntime.capability(true);
    await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime });
    const { projectId, longToken } = authorizeSharedServiceProject();

    const catalog = await request(server, 'GET', `/api/projects/${projectId}/agent-runtime-providers`, longToken);

    expect(catalog.status).toBe(200);
    expect(catalog.body.items.find((item: any) => item.id === 'open-design')).toMatchObject({
      implementationStatus: 'available',
      healthy: false,
      selectable: false,
      resourcePolicyEnforcedPerSession: false,
      reason: 'OpenDesign image ghcr.io/inernoro/prd_agent/opendesign-runtime@sha256:c4d2d53a21fa31adfb8b4b0dc189d6e8db3b7543f93c231c3574a75baf33f474 is being prepared on this CDS node',
    });
  });

  it('releases ordinary OpenDesign creation failures after credential-safe diagnostics', async () => {
    const events: Array<Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string }> = [];
    const serverEventLogStore: ServerEventLogSink = {
      record(event) {
        events.push(event);
      },
    };
    const workspaceRuntime = {
      async capability() {
        return { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
      },
      async create() {
        throw new AgentWorkspaceRuntimeError(
          'workspace_container_create_failed',
          'OpenDesign container failed to be created',
          true,
          {
            stage: 'docker_create',
            exitCode: 125,
            stderrPreview: 'permission denied OD_API_TOKEN=***[masked]***',
            stdoutPreview: '',
          },
        );
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime, serverEventLogStore });
    const { projectId, longToken } = authorizeSharedServiceProject();
    const fullCommand = "docker create --env-file /dev/stdin 'private-image'";

    const failed = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      {
        runtime: 'open-design',
        workloadKind: 'design-artifact',
        model: 'map-managed',
        modelBaseUrl: 'https://map.example.test/api/design-artifacts/runtime/run-1/llm/v1',
        modelProtocol: 'openai',
        modelApiKey: 'model-secret',
        workspaceTransfer: {
          schemaVersion: 'map-design-workspace-v1',
          inputPackageUrl: 'https://map.example.test/api/design-artifacts/runtime/run-1/input',
          resultCommitUrl: 'https://map.example.test/api/design-artifacts/runtime/run-1/result',
          transferToken: 'transfer-secret',
          inputSha256: 'a'.repeat(64),
          baseRevision: 'revision-1',
          maxInputBytes: 1024 * 1024,
          maxOutputBytes: 1024 * 1024,
          allowedOutputPaths: ['index.html', 'manifest.json', 'assets/**'],
        },
        resourcePolicy: {
          cpuCores: 1,
          memoryMb: 768,
          timeoutSeconds: 120,
          networkPolicy: 'egress-only',
          autoCleanupMinutes: 5,
        },
      },
    );

    expect(failed.status).toBe(503);
    expect(failed.body).not.toHaveProperty('item');
    expect(failed.body.error).toMatchObject({
      code: 'workspace_container_create_failed',
      message: 'OpenDesign container failed to be created',
      retryable: true,
      details: { stage: 'docker_create', exitCode: 125 },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'container',
      severity: 'error',
      source: 'agent-workspace-session-runtime',
      action: 'agent-workspace-session.create.failed',
      message: 'OpenDesign workspace session creation failed',
      projectId,
      status: 'failed',
      exitCode: 125,
      error: {
        code: 'workspace_container_create_failed',
        message: 'OpenDesign workspace session creation failed',
      },
      details: {
        sessionId: expect.any(String),
        runtime: 'open-design',
        code: 'workspace_container_create_failed',
        retryable: true,
        stage: 'docker_create',
        exitCode: 125,
        stderrPreview: 'permission denied OD_API_TOKEN=***[masked]***',
        stdoutPreview: '',
      },
    });
    const serializedEvent = JSON.stringify(events[0]);
    expect(serializedEvent).not.toContain('model-secret');
    expect(serializedEvent).not.toContain('transfer-secret');
    expect(serializedEvent).not.toContain(fullCommand);
    expect(serializedEvent).not.toContain('workspaceTransfer');
    expect(serializedEvent).not.toContain('modelApiKey');

    const failedSessionId = String(events[0].details?.sessionId || '');
    expect(failedSessionId).not.toBe('');
    const missing = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions/${failedSessionId}`,
      longToken,
    );
    expect(missing.status).toBe(404);
  });

  it('rejects credentialed OpenDesign model URLs before creating or observing a session', async () => {
    const serverEvents: Array<Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string }> = [];
    const activities: Array<Record<string, unknown>> = [];
    let createCalls = 0;
    const unsubscribe = cdsEventsBus.subscribe((event) => {
      if (event.type === 'agent-session.activity') {
        activities.push(event.data as Record<string, unknown>);
      }
    });
    const workspaceRuntime = {
      async capability() {
        return { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
      },
      async create() {
        createCalls += 1;
        throw new Error('create must not be reached');
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    const serverEventLogStore: ServerEventLogSink = {
      record(event) {
        serverEvents.push(event);
      },
    };

    try {
      await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime, serverEventLogStore });
      const { projectId, longToken } = authorizeSharedServiceProject();
      const failed = await request(
        server,
        'POST',
        `/api/projects/${projectId}/agent-sessions`,
        longToken,
        {
          runtime: 'open-design',
          workloadKind: 'design-artifact',
          model: 'map-managed',
          modelBaseUrl: 'https://url-user:url-password@map.example.test/api?token=url-token#url-fragment',
          modelProtocol: 'openai',
          modelApiKey: 'model-secret-url-validation',
          workspaceTransfer: {
            schemaVersion: 'map-design-workspace-v1',
            inputPackageUrl: 'https://map.example.test/api/design-artifacts/runtime/run-url/input',
            resultCommitUrl: 'https://map.example.test/api/design-artifacts/runtime/run-url/result',
            transferToken: 'transfer-secret-url-validation',
            inputSha256: 'a'.repeat(64),
            baseRevision: 'revision-url',
            maxInputBytes: 1024 * 1024,
            maxOutputBytes: 1024 * 1024,
            allowedOutputPaths: ['index.html', 'manifest.json', 'assets/**'],
          },
          resourcePolicy: {
            cpuCores: 1,
            memoryMb: 768,
            timeoutSeconds: 120,
            networkPolicy: 'egress-only',
            autoCleanupMinutes: 5,
          },
        },
      );
      expect(failed.status).toBe(422);
      expect(failed.body.error).toMatchObject({
        code: 'workspace_transfer_invalid',
        message: 'modelBaseUrl cannot contain credentials, query parameters, or fragments',
      });
      expect(createCalls).toBe(0);

      const sessions = await request(
        server,
        'GET',
        `/api/projects/${projectId}/agent-sessions`,
        longToken,
      );
      expect(sessions.body.items).toEqual([]);
      expect(serverEvents).toEqual([]);
      expect(activities).toEqual([]);
      const observable = JSON.stringify({ failed, sessions, serverEvents, activities });
      for (const credential of ['url-user', 'url-password', 'url-token', 'url-fragment']) {
        expect(observable).not.toContain(credential);
      }
    } finally {
      unsubscribe();
    }
  });

  it('retains OpenDesign creation cleanup failures until the runtime janitor confirms cleanup', async () => {
    process.env.CDS_AGENT_SESSION_HOST_LIMIT = '10';
    process.env.CDS_AGENT_SESSION_PROJECT_LIMIT = '10';
    process.env.CDS_AGENT_SESSION_PRINCIPAL_LIMIT = '1';
    const modelSecret = 'model-secret-create-cleanup';
    const transferSecret = 'transfer-secret-create-cleanup';
    const cleanupSecret = 'cleanup-secret-create';
    const events: Array<Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string }> = [];
    let createCalls = 0;
    let runtimeRetainsPartialCleanup = false;
    let cleanupSettled: ((error?: unknown) => void) | undefined;
    const workspaceRuntime = {
      async capability() {
        return { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
      },
      async create(
        _sessionId: string,
        _transfer: unknown,
        _policy: unknown,
        _onStage: unknown,
        onCleanupSettled: (error?: unknown) => void,
      ) {
        createCalls += 1;
        cleanupSettled = onCleanupSettled;
        runtimeRetainsPartialCleanup = true;
        throw new AgentWorkspaceRuntimeError(
          'workspace_cleanup_failed',
          `creation cleanup failed ${modelSecret} token=${cleanupSecret}`,
          true,
          {
            cleanupErrors: [`volume cleanup failed with Bearer ${transferSecret}`],
            authorization: `Bearer ${cleanupSecret}`,
          },
        );
      },
      async stop() {},
      has() {
        return runtimeRetainsPartialCleanup;
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    const serverEventLogStore: ServerEventLogSink = {
      record(event) {
        events.push(event);
      },
    };
    await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime, serverEventLogStore });
    const { projectId, longToken } = authorizeSharedServiceProject();
    const createBody = {
      runtime: 'open-design',
      workloadKind: 'design-artifact',
      model: 'map-managed',
      modelBaseUrl: 'https://map.example.test/api/design-artifacts/runtime/run-create-cleanup/llm/v1',
      modelProtocol: 'openai',
      modelApiKey: modelSecret,
      workspaceTransfer: {
        schemaVersion: 'map-design-workspace-v1',
        inputPackageUrl: 'https://map.example.test/api/design-artifacts/runtime/run-create-cleanup/input',
        resultCommitUrl: 'https://map.example.test/api/design-artifacts/runtime/run-create-cleanup/result',
        transferToken: transferSecret,
        inputSha256: 'a'.repeat(64),
        baseRevision: 'revision-create-cleanup',
        maxInputBytes: 1024 * 1024,
        maxOutputBytes: 1024 * 1024,
        allowedOutputPaths: ['index.html', 'manifest.json', 'assets/**'],
      },
      resourcePolicy: {
        cpuCores: 1,
        memoryMb: 768,
        timeoutSeconds: 120,
        networkPolicy: 'egress-only',
        autoCleanupMinutes: 5,
      },
    };

    const failed = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      createBody,
    );
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('workspace_cleanup_failed');
    expect(failed.body.item).toMatchObject({
      status: 'failed',
      resourceCleanupPending: true,
    });
    const sessionId = failed.body.item.id;

    const retained = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions/${sessionId}`,
      longToken,
    );
    expect(retained.status).toBe(200);
    expect(retained.body.item.resourceCleanupPending).toBe(true);

    const rejected = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      { runtime: 'fake' },
    );
    expect(rejected.status).toBe(429);
    expect(rejected.body.error.code).toBe('agent_session_principal_limit_exceeded');
    expect(createCalls).toBe(1);

    const [stream, logs] = await Promise.all([
      request(server, 'GET', `/api/projects/${projectId}/agent-sessions/${sessionId}/stream`, longToken),
      request(server, 'GET', `/api/projects/${projectId}/agent-sessions/${sessionId}/logs`, longToken),
    ]);
    const observable = JSON.stringify({ failed, retained, stream, logs, events });
    expect(observable).toContain('***[masked]***');
    expect(observable).not.toContain(modelSecret);
    expect(observable).not.toContain(transferSecret);
    expect(observable).not.toContain(cleanupSecret);

    runtimeRetainsPartialCleanup = false;
    cleanupSettled?.();
    const stopped = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions/${sessionId}`,
      longToken,
    );
    expect(stopped.body.item).toMatchObject({
      status: 'stopped',
      resourceCleanupPending: false,
    });

    const replacement = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      { runtime: 'fake' },
    );
    expect(replacement.status).toBe(201);
  });

  it('redacts OpenDesign execution credentials from session events, logs, activity, and diagnostics', async () => {
    process.env.CDS_AGENT_SESSION_HOST_LIMIT = '10';
    process.env.CDS_AGENT_SESSION_PROJECT_LIMIT = '10';
    process.env.CDS_AGENT_SESSION_PRINCIPAL_LIMIT = '1';
    const modelSecret = 'model-secret-execution';
    const transferSecret = 'transfer-secret-execution';
    const bearerSecret = 'bearer-secret-execution';
    const serverEvents: Array<Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string }> = [];
    const activities: Array<Record<string, unknown>> = [];
    const stopCalls: Array<{ sessionId: string; reason: string }> = [];
    let runtimeRetainsSession = false;
    const unsubscribe = cdsEventsBus.subscribe((event) => {
      if (event.type === 'agent-session.activity') {
        activities.push(event.data as Record<string, unknown>);
      }
    });
    const workspaceRuntime = {
      async capability() {
        return { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
      },
      async create() {
        runtimeRetainsSession = true;
        return {
          hostRoot: '/host/session',
          workspaceDir: '/host/session/workspace',
          containerName: 'cds-od-redaction-test',
          networkName: 'cds-od-redaction-net',
          daemonBaseUrl: 'http://172.19.0.2:7456',
          inputFileCount: 1,
        };
      },
      async execute() {
        throw new AgentWorkspaceRuntimeError(
          'open_design_execution_failed',
          `runtime rejected ${modelSecret} and ${transferSecret}; Bearer ${bearerSecret}`,
          false,
          {
            stderrPreview: `apiKey=${modelSecret} token=${transferSecret}`,
            authorization: `Bearer ${modelSecret}`,
            nested: {
              transferToken: transferSecret,
              password: 'unrelated-password-secret',
            },
          },
        );
      },
      async stop(sessionId: string, reason: string) {
        stopCalls.push({ sessionId, reason });
        runtimeRetainsSession = false;
      },
      has() {
        return runtimeRetainsSession;
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    const serverEventLogStore: ServerEventLogSink = {
      record(event) {
        serverEvents.push(event);
      },
    };

    try {
      await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime, serverEventLogStore });
      const { projectId, longToken } = authorizeSharedServiceProject();
      const created = await request(
        server,
        'POST',
        `/api/projects/${projectId}/agent-sessions`,
        longToken,
        {
          runtime: 'open-design',
          workloadKind: 'design-artifact',
          model: 'map-managed',
          modelBaseUrl: 'https://map.example.test/api/design-artifacts/runtime/run-redaction/llm/v1',
          modelProtocol: 'openai',
          modelApiKey: modelSecret,
          workspaceTransfer: {
            schemaVersion: 'map-design-workspace-v1',
            inputPackageUrl: 'https://map.example.test/api/design-artifacts/runtime/run-redaction/input',
            resultCommitUrl: 'https://map.example.test/api/design-artifacts/runtime/run-redaction/result',
            transferToken: transferSecret,
            inputSha256: 'a'.repeat(64),
            baseRevision: 'revision-redaction',
            maxInputBytes: 1024 * 1024,
            maxOutputBytes: 1024 * 1024,
            allowedOutputPaths: ['index.html', 'manifest.json', 'assets/**'],
          },
          resourcePolicy: {
            cpuCores: 1,
            memoryMb: 768,
            timeoutSeconds: 120,
            networkPolicy: 'egress-only',
            autoCleanupMinutes: 5,
          },
        },
      );
      expect(created.status).toBe(201);
      const sessionId = created.body.item.id;

      const sent = await request(
        server,
        'POST',
        `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
        longToken,
        { content: 'trigger redacted failure' },
      );
      expect(sent.status).toBe(202);
      await waitFor(async () => {
        const current = await request(server, 'GET', `/api/projects/${projectId}/agent-sessions/${sessionId}`, longToken);
        return current.body.item.status === 'failed';
      });

      const [stream, logs, current] = await Promise.all([
        request(server, 'GET', `/api/projects/${projectId}/agent-sessions/${sessionId}/stream`, longToken),
        request(server, 'GET', `/api/projects/${projectId}/agent-sessions/${sessionId}/logs`, longToken),
        request(server, 'GET', `/api/projects/${projectId}/agent-sessions/${sessionId}`, longToken),
      ]);
      const observable = JSON.stringify({ sent, stream, logs, current, activities, serverEvents });
      expect(observable).toContain('***[masked]***');
      expect(observable).not.toContain(modelSecret);
      expect(observable).not.toContain(transferSecret);
      expect(observable).not.toContain(bearerSecret);
      expect(observable).not.toContain('unrelated-password-secret');
      expect(logs.body.logs).toContain('OpenDesign workspace execution failed');
      expect(logs.body.logs).toContain('resources cleaned after execution failure');
      expect(activities.some((activity) => activity.eventType === 'error')).toBe(true);
      expect(serverEvents).toHaveLength(1);
      expect(stopCalls).toEqual([{ sessionId, reason: 'execution_failed' }]);
      const retryFailedSession = await request(
        server,
        'POST',
        `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
        longToken,
        { content: 'must not restart a terminal failed session' },
      );
      expect(retryFailedSession.status).toBe(409);
      expect(retryFailedSession.body.error.code).toBe('session_failed');
      const replacement = await request(
        server,
        'POST',
        `/api/projects/${projectId}/agent-sessions`,
        longToken,
        { runtime: 'fake' },
      );
      expect(replacement.status).toBe(201);
    } finally {
      unsubscribe();
    }
  });

  it('does not let an aborted OpenDesign execute failure race a requested stop', async () => {
    let runtimeRetainsSession = false;
    let executeStarted = false;
    const stopCalls: Array<{ sessionId: string; reason: string }> = [];
    const workspaceRuntime = {
      async capability() {
        return { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
      },
      async create() {
        runtimeRetainsSession = true;
        return {
          hostRoot: '/host/session',
          workspaceDir: '/host/session/workspace',
          containerName: 'cds-od-stop-race-test',
          networkName: 'cds-od-stop-race-net',
          daemonBaseUrl: 'http://172.19.0.2:7456',
          inputFileCount: 1,
        };
      },
      async execute(
        _sessionId: string,
        _content: string,
        _model: unknown,
        _transferToken: string,
        signal?: AbortSignal,
      ) {
        executeStarted = true;
        return new Promise((_, reject) => {
          const abort = () => reject(new AgentWorkspaceRuntimeError(
            'open_design_run_cancelled',
            'OpenDesign run was cancelled',
          ));
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      },
      async stop(sessionId: string, reason: string) {
        stopCalls.push({ sessionId, reason });
        runtimeRetainsSession = false;
      },
      has() {
        return runtimeRetainsSession;
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime });
    const { projectId, longToken } = authorizeSharedServiceProject();
    const created = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      {
        runtime: 'open-design',
        workloadKind: 'design-artifact',
        model: 'map-managed',
        modelBaseUrl: 'https://map.example.test/api/design-artifacts/runtime/run-stop-race/llm/v1',
        modelProtocol: 'openai',
        modelApiKey: 'model-secret-stop-race',
        workspaceTransfer: {
          schemaVersion: 'map-design-workspace-v1',
          inputPackageUrl: 'https://map.example.test/api/design-artifacts/runtime/run-stop-race/input',
          resultCommitUrl: 'https://map.example.test/api/design-artifacts/runtime/run-stop-race/result',
          transferToken: 'transfer-secret-stop-race',
          inputSha256: 'a'.repeat(64),
          baseRevision: 'revision-stop-race',
          maxInputBytes: 1024 * 1024,
          maxOutputBytes: 1024 * 1024,
          allowedOutputPaths: ['index.html', 'manifest.json', 'assets/**'],
        },
        resourcePolicy: {
          cpuCores: 1,
          memoryMb: 768,
          timeoutSeconds: 120,
          networkPolicy: 'egress-only',
          autoCleanupMinutes: 5,
        },
      },
    );
    const sessionId = created.body.item.id;
    const sent = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: 'hold until stopped' },
    );
    expect(sent.status).toBe(202);
    await waitFor(() => executeStarted);

    const stopped = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/stop`,
      longToken,
      {},
    );
    expect(stopped.status).toBe(200);
    expect(stopped.body.item.status).toBe('stopped');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const current = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions/${sessionId}`,
      longToken,
    );
    expect(current.body.item.status).toBe('stopped');
    expect(current.body.item.resourceCleanupPending).toBe(false);
    expect(stopCalls).toEqual([{ sessionId, reason: 'session_stop_requested' }]);
    expect(JSON.stringify(current.body.item)).not.toContain('execution_failed_resources_cleaned');
  });

  it('keeps failed OpenDesign sessions in capacity while runtime cleanup remains incomplete', async () => {
    process.env.CDS_AGENT_SESSION_HOST_LIMIT = '10';
    process.env.CDS_AGENT_SESSION_PROJECT_LIMIT = '10';
    process.env.CDS_AGENT_SESSION_PRINCIPAL_LIMIT = '1';
    const modelSecret = 'model-secret-cleanup';
    const transferSecret = 'transfer-secret-cleanup';
    const cleanupSecret = 'cleanup-command-secret';
    const serverEvents: Array<Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string }> = [];
    let runtimeRetainsSession = false;
    let stopCalls = 0;
    const workspaceRuntime = {
      async capability() {
        return { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
      },
      async create() {
        runtimeRetainsSession = true;
        return {
          hostRoot: '/host/session',
          workspaceDir: '/host/session/workspace',
          containerName: 'cds-od-cleanup-failure-test',
          networkName: 'cds-od-cleanup-failure-net',
          daemonBaseUrl: 'http://172.19.0.2:7456',
          inputFileCount: 1,
        };
      },
      async execute() {
        throw new AgentWorkspaceRuntimeError('open_design_execution_failed', 'execution failed');
      },
      async stop() {
        stopCalls += 1;
        throw new AgentWorkspaceRuntimeError(
          'workspace_cleanup_failed',
          `cleanup failed token=${cleanupSecret} apiKey=${modelSecret}`,
          true,
          {
            cleanupErrors: [`docker rm failed with Bearer ${transferSecret}`],
            authorization: `Bearer ${cleanupSecret}`,
          },
        );
      },
      has() {
        return runtimeRetainsSession;
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    const serverEventLogStore: ServerEventLogSink = {
      record(event) {
        serverEvents.push(event);
      },
    };
    await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime, serverEventLogStore });
    const { projectId, longToken } = authorizeSharedServiceProject();
    const created = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      {
        runtime: 'open-design',
        workloadKind: 'design-artifact',
        model: 'map-managed',
        modelBaseUrl: 'https://map.example.test/api/design-artifacts/runtime/run-cleanup/llm/v1',
        modelProtocol: 'openai',
        modelApiKey: modelSecret,
        workspaceTransfer: {
          schemaVersion: 'map-design-workspace-v1',
          inputPackageUrl: 'https://map.example.test/api/design-artifacts/runtime/run-cleanup/input',
          resultCommitUrl: 'https://map.example.test/api/design-artifacts/runtime/run-cleanup/result',
          transferToken: transferSecret,
          inputSha256: 'a'.repeat(64),
          baseRevision: 'revision-cleanup',
          maxInputBytes: 1024 * 1024,
          maxOutputBytes: 1024 * 1024,
          allowedOutputPaths: ['index.html', 'manifest.json', 'assets/**'],
        },
        resourcePolicy: {
          cpuCores: 1,
          memoryMb: 768,
          timeoutSeconds: 120,
          networkPolicy: 'egress-only',
          autoCleanupMinutes: 5,
        },
      },
    );
    expect(created.status).toBe(201);
    const sessionId = created.body.item.id;
    const sent = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: 'trigger cleanup failure' },
    );
    expect(sent.status).toBe(202);
    await waitFor(async () => {
      const current = await request(server, 'GET', `/api/projects/${projectId}/agent-sessions/${sessionId}`, longToken);
      return current.body.item.status === 'failed' && stopCalls === 1;
    });

    const rejected = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      { runtime: 'fake' },
    );
    expect(rejected.status).toBe(429);
    expect(rejected.body.error.code).toBe('agent_session_principal_limit_exceeded');

    const [stream, logs] = await Promise.all([
      request(server, 'GET', `/api/projects/${projectId}/agent-sessions/${sessionId}/stream`, longToken),
      request(server, 'GET', `/api/projects/${projectId}/agent-sessions/${sessionId}/logs`, longToken),
    ]);
    const observable = JSON.stringify({ stream, logs, serverEvents });
    expect(observable).toContain('workspace_cleanup_failed');
    expect(observable).toContain('***[masked]***');
    expect(observable).not.toContain(modelSecret);
    expect(observable).not.toContain(transferSecret);
    expect(observable).not.toContain(cleanupSecret);
    expect(serverEvents.map((event) => event.action)).toEqual([
      'agent-workspace-session.execute.failed',
      'agent-workspace-session.cleanup.failed',
    ]);
  });

  it('limits active agent sessions per principal and releases capacity after stop', async () => {
    process.env.CDS_AGENT_SESSION_HOST_LIMIT = '10';
    process.env.CDS_AGENT_SESSION_PROJECT_LIMIT = '10';
    process.env.CDS_AGENT_SESSION_PRINCIPAL_LIMIT = '1';
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();

    const first = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, { runtime: 'fake' });
    const rejected = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, { runtime: 'fake' });

    expect(first.status).toBe(201);
    expect(rejected.status).toBe(429);
    expect(rejected.body.error).toMatchObject({
      code: 'agent_session_principal_limit_exceeded',
      dimension: 'principal',
      limit: 1,
      activeCount: 1,
      retryable: true,
    });

    const stopped = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${first.body.item.id}/stop`,
      longToken,
      {},
    );
    expect(stopped.status).toBe(200);
    const replacement = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, { runtime: 'fake' });
    expect(replacement.status).toBe(201);
  });

  it('limits active agent sessions per project', async () => {
    process.env.CDS_AGENT_SESSION_HOST_LIMIT = '10';
    process.env.CDS_AGENT_SESSION_PROJECT_LIMIT = '1';
    process.env.CDS_AGENT_SESSION_PRINCIPAL_LIMIT = '10';
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();

    const first = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, { runtime: 'fake' });
    const rejected = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, { runtime: 'fake' });

    expect(first.status).toBe(201);
    expect(rejected.status).toBe(429);
    expect(rejected.body.error).toMatchObject({
      code: 'agent_session_project_limit_exceeded',
      dimension: 'project',
      limit: 1,
      activeCount: 1,
    });
  });

  it('limits active agent sessions across projects on the host', async () => {
    process.env.CDS_AGENT_SESSION_HOST_LIMIT = '1';
    process.env.CDS_AGENT_SESSION_PROJECT_LIMIT = '10';
    process.env.CDS_AGENT_SESSION_PRINCIPAL_LIMIT = '10';
    await startServer();
    const firstAuth = authorizeSharedServiceProject({ projectId: 'shared-pool-a', partnerId: 'map-a' });
    const secondAuth = authorizeSharedServiceProject({ projectId: 'shared-pool-b', partnerId: 'map-b' });

    const first = await request(server, 'POST', `/api/projects/${firstAuth.projectId}/agent-sessions`, firstAuth.longToken, { runtime: 'fake' });
    const rejected = await request(server, 'POST', `/api/projects/${secondAuth.projectId}/agent-sessions`, secondAuth.longToken, { runtime: 'fake' });

    expect(first.status).toBe(201);
    expect(rejected.status).toBe(429);
    expect(rejected.body.error).toMatchObject({
      code: 'agent_session_host_limit_exceeded',
      dimension: 'host',
      limit: 1,
      activeCount: 1,
    });
  });

  it('routes OpenDesign through the injected workspace runtime and exposes only committed result facts', async () => {
    const calls: Array<{ kind: string; value: unknown }> = [];
    let completeExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      completeExecution = resolve;
    });
    const workspaceRuntime = {
      async capability() {
        return { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
      },
      async create(sessionId: string, transfer: any, policy: any, onStage: (stage: string) => void) {
        calls.push({ kind: 'create', value: { sessionId, transfer, policy } });
        onStage('workspace_materialized');
        return {
          hostRoot: '/host/session',
          workspaceDir: '/host/session/workspace',
          containerName: 'cds-od-test',
          networkName: 'cds-od-net-test',
          daemonBaseUrl: 'http://172.19.0.2:7456',
          inputFileCount: 2,
        };
      },
      async execute(
        sessionId: string,
        instruction: string,
        model: any,
        transferToken: string,
        _signal: AbortSignal,
        onStage: (stage: string) => void,
      ) {
        calls.push({ kind: 'execute', value: { sessionId, instruction, model, transferToken } });
        onStage('workspace_collecting');
        await executionGate;
        onStage('workspace_committing');
        return {
          artifactRef: 'design-artifact:run-1',
          resultSha256: 'b'.repeat(64),
          files: [
            { path: 'index.html', sha256: 'c'.repeat(64), size: 120, mediaType: 'text/html; charset=utf-8' },
            { path: 'manifest.json', sha256: 'd'.repeat(64), size: 220, mediaType: 'application/json; charset=utf-8' },
          ],
          openDesignRunId: 'od-run-1',
        };
      },
      async stop(sessionId: string, reason: string) {
        calls.push({ kind: 'stop', value: { sessionId, reason } });
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime });
    const { projectId, longToken } = authorizeSharedServiceProject();
    const transfer = {
      schemaVersion: 'map-design-workspace-v1',
      inputPackageUrl: 'https://map.example.test/api/design-artifacts/runtime/run-1/input',
      resultCommitUrl: 'https://map.example.test/api/design-artifacts/runtime/run-1/result',
      transferToken: 'transfer-secret',
      inputSha256: 'a'.repeat(64),
      baseRevision: 'revision-1',
      maxInputBytes: 1024 * 1024,
      maxOutputBytes: 1024 * 1024,
      allowedOutputPaths: ['index.html', 'manifest.json', 'assets/**'],
    };

    const catalog = await request(server, 'GET', `/api/projects/${projectId}/agent-runtime-providers`, longToken);
    expect(catalog.body.items.find((item: any) => item.id === 'open-design')).toMatchObject({
      healthy: true,
      selectable: true,
      resourcePolicyEnforcedPerSession: true,
    });

    const created = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      {
        runtime: 'open-design',
        workloadKind: 'design-artifact',
        model: 'map-managed',
        modelBaseUrl: 'HTTPS://MAP.EXAMPLE.TEST:443/api/design-artifacts/runtime/run-1/llm/v1',
        modelProtocol: 'openai',
        modelApiKey: 'model-secret',
        workspaceTransfer: transfer,
        resourcePolicy: {
          cpuCores: 1,
          memoryMb: 768,
          timeoutSeconds: 120,
          networkPolicy: 'egress-only',
          autoCleanupMinutes: 5,
        },
      },
    );

    expect(created.status).toBe(201);
    expect(created.body.item).toMatchObject({
      runtime: 'open-design',
      workloadKind: 'design-artifact',
      containerName: 'cds-od-test',
      workspaceRoot: '/workspace',
      hasModelApiKey: true,
      modelBaseUrl: 'https://map.example.test/api/design-artifacts/runtime/run-1/llm/v1',
      workspaceTransfer: {
        schemaVersion: 'map-design-workspace-v1',
        inputSha256: 'a'.repeat(64),
        baseRevision: 'revision-1',
      },
    });
    expect(JSON.stringify(created.body.item)).not.toContain('transfer-secret');
    expect(JSON.stringify(created.body.item)).not.toContain('model-secret');
    expect(JSON.stringify(created.body.item)).not.toContain('inputPackageUrl');
    const sessionId = created.body.item.id;

    const sent = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: '将页面调整为清晰的产品发布页' },
    );
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ accepted: true, runtimeOwnedBy: 'cds-agent-workspace-session' });

    expect(calls.find((call) => call.kind === 'execute')?.value).toMatchObject({
      instruction: '将页面调整为清晰的产品发布页',
      model: {
        baseUrl: 'https://map.example.test/api/design-artifacts/runtime/run-1/llm/v1',
        apiKey: 'model-secret',
        model: 'map-managed',
      },
      transferToken: 'transfer-secret',
    });
    const firstStream = streamRequest(
      server,
      `/api/projects/${projectId}/agent-sessions/${sessionId}/stream?follow=true`,
      longToken,
    );
    const firstEvent = await firstStream.firstEvent;
    const firstCursor = Number(firstEvent.match(/^id: (\d+)$/m)?.[1]);
    expect(firstCursor).toBeGreaterThan(0);
    firstStream.abort();
    await firstStream.completed;

    const running = await request(server, 'GET', `/api/projects/${projectId}/agent-sessions/${sessionId}`, longToken);
    expect(running.body.item.status).toBe('running');

    const resumedStream = streamRequest(
      server,
      `/api/projects/${projectId}/agent-sessions/${sessionId}/stream?afterSeq=${firstCursor}&follow=true`,
      longToken,
    );
    const resumedFirstEvent = await resumedStream.firstEvent;
    expect(Number(resumedFirstEvent.match(/^id: (\d+)$/m)?.[1])).toBeGreaterThan(firstCursor);

    // 直到断线续接后的流已经收到回放事件才允许异步 runtime 完成。旧的一次性快照实现
    // 会在此时提前关闭，因此绝不可能把随后产生的 done 带回 MAP。
    completeExecution();
    const stream = await resumedStream.completed;
    expect(stream.status).toBe(200);
    expect(stream.body).toContain('CDS 正在校验生成文件与安全边界。');
    expect(stream.body).toContain('CDS 正在向 MAP 提交已校验的结果。');
    expect(stream.body).toContain('design-artifact:run-1');
    expect(stream.body).toContain('event: done');
    expect(stream.body).not.toContain(`id: ${firstCursor}\n`);
    expect(stream.body).not.toContain('model-secret');
    expect(stream.body).not.toContain('transfer-secret');

    await waitFor(async () => {
      const current = await request(server, 'GET', `/api/projects/${projectId}/agent-sessions/${sessionId}`, longToken);
      return current.body.item.status === 'idle';
    });

    const stopped = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/stop`,
      longToken,
      {},
    );
    expect(stopped.status).toBe(200);
    expect(calls.find((call) => call.kind === 'stop')?.value).toEqual({
      sessionId,
      reason: 'session_stop_requested',
    });
  });

  it('reconciles CDS-managed official SDK runtime capacity without remote host fallback', async () => {
    process.env.CDS_PREVIEW_DOMAIN = 'preview.example.test';
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();

    const planned = await request(
      server,
      'POST',
      `/api/projects/${projectId}/runtime-capacity/reconcile`,
      longToken,
      { apply: false },
    );

    expect(planned.status).toBe(200);
    expect(planned.body).toMatchObject({
      requirement: 'CDS_MANAGED_RUNTIME_CAPACITY',
      applied: false,
      status: 'planned',
      runtimeOwnedBy: 'cds-managed-runtime',
      loopOwner: 'claude-agent-sdk',
      productPathOnly: true,
      fallbackScope: 'operator-debug-only',
    });
    expect(planned.body.plan.map((step: any) => step.step)).toEqual([
      'ensure-build-profile',
      'ensure-branch-service',
      'start-cds-managed-container',
      'verify-product-capacity',
    ]);
    expect(JSON.stringify(planned.body)).not.toContain('CDS_REMOTE_HOST');

    const runtime = await startMockOfficialSdkRuntime();
    const applied = await request(
      server,
      'POST',
      `/api/projects/${projectId}/runtime-capacity/reconcile`,
      longToken,
      { apply: true, hostPort: runtime.port },
    );

    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      requirement: 'CDS_MANAGED_RUNTIME_CAPACITY',
      applied: true,
      status: 'available',
      runtimeOwnedBy: 'cds-managed-runtime',
      loopOwner: 'claude-agent-sdk',
      productPathOnly: true,
      fallbackScope: 'operator-debug-only',
      profileId: 'claude-agent-sdk-runtime-shared-sidecar-pool',
      branch: 'cds-managed-runtime',
      containerName: 'cds-claude-agent-sdk-runtime-shared-sidecar-pool',
      capacity: {
        status: 'available',
        productPath: {
          runningOfficialSdkRuntimeCount: 1,
        },
        legacyFallback: {
          enabledRemoteHostCount: 0,
          runningFallbackInstanceCount: 0,
          scope: 'operator-debug-only',
        },
      },
    });
    expect(applied.body.changes).toMatchObject({
      profile: 'created',
      branch: 'created',
      service: 'created',
    });
    expect(JSON.stringify(applied.body)).not.toContain('CDS_REMOTE_HOST');

    const available = await request(server, 'GET', `/api/projects/${projectId}/runtime-capacity`, longToken);
    expect(available.status).toBe(200);
    expect(available.body.instances[0]).toMatchObject({
      branch: 'cds-managed-runtime',
      capacityRole: 'product-runtime',
      runtimeOwnedBy: 'cds-managed-runtime',
      runtimeAdapter: 'claude-agent-sdk',
      loopOwner: 'claude-agent-sdk',
      baseUrl: 'https://cds-managed-runtime-shared-sidecar-pool.preview.example.test',
    });

    const created = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      { runtime: 'claude-sdk', model: 'claude-sonnet-4-20250514' },
    );
    expect(created.status).toBe(201);

    const sent = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${created.body.item.id}/messages`,
      longToken,
      { content: 'verify reconciled runtime' },
    );

    expect(sent.status).toBe(202);
    expect(sent.body.accepted).toBe(true);
    expect(sent.body.transport).toMatchObject({
      source: 'cds-branch-service',
      runtimeOwnedBy: 'cds-managed-runtime',
      profileId: 'claude-agent-sdk-runtime-shared-sidecar-pool',
      runtimeAdapter: 'claude-agent-sdk',
      loopOwner: 'claude-agent-sdk',
    });
    expect(sent.body.transport.baseUrl).toBe(`http://127.0.0.1:${runtime.port}`);
    await waitFor(() => runtime.requests.length === 1);
    expect(runtime.requests).toHaveLength(1);
  });

  it('live-applies CDS-managed official SDK runtime through the injected CDS container service', async () => {
    process.env.CDS_PREVIEW_DOMAIN = 'preview.example.test';
    const containerCalls: any[] = [];
    await startServer({
      config: { portStart: 19000 },
      containerService: {
        async runService(branch, profile, service, onOutput, customEnv) {
          containerCalls.push({ kind: 'runService', branch, profile, service: { ...service }, customEnv });
          expect(branch.worktreePath).toBe(path.dirname(process.cwd()));
          expect(profile.id).toBe('claude-agent-sdk-runtime-shared-sidecar-pool');
          expect(profile.dockerImage).toBe('python:3.12-slim');
          expect(profile.command).toContain('apt-get install');
          expect(profile.command).toContain('git');
          expect(profile.command).toContain('pip install');
          expect(profile.env?.SIDECAR_AGENT_ADAPTER).toBe('claude-agent-sdk');
          expect(profile.env?.SIDECAR_PROVIDER_KEY_MODE).toBe('runtime-profile-or-env');
          expect(profile.env?.SIDECAR_TOKEN).toBe('dev-skip');
          expect(service.hostPort).toBeGreaterThanOrEqual(19000);
          onOutput?.('managed runtime container started');
        },
        async waitForReadiness(hostPort, probe, onAttempt) {
          containerCalls.push({ kind: 'waitForReadiness', hostPort, probe });
          expect(probe?.path).toBe('/readyz');
          onAttempt?.({ attempt: 1, max: 1, stage: 'http', ok: true });
          return true;
        },
      },
    });
    const { projectId, longToken } = authorizeSharedServiceProject();

    const applied = await request(
      server,
      'POST',
      `/api/projects/${projectId}/runtime-capacity/reconcile`,
      longToken,
      { apply: true, liveApply: true },
    );

    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      requirement: 'CDS_MANAGED_RUNTIME_CAPACITY',
      applied: true,
      status: 'available',
      runtimeOwnedBy: 'cds-managed-runtime',
      loopOwner: 'claude-agent-sdk',
      productPathOnly: true,
      liveApply: {
        requested: true,
        attempted: true,
        status: 'running',
        fallbackScope: 'operator-debug-only',
      },
      capacity: {
        status: 'available',
        productPath: {
          runningOfficialSdkRuntimeCount: 1,
        },
      },
    });
    expect(JSON.stringify(applied.body)).not.toContain('CDS_REMOTE_HOST');
    expect(containerCalls.map(call => call.kind)).toEqual(['runService', 'waitForReadiness']);

    const available = await request(server, 'GET', `/api/projects/${projectId}/runtime-capacity`, longToken);
    expect(available.status).toBe(200);
    expect(available.body.instances[0]).toMatchObject({
      branch: 'cds-managed-runtime',
      capacityRole: 'product-runtime',
      runtimeOwnedBy: 'cds-managed-runtime',
      runtimeAdapter: 'claude-agent-sdk',
      loopOwner: 'claude-agent-sdk',
    });

    const forced = await request(
      server,
      'POST',
      `/api/projects/${projectId}/runtime-capacity/reconcile`,
      longToken,
      { apply: true, liveApply: true, force: true },
    );

    expect(forced.status).toBe(200);
    expect(forced.body.applied).toBe(true);
    expect(containerCalls.map(call => call.kind)).toEqual([
      'runService',
      'waitForReadiness',
      'runService',
      'waitForReadiness',
    ]);
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
      {
        runtime: 'claude-sdk',
        model: 'deepseek/deepseek-v4-pro',
        modelBaseUrl: 'https://openrouter.ai/api',
        modelProtocol: 'anthropic',
        modelApiKey: 'provider-secret',
        runtimeProfileId: 'map-runtime-profile-id',
        gitRepository: 'inernoro/prd_agent',
        gitRef: 'main',
      },
    );

    expect(created.status).toBe(201);
    expect(created.body.item).toMatchObject({
      model: 'deepseek/deepseek-v4-pro',
      modelBaseUrl: 'https://openrouter.ai/api',
      modelProtocol: 'anthropic',
      hasModelApiKey: true,
      runtimeProfileId: 'map-runtime-profile-id',
      gitRepository: 'inernoro/prd_agent',
      gitRef: 'main',
    });
    expect(JSON.stringify(created.body.item)).not.toContain('provider-secret');
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
      {
        runtime: 'claude-sdk',
        model: 'deepseek/deepseek-v4-pro',
        modelBaseUrl: 'https://openrouter.ai/api',
        modelProtocol: 'anthropic',
        modelApiKey: 'provider-secret',
        runtimeProfileId: 'map-runtime-profile-id',
        gitRepository: 'inernoro/prd_agent',
        gitRef: 'main',
      },
    );

    expect(created.status).toBe(201);
    expect(created.body.item).toMatchObject({
      model: 'deepseek/deepseek-v4-pro',
      modelBaseUrl: 'https://openrouter.ai/api',
      modelProtocol: 'anthropic',
      hasModelApiKey: true,
      runtimeProfileId: 'map-runtime-profile-id',
      gitRepository: 'inernoro/prd_agent',
      gitRef: 'main',
    });
    expect(JSON.stringify(created.body.item)).not.toContain('provider-secret');
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
    expect(sent.body.item.status).toBe('running');
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
    await waitFor(() => runtime.requests.length === 1);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0].authorization).toBe('Bearer dev-skip');
    expect(runtime.requests[0].body).toMatchObject({
      runtimeAdapter: 'claude-agent-sdk',
      model: 'deepseek/deepseek-v4-pro',
      mapSessionId: sessionId,
      maxTurns: 40,
      baseUrl: 'https://openrouter.ai/api',
      apiKey: 'provider-secret',
      protocol: 'anthropic',
      gitRepository: 'inernoro/prd_agent',
      gitRef: 'main',
    });
    expect(runtime.requests[0].body).not.toHaveProperty('profile');

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

  it('fails CDS-managed runtime streams that end without a terminal frame', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    const runtime = await startMockOfficialSdkRuntime({ omitTerminal: true });
    addSharedOfficialSdkRuntime(projectId, runtime.port);

    const created = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      { runtime: 'claude-sdk', model: 'deepseek/deepseek-v4-pro' },
    );
    expect(created.status).toBe(201);
    const sessionId = created.body.item.id;

    const sent = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: 'runtime stream truncates before done' },
    );

    expect(sent.status).toBe(202);
    expect(sent.body.accepted).toBe(true);
    await waitFor(async () => {
      const current = await request(server, 'GET', `/api/projects/${projectId}/agent-sessions/${sessionId}`, longToken);
      return current.body.item.status === 'failed';
    });

    const stream = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/stream`,
      longToken,
    );
    expect(stream.status).toBe(200);
    expect(stream.body).toContain('cds_managed_runtime_missing_terminal_event');
  });

  it('aborts the in-flight CDS-managed runtime transport when an agent session is stopped', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    const runtime = await startMockOfficialSdkRuntime({ holdOpen: true });
    addSharedOfficialSdkRuntime(projectId, runtime.port);

    const created = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      { runtime: 'claude-sdk', model: 'deepseek/deepseek-v4-pro', resourcePolicy: { timeoutSeconds: 30 } },
    );
    expect(created.status).toBe(201);
    const sessionId = created.body.item.id;

    const sent = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: 'keep running until user stops' },
    );

    expect(sent.status).toBe(202);
    expect(sent.body.accepted).toBe(true);
    await waitFor(() => runtime.requests.length === 1);

    const stopped = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/stop`,
      longToken,
    );

    expect(stopped.status).toBe(200);
    expect(stopped.body.item.status).toBe('stopped');
    await waitFor(() => runtime.closedRequests.length === 1);

    const stream = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/stream`,
      longToken,
    );
    expect(stream.status).toBe(200);
    expect(stream.body).toContain('session_stopped');
    expect(stream.body).toContain('cds_managed_runtime_transport_aborted');
    expect(stream.body).not.toContain('cds_managed_runtime_transport_timeout');
  });

  it('rejects concurrent CDS-managed runtime messages before the background transport starts', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    const runtime = await startMockOfficialSdkRuntime({ holdOpen: true });
    addSharedOfficialSdkRuntime(projectId, runtime.port);

    const created = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      { runtime: 'claude-sdk', model: 'deepseek/deepseek-v4-pro', resourcePolicy: { timeoutSeconds: 30 } },
    );
    expect(created.status).toBe(201);
    const sessionId = created.body.item.id;

    const first = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: 'first long running request' },
    );
    const second = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: 'should be rejected while first is active' },
    );

    expect(first.status).toBe(202);
    expect(first.body.accepted).toBe(true);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('session_busy');
    await waitFor(() => runtime.requests.length === 1);

    const stopped = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/stop`,
      longToken,
    );
    expect(stopped.status).toBe(200);
    await waitFor(() => runtime.closedRequests.length === 1);
  });

  it('prefers the explicit CDS-managed runtime branch over stale main sidecars', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    const runtime = await startMockOfficialSdkRuntime();

    const profile: BuildProfile = {
      id: 'claude-agent-sdk-runtime',
      projectId,
      name: 'Claude Agent SDK Runtime',
      dockerImage: 'python:3.12-slim',
      workDir: 'claude-sdk-sidecar',
      command: 'uvicorn app.main:app --host 0.0.0.0 --port 7400',
      containerPort: 7400,
      env: {
        SIDECAR_AGENT_ADAPTER: 'claude-agent-sdk',
        SIDECAR_TOKEN: 'managed-token',
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
          containerName: 'old-main-sidecar',
          hostPort: 9,
          status: 'running',
        },
      },
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      githubCommitSha: 'oldmain',
    });
    stateService.addBranch({
      id: 'shared-runtime-managed',
      projectId,
      branch: 'cds-managed-runtime',
      worktreePath: path.join(tmpDir, 'shared-runtime-managed'),
      status: 'running',
      services: {
        'claude-agent-sdk-runtime': {
          profileId: 'claude-agent-sdk-runtime',
          containerName: 'cds-claude-agent-sdk-runtime',
          hostPort: runtime.port,
          status: 'running',
        },
      },
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      githubCommitSha: 'managed',
    });

    const created = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      {
        runtime: 'claude-sdk',
        model: 'deepseek/deepseek-v4-pro',
        modelBaseUrl: 'https://openrouter.ai/api',
        modelApiKey: 'provider-secret',
        runtimeProfileId: 'map-runtime-profile-id',
        gitRepository: 'inernoro/prd_agent',
        gitRef: 'main',
      },
    );
    expect(created.status).toBe(201);

    const sent = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${created.body.item.id}/messages`,
      longToken,
      { content: 'route through managed runtime' },
    );

    expect(sent.status).toBe(202);
    expect(sent.body.accepted).toBe(true);
    expect(sent.body.transport).toMatchObject({
      branch: 'cds-managed-runtime',
      containerName: 'cds-claude-agent-sdk-runtime',
      hostPort: runtime.port,
      profileId: 'claude-agent-sdk-runtime',
    });
    await waitFor(() => runtime.requests.length === 1);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0].body).toMatchObject({
      baseUrl: 'https://openrouter.ai/api',
      apiKey: 'provider-secret',
      gitRepository: 'inernoro/prd_agent',
      gitRef: 'main',
    });
    expect(runtime.requests[0].body).not.toHaveProperty('profile');
  });
});
