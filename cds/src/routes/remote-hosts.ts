/**
 * 远程主机管理路由（系统级，2026-05-06）
 *
 * shared 基础设施服务（如 claude-sdk sidecar）部署到的目标 SSH 主机。
 * SSH 凭据通过 sealToken 加密存储，明文不出库。
 *
 * 端点：
 *   GET    /api/cds-system/remote-hosts                           列表（不含密文）
 *   GET    /api/cds-system/remote-hosts/:id                       详情（不含密文）
 *   POST   /api/cds-system/remote-hosts                           创建
 *   PATCH  /api/cds-system/remote-hosts/:id                       更新（含可选重置私钥）
 *   DELETE /api/cds-system/remote-hosts/:id                       删除
 *   POST   /api/cds-system/remote-hosts/:id/test                  连接测试（真实 SSH echo）
 *   POST   /api/cds-system/remote-hosts/:id/deploy-sidecar        部署 sidecar，返回 deployment id
 *   GET    /api/cds-system/remote-hosts/:id/instance              当前实例（最新成功部署，主系统消费）
 *   GET    /api/cds-system/remote-hosts/:id/deployments           历史部署
 *   GET    /api/service-deployments/:id                           详情（含完整 logs）
 *   GET    /api/service-deployments/:id/stream                    SSE 流式日志（断线续传 afterSeq）
 *
 * 详见 doc/plan.cds-shared-service-extension.md。
 *
 * 命名规范：路径走 `/api/cds-system/*` 前缀（系统级），符合
 * .claude/rules/scope-naming.md §3。
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { StateService } from '../services/state.js';
import type { ServiceDeployment } from '../types.js';
import {
  RemoteHostService,
  type RemoteHostInput,
} from '../services/sidecar/remote-host-service.js';
import {
  SidecarDeployer,
  isSafeDockerImage,
  isSafeEnvKey,
  type SidecarSpec,
} from '../services/sidecar/sidecar-deployer.js';
import { CdsPairingService } from '../services/connection/pairing-service.js';

export interface RemoteHostsRouterDeps {
  stateService: StateService;
}

export function createRemoteHostsRouter(deps: RemoteHostsRouterDeps): Router {
  const service = new RemoteHostService(deps.stateService);
  const deployer = new SidecarDeployer(deps.stateService);
  const pairing = new CdsPairingService(
    deps.stateService,
    () => '',
    () => '',
    () => '',
  );
  const router = Router();

  router.get('/cds-system/remote-hosts', (_req, res) => {
    res.json({ hosts: service.list() });
  });

  router.get('/cds-system/remote-hosts/:id', (req, res) => {
    const host = service.get(req.params.id);
    if (!host) {
      res.status(404).json({ error: 'remote host not found' });
      return;
    }
    res.json({ host });
  });

  router.post('/cds-system/remote-hosts', (req, res) => {
    const body = req.body as Partial<RemoteHostInput>;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'body must be an object' });
      return;
    }
    const required = ['name', 'host', 'sshUser', 'sshPrivateKey'] as const;
    for (const key of required) {
      const v = body[key];
      if (typeof v !== 'string' || !v.trim()) {
        res.status(400).json({ error: `${key} is required` });
        return;
      }
    }
    if (body.sshPort !== undefined) {
      const port = Number(body.sshPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        res.status(400).json({ error: 'sshPort must be an integer in [1, 65535]' });
        return;
      }
      body.sshPort = port;
    }
    if (body.tags !== undefined && !Array.isArray(body.tags)) {
      res.status(400).json({ error: 'tags must be an array of strings' });
      return;
    }
    try {
      const created = service.create(body as RemoteHostInput);
      res.status(201).json({ host: created });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.patch('/cds-system/remote-hosts/:id', (req, res) => {
    const id = req.params.id;
    const existing = service.getRaw(id);
    if (!existing) {
      res.status(404).json({ error: 'remote host not found' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const patch: Parameters<RemoteHostService['update']>[1] = {};
    if (typeof body.name === 'string') patch.name = body.name;
    if (typeof body.host === 'string') patch.host = body.host;
    if (typeof body.sshUser === 'string') patch.sshUser = body.sshUser;
    if (body.sshPort !== undefined) {
      const port = Number(body.sshPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        res.status(400).json({ error: 'sshPort must be an integer in [1, 65535]' });
        return;
      }
      patch.sshPort = port;
    }
    if (Array.isArray(body.tags)) {
      patch.tags = (body.tags as unknown[]).map(String);
    }
    if (typeof body.isEnabled === 'boolean') patch.isEnabled = body.isEnabled;
    if (typeof body.sshPrivateKey === 'string' && body.sshPrivateKey.trim()) {
      patch.sshPrivateKey = body.sshPrivateKey;
    }
    if (body.sshPassphrase !== undefined) {
      if (body.sshPassphrase === '' || body.sshPassphrase === null) {
        patch.clearPassphrase = true;
      } else if (typeof body.sshPassphrase === 'string') {
        patch.sshPassphrase = body.sshPassphrase;
      }
    }
    try {
      const updated = service.update(id, patch);
      res.json({ host: updated });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete('/cds-system/remote-hosts/:id', (req, res) => {
    // 拒绝删除仍被 shared-service 项目引用的主机（保护性检查）。
    const projects = deps.stateService.getProjects().filter(p => p.kind === 'shared-service');
    const inUse = projects.find(p => (p.targetHostIds || []).includes(req.params.id));
    if (inUse) {
      res.status(409).json({
        error: `host is still referenced by shared-service project '${inUse.name}'`,
        projectId: inUse.id,
      });
      return;
    }
    const ok = service.remove(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'remote host not found' });
      return;
    }
    res.status(204).end();
  });

  /**
   * 真实 SSH 连接测试 —— `ssh ... echo cds-connect-ok`。
   * 不影响任何容器；用于在录入 / 修改主机后立即验证凭据。
   * 结果同时写到 host.lastTestedAt / lastTestOk / lastTestError 供 UI 展示。
   */
  router.post('/cds-system/remote-hosts/:id/test', async (req, res) => {
    const host = service.getRaw(req.params.id);
    if (!host) {
      res.status(404).json({ error: 'remote host not found' });
      return;
    }
    const result = await deployer.testConnection(host);
    const updated = service.recordTestResult(req.params.id, result.ok, result.message);
    res.json({ ok: result.ok, message: result.message, host: updated });
  });

  /**
   * 部署 sidecar 到该主机。立即返回 deployment id；前端通过 SSE
   * `/api/service-deployments/:id/stream` 拉流式日志。
   *
   * 每个 host 同时只允许一个 active deployment（pending/connecting/installing/
   * verifying/registering），防止并发 docker run 撞名。
   */
  router.post('/cds-system/remote-hosts/:id/deploy-sidecar', (req, res) => {
    const host = service.getRaw(req.params.id);
    if (!host) {
      res.status(404).json({ error: 'remote host not found' });
      return;
    }
    if (!host.isEnabled) {
      res.status(409).json({ error: `host '${host.name}' is disabled` });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    if (typeof body.image !== 'string' || !body.image.trim()) {
      res.status(400).json({ error: 'image is required (e.g. "prdagent/claude-sidecar:v0.2")' });
      return;
    }
    // 拒绝含 shell 元字符的 image —— 防止 SSH 命令注入（PR #529 Bugbot HIGH）
    const trimmedImage = body.image.trim();
    if (!isSafeDockerImage(trimmedImage)) {
      res.status(400).json({
        error: 'invalid image reference: only [a-zA-Z0-9._-/:@] characters allowed',
      });
      return;
    }
    const port = body.port === undefined ? 7400 : Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'port must be an integer in [1, 65535]' });
      return;
    }
    if (body.env !== undefined && (typeof body.env !== 'object' || body.env === null || Array.isArray(body.env))) {
      res.status(400).json({ error: 'env must be a plain object of string→string' });
      return;
    }
    // 逐键校验 env：value 必须是字符串、key 必须符合 POSIX env name 规范
    // [A-Za-z_][A-Za-z0-9_]*。否则下游 shellQuote 调 v.replace 会 TypeError，
    // 或者 docker 拿到 `-e 'KEY WITH SPACE'='val'` 这种非法语法（PR #529 Bugbot
    // MEDIUM 两连）。HTTP 202 已发后再爆只能落 SSE 日志，体验差，路由层卡掉。
    if (body.env) {
      for (const [k, v] of Object.entries(body.env as Record<string, unknown>)) {
        if (!isSafeEnvKey(k)) {
          res.status(400).json({
            error: `env key '${k.slice(0, 32)}' invalid: must match [A-Za-z_][A-Za-z0-9_]* (1-128 chars)`,
          });
          return;
        }
        if (typeof v !== 'string') {
          res.status(400).json({
            error: `env.${k} must be a string (got ${v === null ? 'null' : typeof v})`,
          });
          return;
        }
      }
    }

    const active = deps.stateService.getServiceDeployments().find(
      d => d.hostId === host.id && isActiveStatus(d.status),
    );
    if (active) {
      res.status(409).json({
        error: 'host already has an active deployment',
        deploymentId: active.id,
        status: active.status,
      });
      return;
    }

    const spec: SidecarSpec = {
      image: trimmedImage,
      port,
      slug: deriveContainerSlug(host.name, host.id),
      env: (body.env as Record<string, string>) || {},
      releaseTag: typeof body.releaseTag === 'string' ? body.releaseTag : undefined,
    };

    const deployment = deployer.beginDeployment(host, spec);

    // 异步执行；不阻塞 HTTP 响应。失败已被 runDeployment 内部 try/catch 兜住。
    void deployer.runDeployment(host, spec, deployment.id);

    res.status(202).json({
      deploymentId: deployment.id,
      status: deployment.status,
      streamUrl: `/api/service-deployments/${deployment.id}/stream`,
    });
  });

  /**
   * 当前实例 —— 主系统消费的核心 API。返回该 host 上"最新成功"的 sidecar
   * 部署，包含 host:port 信息供 ClaudeSidecarRouter 路由。
   *
   * 没有任何 running deployment → 返回 { instance: null, lastFailed?: ... }。
   */
  router.get('/cds-system/remote-hosts/:id/instance', (req, res) => {
    const host = service.getRaw(req.params.id);
    if (!host) {
      res.status(404).json({ error: 'remote host not found' });
      return;
    }
    const all = deps.stateService
      .getServiceDeployments()
      .filter(d => d.hostId === host.id)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const running = all.find(d => d.status === 'running');

    if (!running) {
      const lastFailed = all.find(d => d.status === 'failed');
      res.json({ instance: null, lastFailed: lastFailed?.id });
      return;
    }

    res.json({
      instance: {
        deploymentId: running.id,
        host: host.host,
        port: extractPortFromLogs(running) ?? 7400,
        healthy: running.containerHealthOk !== false,
        version: running.releaseTag,
        deployedAt: running.startedAt,
        tags: host.tags,
        hostName: host.name,
      },
    });
  });

  router.get('/cds-system/remote-hosts/:id/deployments', (req, res) => {
    const host = service.getRaw(req.params.id);
    if (!host) {
      res.status(404).json({ error: 'remote host not found' });
      return;
    }
    const items = deps.stateService
      .getServiceDeployments()
      .filter(d => d.hostId === host.id)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      .map(stripLogs);
    res.json({ deployments: items });
  });

  // ── ServiceDeployment 详情 + SSE 流式 ──────────────────────────

  router.get('/service-deployments/:id', (req, res) => {
    const dep = deps.stateService.getServiceDeployment(req.params.id);
    if (!dep) {
      res.status(404).json({ error: 'deployment not found' });
      return;
    }
    res.json({ deployment: dep });
  });

  router.get('/service-deployments/:id/stream', async (req, res) => {
    const id = req.params.id;
    const initial = deps.stateService.getServiceDeployment(id);
    if (!initial) {
      res.status(404).json({ error: 'deployment not found' });
      return;
    }
    const afterSeq = Math.max(0, Number(req.query.afterSeq || 0));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let lastEmittedLogIdx = afterSeq;
    let lastEmittedStatusKey: string | null = null;
    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    // 初始快照（如果 afterSeq 之后已有日志，直接补齐）
    flush(initial);
    if (isTerminal(initial.status)) {
      send('done', { status: initial.status, finishedAt: initial.finishedAt });
      res.end();
      return;
    }

    // 轮询 + 心跳：每 500ms 拉一次 deployment 看 seq；每 15s 发心跳防 idle 超时。
    let lastHeartbeat = Date.now();
    while (!closed) {
      await delay(500);
      if (closed) break;
      const dep = deps.stateService.getServiceDeployment(id);
      if (!dep) {
        send('error', { message: 'deployment vanished' });
        break;
      }
      flush(dep);
      if (isTerminal(dep.status)) {
        send('done', { status: dep.status, finishedAt: dep.finishedAt });
        break;
      }
      if (Date.now() - lastHeartbeat > 15_000) {
        res.write(': keepalive\n\n');
        lastHeartbeat = Date.now();
      }
    }
    res.end();

    function flush(dep: ServiceDeployment) {
      // 仅在 status 实际变化时才发 snapshot —— 否则 500ms 一次轮询会反复
      // 推同样的 status 事件，几分钟的部署积下几百条噪音（PR #529 Bugbot LOW）。
      // 用 status/phase/message/seq 4 字段拼 key 做幂等判断。
      const statusKey = `${dep.status}|${dep.phase ?? ''}|${dep.message ?? ''}|${dep.seq ?? 0}`;
      if (statusKey !== lastEmittedStatusKey) {
        send('status', {
          status: dep.status,
          phase: dep.phase,
          message: dep.message,
          seq: dep.seq,
        });
        lastEmittedStatusKey = statusKey;
      }
      // 发增量 logs
      while (lastEmittedLogIdx < dep.logs.length) {
        const entry = dep.logs[lastEmittedLogIdx];
        lastEmittedLogIdx += 1;
        send('log', { seq: lastEmittedLogIdx, ...entry });
      }
    }
  });

  /**
   * Project 级实例发现（spec.cds-map-pairing-protocol.md §3.2 instanceDiscoveryUrl）。
   *
   * 主系统消费这个端点拿到一个 project（绑 partner 的 shared-service Project）下
   * 所有 host 上跑的 sidecar 实例。聚合 ServiceDeployment.status='running'，按
   * (hostId, latest startedAt) 去重，每个 host 只保留最新一条。
   *
   * 路径放在 cds-system-connections.ts 也合理，但部署逻辑都在 remote-hosts 这里，
   * 实例发现逻辑本质是"按 projectId 聚合 host 实例"，归在本文件更内聚。
   */
  router.get('/projects/:id/instances', (req, res) => {
    const projectId = req.params.id;
    const token = extractBearerToken(req.headers.authorization);
    const connection = pairing.authenticateLongToken(token);
    if (!connection) {
      res.status(401).json({ error: { code: 'invalid_long_token', message: 'invalid or expired connection token' } });
      return;
    }
    if (connection.projectId !== projectId) {
      res.status(403).json({ error: { code: 'project_mismatch', message: 'connection token cannot access this project' } });
      return;
    }
    if (!connection.scopes.includes('instance:read')) {
      res.status(403).json({ error: { code: 'scope_denied', message: 'connection token lacks instance:read' } });
      return;
    }

    const project = deps.stateService.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: { code: 'project_not_found', message: 'project not found' } });
      return;
    }

    // (hostId, 最新 startedAt) 去重 —— 复用 stateService 里的 SSOT 实现，
    // 避免路由内联同一段聚合逻辑后两边走偏（PR #529 Bugbot LOW）。
    const latest = deps.stateService.getLatestDeploymentsByProject(projectId);

    const instances: Array<Record<string, unknown>> = [];
    for (const dep of latest) {
      if (dep.status !== 'running') continue;
      const host = service.getRaw(dep.hostId);
      if (!host || !host.isEnabled) continue;
      instances.push({
        deploymentId: dep.id,
        host: host.host,
        port: extractPortFromLogs(dep) ?? 7400,
        healthy: dep.containerHealthOk !== false,
        version: dep.releaseTag,
        deployedAt: dep.startedAt,
        tags: host.tags,
        hostName: host.name,
        hostId: host.id,
      });
    }

    res.json({ projectId, instances });
  });

  router.post('/projects/:id/agent-sessions', async (req, res) => {
    const auth = authenticateProjectRequest(req.headers.authorization, req.params.id, pairing, ['shared-service:deploy']);
    if (!auth.ok) {
      res.status(auth.status).json({ error: { code: auth.code, message: auth.message } });
      return;
    }

    const project = deps.stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: { code: 'project_not_found', message: 'project not found' } });
      return;
    }

    const now = new Date().toISOString();
    const runtime = normalizeRuntime(req.body?.runtime);
    const session: CdsAgentSession = {
      id: `cds-agent-${crypto.randomUUID().replace(/-/g, '')}`,
      projectId: req.params.id,
      runtime,
      model: typeof req.body?.model === 'string' ? req.body.model : null,
      status: 'running',
      workerId: `fake-worker-${req.params.id}`,
      containerName: `cds-agent-fake-${req.params.id}`,
      toolPolicy: typeof req.body?.toolPolicy === 'string' ? req.body.toolPolicy : 'confirm-dangerous',
      createdAt: now,
      updatedAt: now,
      events: [],
      messages: [],
      logs: [],
    };
    pushCdsAgentEvent(session, 'status', { status: 'running', reason: 'session_created', runtime });
    pushCdsAgentEvent(session, 'log', {
      level: 'info',
      message: `session created runtime=${runtime}`,
      source: 'fake-runtime',
    });
    session.logs.push(`[${now}] session created runtime=${runtime}`);
    cdsAgentSessions.set(session.id, session);
    res.status(201).json({ item: toCdsAgentSessionView(session) });
  });

  router.get('/projects/:projectId/agent-sessions/:sessionId', (req, res) => {
    const auth = authenticateProjectRequest(req.headers.authorization, req.params.projectId, pairing, ['instance:read']);
    if (!auth.ok) {
      res.status(auth.status).json({ error: { code: auth.code, message: auth.message } });
      return;
    }
    const session = getCdsAgentSession(req.params.projectId, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: { code: 'session_not_found', message: 'agent session not found' } });
      return;
    }
    res.json({ item: toCdsAgentSessionView(session) });
  });

  router.post('/projects/:projectId/agent-sessions/:sessionId/messages', async (req, res) => {
    const auth = authenticateProjectRequest(req.headers.authorization, req.params.projectId, pairing, ['deployment:stream']);
    if (!auth.ok) {
      res.status(auth.status).json({ error: { code: auth.code, message: auth.message } });
      return;
    }
    const session = getCdsAgentSession(req.params.projectId, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: { code: 'session_not_found', message: 'agent session not found' } });
      return;
    }
    if (session.status === 'stopped') {
      res.status(409).json({ error: { code: 'session_stopped', message: 'agent session already stopped' } });
      return;
    }

    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) {
      res.status(400).json({ error: { code: 'content_required', message: 'message content is required' } });
      return;
    }

    const now = new Date().toISOString();
    session.messages.push({ role: 'user', content, createdAt: now });
    pushCdsAgentEvent(session, 'status', { status: 'running', reason: 'message_received' });
    pushCdsAgentEvent(session, 'log', {
      level: 'info',
      message: `message accepted chars=${content.length}`,
      source: 'fake-runtime',
    });
    pushCdsAgentEvent(session, 'tool_call', {
      approvalId: `approval-${session.events.length + 1}`,
      toolName: 'fake_runtime.inspect',
      status: 'auto_allowed',
      input: { promptLength: content.length },
    });
    pushCdsAgentEvent(session, 'tool_result', {
      toolName: 'fake_runtime.inspect',
      status: 'completed',
      content: 'fake runtime inspected the prompt',
    });

    const answer = `Fake runtime received: ${content}`;
    for (const part of splitText(answer)) {
      pushCdsAgentEvent(session, 'text_delta', { text: part });
    }
    pushCdsAgentEvent(session, 'done', { finalText: answer });
    session.messages.push({ role: 'assistant', content: answer, createdAt: new Date().toISOString() });
    session.logs.push(`[${new Date().toISOString()}] message processed chars=${content.length}`);
    session.updatedAt = new Date().toISOString();
    res.status(202).json({ item: toCdsAgentSessionView(session), accepted: true });
  });

  router.get('/projects/:projectId/agent-sessions/:sessionId/stream', async (req, res) => {
    const auth = authenticateProjectRequest(req.headers.authorization, req.params.projectId, pairing, ['deployment:stream']);
    if (!auth.ok) {
      res.status(auth.status).json({ error: { code: auth.code, message: auth.message } });
      return;
    }
    const session = getCdsAgentSession(req.params.projectId, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: { code: 'session_not_found', message: 'agent session not found' } });
      return;
    }
    const afterSeq = Number(req.query.afterSeq || 0);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    const events = session.events.filter((event) => event.seq > afterSeq);
    for (const event of events) {
      res.write(`id: ${event.seq}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      await delay(20);
    }
    res.write('event: keepalive\n');
    res.write(`data: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    res.end();
  });

  router.post('/projects/:projectId/agent-sessions/:sessionId/tool-approvals/:approvalId', (req, res) => {
    const auth = authenticateProjectRequest(req.headers.authorization, req.params.projectId, pairing, ['deployment:stream']);
    if (!auth.ok) {
      res.status(auth.status).json({ error: { code: auth.code, message: auth.message } });
      return;
    }
    const session = getCdsAgentSession(req.params.projectId, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: { code: 'session_not_found', message: 'agent session not found' } });
      return;
    }
    const decision = req.body?.decision === 'deny' ? 'denied' : 'allowed';
    pushCdsAgentEvent(session, 'tool_result', {
      approvalId: req.params.approvalId,
      status: decision,
    });
    res.json({ ok: true, decision });
  });

  router.post('/projects/:projectId/agent-sessions/:sessionId/stop', (req, res) => {
    const auth = authenticateProjectRequest(req.headers.authorization, req.params.projectId, pairing, ['shared-service:deploy']);
    if (!auth.ok) {
      res.status(auth.status).json({ error: { code: auth.code, message: auth.message } });
      return;
    }
    const session = getCdsAgentSession(req.params.projectId, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: { code: 'session_not_found', message: 'agent session not found' } });
      return;
    }
    session.status = 'stopped';
    session.updatedAt = new Date().toISOString();
    session.stoppedAt = session.updatedAt;
    pushCdsAgentEvent(session, 'status', { status: 'stopped', reason: 'session_stopped' });
    pushCdsAgentEvent(session, 'log', {
      level: 'info',
      message: 'session stopped',
      source: 'fake-runtime',
    });
    session.logs.push(`[${session.updatedAt}] session stopped`);
    res.json({ item: toCdsAgentSessionView(session) });
  });

  router.get('/projects/:projectId/agent-sessions/:sessionId/logs', (req, res) => {
    const auth = authenticateProjectRequest(req.headers.authorization, req.params.projectId, pairing, ['instance:read']);
    if (!auth.ok) {
      res.status(auth.status).json({ error: { code: auth.code, message: auth.message } });
      return;
    }
    const session = getCdsAgentSession(req.params.projectId, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: { code: 'session_not_found', message: 'agent session not found' } });
      return;
    }
    res.json({ logs: session.logs.join('\n'), item: toCdsAgentSessionView(session) });
  });

  return router;
}

// ── 工具 ──────────────────────────────────────────

type CdsAgentSessionStatus = 'running' | 'stopped' | 'failed';
type CdsAgentEventType = 'status' | 'text_delta' | 'tool_call' | 'tool_result' | 'log' | 'error' | 'done' | 'hook';

interface CdsAgentEvent {
  seq: number;
  type: CdsAgentEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface CdsAgentSession {
  id: string;
  projectId: string;
  runtime: string;
  model: string | null;
  status: CdsAgentSessionStatus;
  workerId: string;
  containerName: string;
  toolPolicy: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
  events: CdsAgentEvent[];
  messages: Array<{ role: string; content: string; createdAt: string }>;
  logs: string[];
}

const cdsAgentSessions = new Map<string, CdsAgentSession>();

function authenticateProjectRequest(
  authorization: string | string[] | undefined,
  projectId: string,
  pairing: CdsPairingService,
  requiredScopes: string[],
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const token = extractBearerToken(authorization);
  const connection = pairing.authenticateLongToken(token);
  if (!connection) {
    return { ok: false, status: 401, code: 'invalid_long_token', message: 'invalid or expired connection token' };
  }
  if (connection.projectId !== projectId) {
    return { ok: false, status: 403, code: 'project_mismatch', message: 'connection token cannot access this project' };
  }
  const missing = requiredScopes.find((scope) => !connection.scopes.includes(scope));
  if (missing) {
    return { ok: false, status: 403, code: 'scope_denied', message: `connection token lacks ${missing}` };
  }
  return { ok: true };
}

function getCdsAgentSession(projectId: string, sessionId: string): CdsAgentSession | undefined {
  const session = cdsAgentSessions.get(sessionId);
  if (!session || session.projectId !== projectId) return undefined;
  return session;
}

function pushCdsAgentEvent(
  session: CdsAgentSession,
  type: CdsAgentEventType,
  payload: Record<string, unknown>,
): CdsAgentEvent {
  const event = {
    seq: session.events.length + 1,
    type,
    payload,
    createdAt: new Date().toISOString(),
  };
  session.events.push(event);
  session.updatedAt = event.createdAt;
  return event;
}

function toCdsAgentSessionView(session: CdsAgentSession): Record<string, unknown> {
  return {
    id: session.id,
    projectId: session.projectId,
    runtime: session.runtime,
    model: session.model,
    status: session.status,
    workerId: session.workerId,
    containerName: session.containerName,
    toolPolicy: session.toolPolicy,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    stoppedAt: session.stoppedAt ?? null,
    eventCount: session.events.length,
  };
}

function normalizeRuntime(value: unknown): string {
  return value === 'claude-sdk' || value === 'codex' || value === 'custom' ? value : 'fake';
}

function splitText(value: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += 12) {
    parts.push(value.slice(i, i + 12));
  }
  return parts;
}

function extractBearerToken(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : undefined;
}

/**
 * 派生容器 slug。规则（PR #529 Bugbot MEDIUM 修复）：
 *
 *   1. 小写 + 非 [a-z0-9-] 替换成 `-`
 *   2. 折叠连续 `-` → 单个 `-`
 *   3. 去掉首尾 `-`
 *   4. 截到 22 字（留出空间给 host.id 后缀）
 *   5. **始终**追加 host.id 前 8 字 —— 这样两个名字只差一个被 strip 的字符
 *      （`test!` vs `test@`，都 sanitize 成 `test`）也不会撞同一个容器名，
 *      避免第二次 deploy 静默 `docker rm -f` 第一台 host 的容器
 *   6. 整体 sanitize 后空串 → 退化成 `host-{id前8}`
 *
 * 输出符合 `isSafeContainerSlug`（仅 [a-z0-9-]，不以 `-` 开头/结尾，无 `--`）。
 */
export function deriveContainerSlug(name: string, hostId: string): string {
  const idSuffix = hostId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8);
  // 注意 slice 必须在 trim 之后再做一次 trailing-`-` 清理 —— 否则像
  // `my-production-sandbox-server` 这种 28 字名字 slice(0, 22) 会卡在
  // `my-production-sandbox-` 留下尾部 `-`，与后面的 `-${idSuffix}` 拼成
  // `--`，被 isSafeContainerSlug reject 导致部署直接 throw。
  // （PR #529 Bugbot MEDIUM）
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 22)
    .replace(/-+$/g, '');
  if (!base) return idSuffix ? `host-${idSuffix}` : 'sidecar';
  return idSuffix ? `${base}-${idSuffix}` : base;
}

function isActiveStatus(status: ServiceDeployment['status']): boolean {
  return ['pending', 'connecting', 'installing', 'verifying', 'registering'].includes(status);
}

function isTerminal(status: ServiceDeployment['status']): boolean {
  return status === 'running' || status === 'failed';
}

function stripLogs(d: ServiceDeployment): Omit<ServiceDeployment, 'logs'> & { logCount: number } {
  const { logs, ...rest } = d;
  return { ...rest, logCount: logs.length };
}

/**
 * 从部署日志反推容器对外端口 —— v1 用日志里 docker run 的 -p X:X 串。
 * 后续可以把 port 直接写到 ServiceDeployment 字段，省掉这段反向解析。
 */
function extractPortFromLogs(d: ServiceDeployment): number | null {
  const re = /-p\s+(\d+):\d+/;
  for (let i = d.logs.length - 1; i >= 0; i--) {
    const match = d.logs[i].message.match(re);
    if (match) return Number(match[1]);
  }
  return null;
}
