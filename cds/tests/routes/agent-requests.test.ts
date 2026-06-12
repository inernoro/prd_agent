/*
 * Agent 请求观测台（2026-06-11）路由测试：
 * - 会话创建接受 title/clientUser/clientApp 标签并在视图中返回
 * - GET /projects/:id/agent-requests 聚合列表 + user/app/q 筛选
 * - 会话 stop 时摘要落持久层（重启后历史可查的根基）
 * - 结构性事件发布到全局总线（观测台实时行内更新）
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRemoteHostsRouter } from '../../src/routes/remote-hosts.js';
import { CdsPairingService } from '../../src/services/connection/pairing-service.js';
import { StateService } from '../../src/services/state.js';
import { cdsEventsBus } from '../../src/services/cds-events-bus.js';
import type { Project } from '../../src/types.js';

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
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startServer() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-requests-'));
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

  it('create accepts labels and view returns them', async () => {
    await startServer();
    const { projectId, longToken } = authorizeSharedServiceProject();
    const res = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions`, longToken, {
      runtime: 'fake',
      model: 'fake-model',
      title: 'PPT 第6页',
      clientUser: 'user-123',
      clientApp: 'md-to-ppt',
    });
    expect(res.status).toBe(201);
    expect(res.body.item.title).toBe('PPT 第6页');
    expect(res.body.item.clientUser).toBe('user-123');
    expect(res.body.item.clientApp).toBe('md-to-ppt');
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

    const accepted = await request(
      server,
      'POST',
      `/api/projects/${projectId}/agent-sessions/${sessionId}/messages`,
      longToken,
      { content: '生成第三页' },
    );
    expect(accepted.status).toBe(202);

    const historyAfterDone = stateService.listAgentRequests().filter((r) => r.sessionId === sessionId);
    expect(historyAfterDone).toHaveLength(1);
    expect(historyAfterDone[0].status).toBe('idle');
    expect(historyAfterDone[0].requestPreview).toContain('生成第三页');
    expect(historyAfterDone[0].responsePreview).toContain('Fake runtime received');

    const stop = await request(server, 'POST', `/api/projects/${projectId}/agent-sessions/${sessionId}/stop`, longToken, {});
    expect(stop.status).toBe(200);

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
