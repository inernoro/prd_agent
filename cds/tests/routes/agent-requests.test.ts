/*
 * Agent 请求观测台（2026-06-11）路由测试：
 * - 会话创建接受 title/clientUser/clientApp 标签并在视图中返回
 * - GET /projects/:id/agent-requests 聚合列表 + user/app/q 筛选
 * - 会话 stop 时摘要落持久层（重启后历史可查的根基）
 * - 结构性事件发布到全局总线（观测台实时行内更新）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRemoteHostsRouter } from '../../src/routes/remote-hosts.js';
import { AgentWorkspaceSessionRuntime } from '../../src/services/agent-workspace-session-runtime.js';
import { CdsPairingService } from '../../src/services/connection/pairing-service.js';
import { StateService } from '../../src/services/state.js';
import { cdsEventsBus } from '../../src/services/cds-events-bus.js';
import type { ExecResult, IShellExecutor, Project } from '../../src/types.js';

import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

describe('Agent requests observability routes', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  afterEach(async () => {
    await flushAllJsonStateStores();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function startServer(options: { agentWorkspaceSessionRuntime?: AgentWorkspaceSessionRuntime } = {}) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-requests-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    const app = express();
    app.use(express.json());
    app.use('/api', createRemoteHostsRouter({
      stateService,
      agentWorkspaceSessionRuntime: options.agentWorkspaceSessionRuntime,
    }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
  }

  async function waitForSession(projectId: string, token: string, sessionId: string, status: string) {
    let result: Awaited<ReturnType<typeof request>>;
    await vi.waitFor(async () => {
      result = await request(server, 'GET', `/api/projects/${projectId}/agent-sessions/${sessionId}`, token);
      expect(result.status).toBe(200);
      expect(result.body.item.status).toBe(status);
    });
    return result!;
  }

  function authorizeSharedServiceProject(options: {
    projectId?: string;
    partnerId?: string;
  } = {}): { projectId: string; longToken: string; connectionId: string } {
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
        projectIntent: { kind: 'shared-service', name: projectId },
      },
      (intent) => {
        const existing = stateService.getProject(projectId);
        if (existing) return existing;
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
    return {
      projectId: accepted.projectId,
      longToken: accepted.cdsLongToken,
      connectionId: accepted.connectionId,
    };
  }

  async function createSession(
    projectId: string,
    token: string,
    labels: { title?: string; clientUser?: string; clientApp?: string },
  ): Promise<string> {
    const res = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, token, {
      runtime: 'fake',
      model: 'fake-model',
      ...labels,
    });
    expect(res.status).toBe(201);
    return res.body.item.id as string;
  }

  function openDesignSessionBody(clientRequestId: string): Record<string, unknown> {
    return {
      runtime: 'open-design',
      workloadKind: 'design-artifact',
      model: 'map-managed',
      modelBaseUrl: 'https://map.example.test/api/runtime/llm/v1',
      modelProtocol: 'openai',
      modelApiKey: 'model-secret',
      clientRequestId,
      workspaceTransfer: {
        schemaVersion: 'map-design-workspace-v1',
        inputPackageUrl: 'https://map.example.test/api/runtime/input',
        resultCommitUrl: 'https://map.example.test/api/runtime/result',
        transferToken: 'transfer-secret',
        inputSha256: 'a'.repeat(64),
        baseRevision: `revision-${clientRequestId}`,
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
  }

  it('create accepts labels and view returns them', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    const res = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, {
      runtime: 'fake',
      model: 'fake-model',
      title: 'PPT 第6页',
      clientUser: 'user-123',
      clientApp: 'md-to-ppt',
      clientRequestId: 'request-labels-001',
    });
    expect(res.status).toBe(201);
    expect(res.body.item.title).toBe('PPT 第6页');
    expect(res.body.item.clientUser).toBe('user-123');
    expect(res.body.item.clientApp).toBe('md-to-ppt');
    expect(res.body.item.clientRequestId).toBe('request-labels-001');
  });

  it('replays the same client request as one stable session', async () => {
    await startServer();
    const { projectId, longToken, connectionId } = authorizeSharedServiceProject();
    const clientRequestId = 'request-idempotent-001';
    const first = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, {
      runtime: 'fake',
      model: 'fake-model',
      title: '首次创建',
      clientRequestId,
    });
    const replay = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, {
      runtime: 'fake',
      model: 'changed-model',
      title: '重试不应覆盖',
      clientRequestId,
    });

    const digest = crypto
      .createHash('sha256')
      .update(JSON.stringify([projectId, `connection:${connectionId}`, clientRequestId]))
      .digest('hex')
      .slice(0, 32);
    expect(first.status).toBe(201);
    expect(first.body.item.id).toBe(`cds-agent-${digest}`);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.item.id).toBe(first.body.item.id);
    expect(replay.body.item.createdAt).toBe(first.body.item.createdAt);
    expect(replay.body.item.title).toBe('首次创建');

    const found = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions?clientRequestId=${clientRequestId}`,
      longToken,
    );
    expect(found.status).toBe(200);
    expect(found.body.items).toHaveLength(1);
    expect(found.body.items[0].id).toBe(first.body.item.id);
  });

  it('deduplicates concurrent creation after asynchronous runtime capability checks', async () => {
    let capabilityCalls = 0;
    let createCalls = 0;
    let releaseCapabilities!: () => void;
    let reportCapabilityReached!: () => void;
    const capabilityGate = new Promise<void>((resolve) => {
      releaseCapabilities = resolve;
    });
    const capabilityReached = new Promise<void>((resolve) => {
      reportCapabilityReached = resolve;
    });
    const workspaceRuntime = {
      async capability() {
        capabilityCalls += 1;
        reportCapabilityReached();
        await capabilityGate;
        return { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
      },
      async create(sessionId: string) {
        createCalls += 1;
        return { containerName: `workspace-${sessionId}` };
      },
      has() {
        return false;
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime });
    const { projectId, longToken } = authorizeSharedServiceProject();
    const clientRequestId = 'request-concurrent-001';
    const body = {
      runtime: 'open-design',
      workloadKind: 'design-artifact',
      model: 'map-managed',
      modelBaseUrl: 'https://map.example.test/api/runtime/llm/v1',
      modelProtocol: 'openai',
      modelApiKey: 'model-secret',
      clientRequestId,
      workspaceTransfer: {
        schemaVersion: 'map-design-workspace-v1',
        inputPackageUrl: 'https://map.example.test/api/runtime/input',
        resultCommitUrl: 'https://map.example.test/api/runtime/result',
        transferToken: 'transfer-secret',
        inputSha256: 'a'.repeat(64),
        baseRevision: 'revision-concurrent',
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

    const firstPromise = request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, body);
    await capabilityReached;
    const visibleReservation = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions?clientRequestId=${clientRequestId}`,
      longToken,
    );
    expect(visibleReservation.status).toBe(200);
    expect(visibleReservation.body.items).toHaveLength(1);
    expect(visibleReservation.body.items[0]).toMatchObject({
      clientRequestId,
      status: 'creating',
    });

    const secondPromise = request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, body);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.idempotentReplay).toBe(true);
    expect(second.body.item.status).toBe('creating');
    expect(first.body.item.id).toBe(second.body.item.id);
    expect(capabilityCalls).toBe(1);
    expect(createCalls).toBe(0);
    const earlyMessage = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions/${first.body.item.id}/messages`, longToken, { content: 'must not run yet', clientMessageId: 'too-early' });
    expect(earlyMessage.status).toBe(409);
    expect(earlyMessage.body.error.code).toBe('session_creating');
    releaseCapabilities();
    await waitForSession(projectId, longToken, first.body.item.id, 'running');
    expect(createCalls).toBe(1);
  });

  it('retains an accepted failure and replays it without allocating another runtime', async () => {
    let capabilityCalls = 0;
    const workspaceRuntime = {
      async capability() {
        capabilityCalls += 1;
        return { available: false, resourcePolicyEnforcedPerSession: false, reason: 'runtime unavailable' };
      },
      has() {
        return false;
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime });
    const { projectId, longToken } = authorizeSharedServiceProject();
    const clientRequestId = 'request-capability-failure-001';
    const body = {
      runtime: 'open-design',
      workloadKind: 'design-artifact',
      model: 'map-managed',
      modelBaseUrl: 'https://map.example.test/api/runtime/llm/v1',
      modelProtocol: 'openai',
      modelApiKey: 'model-secret',
      clientRequestId,
      workspaceTransfer: {
        schemaVersion: 'map-design-workspace-v1',
        inputPackageUrl: 'https://map.example.test/api/runtime/input',
        resultCommitUrl: 'https://map.example.test/api/runtime/result',
        transferToken: 'transfer-secret',
        inputSha256: 'a'.repeat(64),
        baseRevision: 'revision-capability-failure',
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

    const first = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, body);
    expect(first.status).toBe(202);
    await waitForSession(projectId, longToken, first.body.item.id, 'failed');
    const found = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions?clientRequestId=${clientRequestId}`,
      longToken,
    );
    expect(found.status).toBe(200);
    expect(found.body.items).toHaveLength(1);
    expect(found.body.items[0]).toMatchObject({ status: 'failed', creationFailure: { code: 'resource_policy_not_enforced' } });

    const retry = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, body);
    expect(retry.status).toBe(409);
    expect(retry.body.item.id).toBe(first.body.item.id);
    expect(capabilityCalls).toBe(1);
    await flushAllJsonStateStores();
    const diskState = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    diskState.load();
    expect(diskState.listAgentSessionReservations().find((item) => item.id === first.body.item.id)?.item)
      .toMatchObject({ status: 'failed', creationFailure: { code: 'resource_policy_not_enforced' } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    stateService = diskState;
    vi.resetModules();
    const { createRemoteHostsRouter: createFreshRouter } = await import('../../src/routes/remote-hosts.js');
    const restartedApp = express();
    restartedApp.use(express.json());
    restartedApp.use('/api', createFreshRouter({ stateService, agentWorkspaceSessionRuntime: workspaceRuntime }));
    await new Promise<void>((resolve) => { server = restartedApp.listen(0, '127.0.0.1', resolve); });
    const recovered = await request(server, 'GET', `/api/projects/${projectId}/agent-sessions?clientRequestId=${clientRequestId}`, longToken);
    expect(recovered.body.items).toHaveLength(1);
    expect(recovered.body.items[0]).toMatchObject({ id: first.body.item.id, status: 'failed', creationFailure: { code: 'resource_policy_not_enforced' } });
    const replayAfterRestart = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, body);
    expect(replayAfterRestart.status).toBe(409);
    expect(replayAfterRestart.body.recovered).toBe(true);
    expect(capabilityCalls).toBe(1);
  });

  it('flushes the durable reservation before capability or runtime creation starts', async () => {
    let capabilityCalls = 0;
    let createCalls = 0;
    const workspaceRuntime = {
      async capability() {
        capabilityCalls += 1;
        return { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
      },
      async create(sessionId: string) {
        createCalls += 1;
        return { containerName: `workspace-${sessionId}` };
      },
      has() {
        return false;
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime });
    const { projectId, longToken } = authorizeSharedServiceProject();
    const flushGate = deferred<void>();
    const originalFlush = stateService.flush.bind(stateService);
    const flushSpy = vi.spyOn(stateService, 'flush').mockImplementationOnce(() => flushGate.promise);

    const createPromise = request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      openDesignSessionBody('request-flush-barrier-001'),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(capabilityCalls).toBe(0);
    expect(createCalls).toBe(0);

    let replaySettled = false;
    const replayPromise = request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, openDesignSessionBody('request-flush-barrier-001'));
    void replayPromise.then(() => { replaySettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replaySettled).toBe(false);
    flushGate.resolve();
    flushSpy.mockImplementation(originalFlush);
    const created = await createPromise;
    expect(created.status).toBe(202);
    const replay = await replayPromise;
    expect(replay.status).toBe(202);
    expect(replay.body.item.id).toBe(created.body.item.id);
    await waitForSession(projectId, longToken, created.body.item.id, 'running');
    expect(capabilityCalls).toBe(1);
    expect(createCalls).toBe(1);
  });

  it('does not probe capability or create a runtime when reservation flush fails', async () => {
    let capabilityCalls = 0;
    let createCalls = 0;
    const workspaceRuntime = {
      async capability() {
        capabilityCalls += 1;
        return { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
      },
      async create() {
        createCalls += 1;
        return { containerName: 'must-not-exist' };
      },
      has() {
        return false;
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime });
    const { projectId, longToken } = authorizeSharedServiceProject();
    vi.spyOn(stateService, 'flush').mockRejectedValueOnce(new Error('durable store unavailable'));

    const failed = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions`,
      longToken,
      openDesignSessionBody('request-flush-failure-001'),
    );
    expect(failed.status).toBe(503);
    expect(failed.body.error).toMatchObject({
      code: 'agent_session_reservation_persist_failed',
      retryable: true,
    });
    expect(capabilityCalls).toBe(0);
    expect(createCalls).toBe(0);
  });

  it('rejects OpenDesign without a stable request identity before reserving or probing', async () => {
    const capability = vi.fn();
    const create = vi.fn();
    await startServer({ agentWorkspaceSessionRuntime: { capability, create } as unknown as AgentWorkspaceSessionRuntime });
    const { projectId, longToken } = authorizeSharedServiceProject();
    const { clientRequestId: _unused, ...body } = openDesignSessionBody('identity-to-remove');
    const rejected = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, body);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('agent_session_client_request_id_required');
    expect(capability).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(stateService.listAgentSessionReservations()).toHaveLength(0);
  });

  it.each(['ready', 'failed', 'stopped'])('does not expose ready or dispatch before final durability (%s)', async (outcome) => {
    const failFlush = outcome === 'failed';
    const enteredFlush = deferred<void>();
    const releaseFlush = deferred<void>();
    let executeCalls = 0;
    let stopCalls = 0;
    let allocated = false;
    const workspaceRuntime = {
      async capability() {
        return { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
      },
      async create(sessionId: string) {
        allocated = true;
        return { containerName: `workspace-${sessionId}` };
      },
      async execute() {
        executeCalls++;
        return { artifactRef: 'test-artifact', resultSha256: 'test-hash', files: [] };
      },
      async stop() { stopCalls++; allocated = false; },
      has() { return allocated; },
    } as unknown as AgentWorkspaceSessionRuntime;
    await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime });
    const { projectId, longToken } = authorizeSharedServiceProject();
    await new Promise((resolve) => setImmediate(resolve));
    const originalFlush = stateService.flush.bind(stateService);
    let flushCalls = 0;
    vi.spyOn(stateService, 'flush').mockImplementation(async () => {
      if (++flushCalls === 2) {
        enteredFlush.resolve();
        await releaseFlush.promise;
        if (failFlush) throw new Error('final durable flush failed');
      }
      await originalFlush();
    });
    const body = openDesignSessionBody(`durability-window-${outcome}`);
    const basePath = `/api/projects/${projectId}/agent-sessions`;
    const accepted = await request(server, 'POST', basePath, longToken, body);
    const sessionId = accepted.body.item.id;
    const message = { content: 'must wait for durability', clientMessageId: 'durable-message' };
    let stopping: ReturnType<typeof request> | undefined;
    try {
      await enteredFlush.promise;
      const detail = await request(server, 'GET', `${basePath}/${sessionId}`, longToken);
      const list = await request(server, 'GET', `${basePath}?clientRequestId=${body.clientRequestId}`, longToken);
      const replay = await request(server, 'POST', basePath, longToken, body);
      const rejected = await request(server, 'POST', `${basePath}/${sessionId}/messages`, longToken, message);
      expect(detail.body.item.status).toBe('creating');
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ id: sessionId, status: 'creating' });
      expect(replay.status).toBe(202);
      expect(replay.body.item).toMatchObject({ id: sessionId, status: 'creating' });
      expect(rejected.status).toBe(409);
      expect(rejected.body.error.code).toBe('session_creating');
      expect(executeCalls).toBe(0);
      if (outcome === 'stopped') {
        stopping = request(server, 'POST', `${basePath}/${sessionId}/stop`, longToken, {});
        await waitForSession(projectId, longToken, sessionId, 'stopping');
      }
    } finally {
      releaseFlush.resolve();
    }
    if (stopping) await stopping;
    await waitForSession(projectId, longToken, sessionId, outcome === 'ready' ? 'running' : outcome);
    if (outcome !== 'ready') {
      const rejected = await request(server, 'POST', `${basePath}/${sessionId}/messages`, longToken, message);
      expect(rejected.status).toBe(409);
      expect(executeCalls).toBe(0);
      expect(stopCalls).toBeGreaterThanOrEqual(1);
      expect(allocated).toBe(false);
    } else {
      const sent = await request(server, 'POST', `${basePath}/${sessionId}/messages`, longToken, message);
      const replay = await request(server, 'POST', `${basePath}/${sessionId}/messages`, longToken, message);
      expect(sent.status).toBe(202);
      expect(sent.body.accepted).toBe(true);
      expect(replay.body.replayed).toBe(true);
      expect(executeCalls).toBe(1);
      expect(stopCalls).toBe(0);
    }
  });

  it('cleans a created runtime and replays a deterministic failure when final flush fails', async () => {
    let createCalls = 0;
    let stopCalls = 0;
    let runtimeAllocated = false;
    const workspaceRuntime = {
      async capability() {
        return { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
      },
      async create(sessionId: string) {
        createCalls += 1;
        runtimeAllocated = true;
        return { containerName: `workspace-${sessionId}` };
      },
      async stop() {
        stopCalls += 1;
        runtimeAllocated = false;
      },
      has() {
        return runtimeAllocated;
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime });
    const { projectId, longToken } = authorizeSharedServiceProject();
    await new Promise((resolve) => setImmediate(resolve));
    const originalFlush = stateService.flush.bind(stateService);
    let flushCalls = 0;
    vi.spyOn(stateService, 'flush').mockImplementation(async () => {
      flushCalls += 1;
      if (flushCalls === 2) throw new Error('final durable flush failed');
      await originalFlush();
    });
    const clientRequestId = 'request-final-flush-failure-001';
    const body = openDesignSessionBody(clientRequestId);

    // Treat the first response as lost: correctness is asserted through the idempotent replay.
    const accepted = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, body);
    expect(accepted.status).toBe(202);
    await waitForSession(projectId, longToken, accepted.body.item.id, 'failed');
    const replay = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, body);

    expect(replay.status).toBe(503);
    expect(replay.body).toMatchObject({
      idempotentReplay: true,
      item: {
        clientRequestId,
        status: 'failed',
        resourceCleanupPending: false,
      },
      error: {
        code: 'agent_session_final_persist_failed',
        retryable: true,
      },
    });
    expect(createCalls).toBe(1);
    expect(stopCalls).toBe(1);
    expect(runtimeAllocated).toBe(false);
  });

  it('keeps stop terminal when runtime creation returns after cancellation', async () => {
    let createCalls = 0;
    let stopCalls = 0;
    let reportCreateStarted!: () => void;
    let releaseCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      reportCreateStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const workspaceRuntime = {
      async capability() {
        return { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
      },
      async create(sessionId: string) {
        createCalls += 1;
        reportCreateStarted();
        await createGate;
        return { containerName: `workspace-${sessionId}` };
      },
      async stop() {
        stopCalls += 1;
      },
      has() {
        return false;
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    await startServer({ agentWorkspaceSessionRuntime: workspaceRuntime });
    const { projectId, longToken } = authorizeSharedServiceProject();
    const clientRequestId = 'request-stop-during-create-001';
    const body = {
      runtime: 'open-design',
      workloadKind: 'design-artifact',
      model: 'map-managed',
      modelBaseUrl: 'https://map.example.test/api/runtime/llm/v1',
      modelProtocol: 'openai',
      modelApiKey: 'model-secret',
      clientRequestId,
      workspaceTransfer: {
        schemaVersion: 'map-design-workspace-v1',
        inputPackageUrl: 'https://map.example.test/api/runtime/input',
        resultCommitUrl: 'https://map.example.test/api/runtime/result',
        transferToken: 'transfer-secret',
        inputSha256: 'a'.repeat(64),
        baseRevision: 'revision-stop-during-create',
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

    const createPromise = request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, body);
    await createStarted;
    const visible = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions?clientRequestId=${clientRequestId}`,
      longToken,
    );
    expect(visible.body.items).toHaveLength(1);
    expect(visible.body.items[0].status).toBe('creating');
    const sessionId = visible.body.items[0].id as string;

    const stopPromise = request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/stop`,
      longToken,
      {},
    );
    let stopSettled = false;
    void stopPromise.finally(() => { stopSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopSettled).toBe(false);
    releaseCreate();
    const [stopped, createResult] = await Promise.all([stopPromise, createPromise]);
    expect(stopped.status).toBe(200);
    expect(stopped.body.item.status).toBe('stopped');

    expect(createResult.status).toBe(202);
    expect(createResult.body.item.status).toBe('creating');
    expect(createCalls).toBe(1);
    expect(stopCalls).toBeGreaterThanOrEqual(2);

    const final = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions?clientRequestId=${clientRequestId}`,
      longToken,
    );
    expect(final.body.items).toHaveLength(1);
    expect(final.body.items[0].status).toBe('stopped');
  });

  it('recovers the stable session snapshot after a CDS route restart', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    const clientRequestId = 'request-restart-recovery-001';
    const first = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, {
      runtime: 'fake',
      clientRequestId,
      title: '重启恢复验证',
    });
    expect(first.status).toBe(201);
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    vi.resetModules();
    const { createRemoteHostsRouter: createFreshRemoteHostsRouter } = await import('../../src/routes/remote-hosts.js');
    const restartedApp = express();
    restartedApp.use(express.json());
    restartedApp.use('/api', createFreshRemoteHostsRouter({ stateService }));
    await new Promise<void>((resolve) => {
      server = restartedApp.listen(0, '127.0.0.1', () => resolve());
    });

    const recovered = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions?clientRequestId=${clientRequestId}`,
      longToken,
    );
    expect(recovered.status).toBe(200);
    expect(recovered.body.items).toHaveLength(1);
    expect(recovered.body.items[0]).toMatchObject({
      id: first.body.item.id,
      clientRequestId,
      status: 'failed',
      recoveryError: { code: 'agent_session_interrupted_by_cds_restart' },
    });

    const replay = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, {
      runtime: 'fake',
      clientRequestId,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.recovered).toBe(true);
    expect(replay.body.item.id).toBe(first.body.item.id);
  });

  it('returns 202 for persisted creating replay and retains a retryable cleanup ledger on stop failure', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    const clientRequestId = 'request-restart-pending-001';
    const first = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, {
      runtime: 'fake',
      clientRequestId,
    });
    expect(first.status).toBe(201);
    const reservation = stateService.listAgentSessionReservations()
      .find((candidate) => candidate.id === first.body.item.id)!;
    stateService.upsertAgentSessionReservation({
      ...reservation,
      item: {
        ...reservation.item,
        runtime: 'open-design',
        status: 'creating',
        resourceCleanupPending: true,
      },
      updatedAt: new Date().toISOString(),
    });
    await stateService.flush();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    vi.resetModules();
    const { createRemoteHostsRouter: createFreshRemoteHostsRouter } = await import('../../src/routes/remote-hosts.js');
    const recoveryGate = deferred<void>();
    const workspaceRuntime = {
      async bootstrapAndVerify() {
        await recoveryGate.promise;
      },
      async stop() {},
      has() {
        return false;
      },
    } as unknown as AgentWorkspaceSessionRuntime;
    const restartedApp = express();
    restartedApp.use(express.json());
    restartedApp.use('/api', createFreshRemoteHostsRouter({
      stateService,
      agentWorkspaceSessionRuntime: workspaceRuntime,
    }));
    await new Promise<void>((resolve) => {
      server = restartedApp.listen(0, '127.0.0.1', () => resolve());
    });

    const replay = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, {
      runtime: 'open-design',
      clientRequestId,
    });
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({
      pending: true,
      recovered: true,
      item: {
        id: first.body.item.id,
        clientRequestId,
        status: 'creating',
      },
    });

    const stopPromise = request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${first.body.item.id}/stop`,
      longToken,
      {},
    );
    let stopSettled = false;
    void stopPromise.finally(() => { stopSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopSettled).toBe(false);
    recoveryGate.reject(new Error('cleanup reaper unavailable'));
    const stopped = await stopPromise;
    expect(stopped.status).toBe(503);
    expect(stopped.body.error.retryable).toBe(true);
    expect(stopped.body.item).toMatchObject({
      id: first.body.item.id,
      status: 'failed',
      resourceCleanupPending: true,
    });
    const retained = stateService.listAgentSessionReservations()
      .find((candidate) => candidate.id === first.body.item.id);
    expect(retained?.item).toMatchObject({
      status: 'failed',
      resourceCleanupPending: true,
    });
  });

  it('waits the real runtime bootstrap reaper before stopping a persisted session with no handle', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    const clientRequestId = 'request-real-reaper-empty-handle-001';
    const first = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, {
      runtime: 'fake',
      clientRequestId,
    });
    const reservation = stateService.listAgentSessionReservations()
      .find((candidate) => candidate.id === first.body.item.id)!;
    stateService.upsertAgentSessionReservation({
      ...reservation,
      item: {
        ...reservation.item,
        runtime: 'open-design',
        status: 'creating',
        resourceCleanupPending: true,
      },
      updatedAt: new Date().toISOString(),
    });
    await stateService.flush();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();

    const recoveryStarted = deferred<void>();
    const releaseRecovery = deferred<void>();
    const runtimeShell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        if (command.startsWith('docker ps -aq')) {
          recoveryStarted.resolve();
          await releaseRecovery.promise;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('docker network ls -q') || command.startsWith('docker volume ls -q')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('docker version')) return { stdout: '27.0.0\n', stderr: '', exitCode: 0 };
        if (command.startsWith('docker image inspect')) return { stdout: 'sha256:image\n', stderr: '', exitCode: 0 };
        if (command.includes('--entrypoint /bin/sh') && !command.includes('/cds-storage-probe')) {
          return { stdout: '/usr/local/bin/opencode\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('docker volume create') && command.includes('storage-probe')) {
          return { stdout: 'probe-volume\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('docker run --rm') && command.includes('/cds-storage-probe')) {
          return { stdout: 'hard-limit-enforced\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('docker volume rm ') && command.includes('storage-probe')) {
          return { stdout: 'removed\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const realRuntime = new AgentWorkspaceSessionRuntime(runtimeShell, {
      rootDir: path.join(tmpDir, 'runtime'),
      instanceId: 'agent-request-real-reaper',
      autoPullImage: false,
      capabilityCacheMs: 0,
    });
    vi.resetModules();
    const { createRemoteHostsRouter: createFreshRemoteHostsRouter } = await import('../../src/routes/remote-hosts.js');
    const restartedApp = express();
    restartedApp.use(express.json());
    restartedApp.use('/api', createFreshRemoteHostsRouter({
      stateService,
      agentWorkspaceSessionRuntime: realRuntime,
    }));
    await new Promise<void>((resolve) => {
      server = restartedApp.listen(0, '127.0.0.1', () => resolve());
    });
    await recoveryStarted.promise;

    const stopPromise = request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${first.body.item.id}/stop`,
      longToken,
      {},
    );
    let stopSettled = false;
    void stopPromise.finally(() => { stopSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopSettled).toBe(false);
    expect(realRuntime.has(first.body.item.id)).toBe(false);

    releaseRecovery.resolve();
    const stopped = await stopPromise;
    expect(stopped.status).toBe(200);
    expect(stopped.body.item).toMatchObject({
      id: first.body.item.id,
      status: 'stopped',
      resourceCleanupPending: false,
    });
  });

  it('scopes every agent-session surface and observability preview to the owner principal', async () => {
    await startServer();
    const owner = authorizeSharedServiceProject({ partnerId: 'map-stop-owner' });
    const other = authorizeSharedServiceProject({ partnerId: 'map-stop-other' });
    const ownerCreated = await request(
      server,
      'POST',
      `/api/projects/${owner.projectId}/agent-sessions`,
      owner.longToken,
      { runtime: 'fake', clientRequestId: 'request-owner-surface-001', title: 'owner-visible' },
    );
    const otherCreated = await request(
      server,
      'POST',
      `/api/projects/${other.projectId}/agent-sessions`,
      other.longToken,
      { runtime: 'fake', clientRequestId: 'request-other-surface-001', title: 'other-secret' },
    );
    expect(ownerCreated.status).toBe(201);
    expect(otherCreated.status).toBe(201);

    const ownerList = await request(
      server,
      'GET',
      `/api/projects/${owner.projectId}/agent-sessions`,
      owner.longToken,
    );
    expect(ownerList.body.items.map((item: any) => item.id)).toContain(ownerCreated.body.item.id);
    expect(ownerList.body.items.map((item: any) => item.id)).not.toContain(otherCreated.body.item.id);

    const foreignId = otherCreated.body.item.id as string;
    const foreignSurfaces = await Promise.all([
      request(server, 'GET', `/api/projects/${owner.projectId}/agent-sessions/${foreignId}`, owner.longToken),
      request(server, 'POST', `/api/projects/${owner.projectId}/agent-sessions/${foreignId}/messages`, owner.longToken, { content: 'read secret' }),
      request(server, 'GET', `/api/projects/${owner.projectId}/agent-sessions/${foreignId}/stream`, owner.longToken),
      request(server, 'POST', `/api/projects/${owner.projectId}/agent-sessions/${foreignId}/tool-approvals/approval-1`, owner.longToken, { decision: 'allow' }),
      request(server, 'GET', `/api/projects/${owner.projectId}/agent-sessions/${foreignId}/logs`, owner.longToken),
      request(server, 'POST', `/api/projects/${owner.projectId}/agent-sessions/${foreignId}/stop`, owner.longToken, {}),
    ]);
    for (const denied of foreignSurfaces) {
      expect(denied.status).toBe(404);
      expect(denied.body.error.code).toBe('session_not_found');
    }

    await request(
      server,
      'POST',
      `/api/projects/${owner.projectId}/agent-sessions/${ownerCreated.body.item.id}/messages`,
      owner.longToken,
      { content: 'owner request preview' },
    );
    await request(
      server,
      'POST',
      `/api/projects/${other.projectId}/agent-sessions/${otherCreated.body.item.id}/messages`,
      other.longToken,
      { content: 'other private preview' },
    );
    const ownerObservability = await request(
      server,
      'GET',
      `/api/projects/${owner.projectId}/agent-requests`,
      owner.longToken,
    );
    expect(ownerObservability.body.items.some((item: any) => item.title === 'owner-visible')).toBe(true);
    expect(ownerObservability.body.items.some((item: any) => item.title === 'other-secret')).toBe(false);
    expect(JSON.stringify(ownerObservability.body)).not.toContain('other private preview');
  });

  it('scopes clientRequestId replay and lookup to the authenticated principal', async () => {
    await startServer();
    const firstPrincipal = authorizeSharedServiceProject({ partnerId: 'map-principal-a' });
    const secondPrincipal = authorizeSharedServiceProject({ partnerId: 'map-principal-b' });
    const clientRequestId = 'request-shared-key-001';
    const first = await request(
      server,
      'POST',
      `/api/projects/${firstPrincipal.projectId}/agent-sessions`,
      firstPrincipal.longToken,
      { runtime: 'fake', clientRequestId },
    );
    const second = await request(
      server,
      'POST',
      `/api/projects/${secondPrincipal.projectId}/agent-sessions`,
      secondPrincipal.longToken,
      { runtime: 'fake', clientRequestId },
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.item.id).not.toBe(first.body.item.id);

    const foundByFirst = await request(
      server,
      'GET',
      `/api/projects/${firstPrincipal.projectId}/agent-sessions?clientRequestId=${clientRequestId}`,
      firstPrincipal.longToken,
    );
    const foundBySecond = await request(
      server,
      'GET',
      `/api/projects/${secondPrincipal.projectId}/agent-sessions?clientRequestId=${clientRequestId}`,
      secondPrincipal.longToken,
    );
    expect(foundByFirst.body.items.map((item: any) => item.id)).toEqual([first.body.item.id]);
    expect(foundBySecond.body.items.map((item: any) => item.id)).toEqual([second.body.item.id]);
  });

  it('rejects malformed clientRequestId on create and exact lookup', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    for (const clientRequestId of ['', 'short', ' leading-space', 'contains/slash', 'a'.repeat(129), null, 42]) {
      const rejected = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, {
        runtime: 'fake',
        clientRequestId,
      });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.code).toBe('client_request_id_invalid');
    }

    const rejectedLookup = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions?clientRequestId=short`,
      longToken,
    );
    expect(rejectedLookup.status).toBe(400);
    expect(rejectedLookup.body.error.code).toBe('client_request_id_invalid');
  });

  it('agent-requests aggregates and filters by app/user/q', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    await createSession(projectId, longToken, { title: 'PPT 第1页', clientUser: 'u-a', clientApp: 'md-to-ppt' });
    await createSession(projectId, longToken, { title: '巡检仓库', clientUser: 'u-b', clientApp: 'infra-console' });

    // 注意：cdsAgentSessions 是模块级 Map，跨用例共享（与生产行为一致）——
    // 断言用包含性而非精确计数，筛选断言用本用例独有的 user 标签
    const all = await request(server, 'GET', `/api/projects/${projectId}/agent-requests`, longToken);
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(2);
    expect(all.body.apps).toContain('infra-console');
    expect(all.body.apps).toContain('md-to-ppt');
    expect(all.body.users).toContain('u-a');
    expect(all.body.users).toContain('u-b');

    const byUserA = await request(server, 'GET', `/api/projects/${projectId}/agent-requests?user=u-a`, longToken);
    expect(byUserA.body.items.length).toBe(1);
    expect(byUserA.body.items[0].title).toBe('PPT 第1页');

    const byUser = await request(server, 'GET', `/api/projects/${projectId}/agent-requests?user=u-b`, longToken);
    expect(byUser.body.items.length).toBe(1);
    expect(byUser.body.items[0].clientApp).toBe('infra-console');

    const byQ = await request(server, 'GET', `/api/projects/${projectId}/agent-requests?q=${encodeURIComponent('巡检')}`, longToken);
    expect(byQ.body.items.length).toBe(1);
    expect(byQ.body.items[0].title).toBe('巡检仓库');
  });

  it('stop persists summary into durable history', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    const sessionId = await createSession(projectId, longToken, {
      title: 'PPT 第2页',
      clientUser: 'u-history',
      clientApp: 'md-to-ppt',
    });
    const stop = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions/${sessionId}/stop`, longToken, {});
    expect(stop.status).toBe(200);

    const history = stateService.listAgentRequests();
    const record = history.find((r) => r.sessionId === sessionId);
    expect(record).toBeDefined();
    expect(record!.title).toBe('PPT 第2页');
    expect(record!.clientApp).toBe('md-to-ppt');
    expect(record!.status).toBe('stopped');
    expect(record!.eventCount).toBeGreaterThan(0);
  });

  it('completed agent message persists history before stop and stop updates the same record', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    const sessionId = await createSession(projectId, longToken, {
      title: 'PPT 第3页',
      clientUser: 'u-complete',
      clientApp: 'md-to-ppt',
    });

    const clientMessageId = 'map-message-causal-000000000001';
    const accepted = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: '生成第三页', clientMessageId },
    );
    expect(accepted.status).toBe(202);

    const replayed = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: '生成第三页', clientMessageId },
    );
    expect(replayed.status).toBe(202);
    expect(replayed.body.replayed).toBe(true);
    expect(replayed.body.item.eventCount).toBe(accepted.body.item.eventCount);

    const conflictingReplay = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: '不同任务', clientMessageId },
    );
    expect(conflictingReplay.status).toBe(409);
    expect(conflictingReplay.body.error.code).toBe('client_message_id_conflict');

    const stream = await request(
      server,
      'GET',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/stream`,
      longToken,
    );
    expect(stream.status).toBe(200);
    const correlatedEvents = String(stream.body)
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)))
      .filter((event) => event.payload?.clientMessageId === clientMessageId);
    expect(correlatedEvents.some((event) => event.type === 'status')).toBe(true);
    expect(correlatedEvents.some((event) => event.type === 'done')).toBe(true);

    const historyAfterDone = stateService.listAgentRequests().filter((r) => r.sessionId === sessionId);
    expect(historyAfterDone).toHaveLength(1);
    expect(historyAfterDone[0].status).toBe('idle');
    expect(historyAfterDone[0].requestPreview).toContain('生成第三页');
    expect(historyAfterDone[0].responsePreview).toContain('Fake runtime received');

    const stop = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions/${sessionId}/stop`, longToken, {});
    expect(stop.status).toBe(200);

    const replayAfterStop = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: '生成第三页', clientMessageId },
    );
    expect(replayAfterStop.status).toBe(202);
    expect(replayAfterStop.body.replayed).toBe(true);

    const historyAfterStop = stateService.listAgentRequests().filter((r) => r.sessionId === sessionId);
    expect(historyAfterStop).toHaveLength(1);
    expect(historyAfterStop[0].status).toBe('stopped');
  });

  it('structural events publish agent-session.activity on the global bus', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    const seen: Array<Record<string, unknown>> = [];
    const unsubscribe = cdsEventsBus.subscribe((envelope) => {
      if (envelope.type === 'agent-session.activity') seen.push(envelope.data as Record<string, unknown>);
    });
    try {
      await createSession(projectId, longToken, { title: '总线验证', clientApp: 'md-to-ppt' });
      expect(seen.length).toBeGreaterThan(0);
      const evt = seen[0];
      expect(evt.projectId).toBe(projectId);
      expect(evt.clientApp).toBe('md-to-ppt');
      expect(evt.eventType).toBe('status');
    } finally {
      unsubscribe();
    }
  });

  it('rejects unauthenticated agent-requests access', async () => {
    await startServer();
    const { projectId } = authorizeSharedServiceProject();
    const res = await request(server, 'GET', `/api/projects/${projectId}/agent-requests`);
    expect([401, 403]).toContain(res.status);
  });
});
