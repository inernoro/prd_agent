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
import { setTimeout as delay } from 'node:timers/promises';

import type { StateService } from '../services/state.js';
import type { ServiceDeployment } from '../types.js';
import {
  RemoteHostService,
  type RemoteHostInput,
} from '../services/sidecar/remote-host-service.js';
import {
  SidecarDeployer,
  type SidecarSpec,
} from '../services/sidecar/sidecar-deployer.js';

export interface RemoteHostsRouterDeps {
  stateService: StateService;
}

export function createRemoteHostsRouter(deps: RemoteHostsRouterDeps): Router {
  const service = new RemoteHostService(deps.stateService);
  const deployer = new SidecarDeployer(deps.stateService);
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
    const port = body.port === undefined ? 7400 : Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'port must be an integer in [1, 65535]' });
      return;
    }
    if (body.env !== undefined && (typeof body.env !== 'object' || body.env === null || Array.isArray(body.env))) {
      res.status(400).json({ error: 'env must be a plain object of string→string' });
      return;
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
      image: body.image.trim(),
      port,
      slug: host.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 32) || 'sidecar',
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
      // 发 status snapshot
      send('status', {
        status: dep.status,
        phase: dep.phase,
        message: dep.message,
        seq: dep.seq,
      });
      // 发增量 logs
      while (lastEmittedLogIdx < dep.logs.length) {
        const entry = dep.logs[lastEmittedLogIdx];
        lastEmittedLogIdx += 1;
        send('log', { seq: lastEmittedLogIdx, ...entry });
      }
    }
  });

  return router;
}

// ── 工具 ──────────────────────────────────────────

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
