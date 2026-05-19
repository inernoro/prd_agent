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
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { StateService } from '../services/state.js';
import type { ContainerService } from '../services/container.js';
import type { BranchEntry, BuildProfile, Project, ServiceDeployment, ServiceState } from '../types.js';
import type { CdsConfig } from '../types.js';
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
import { computePreviewSlug } from '../services/preview-slug.js';

export interface RemoteHostsRouterDeps {
  stateService: StateService;
  containerService?: Pick<ContainerService, 'runService' | 'waitForReadiness'>;
  config?: Pick<CdsConfig, 'portStart'>;
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
      res.status(401).json({ error: { code: 'invalid_long_token', message: 'invalid connection token' } });
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
    const discovery = {
      projectKind: project.kind || 'unknown',
      deploymentCount: latest.length,
      runningDeploymentCount: 0,
      disabledHostDeploymentCount: 0,
      branchCount: 0,
      runningBranchCount: 0,
      runningBranchServiceCount: 0,
      runtimeBranchServiceCount: 0,
      skippedBranchServiceCount: 0,
      previewRootConfigured: false,
    };
    for (const dep of latest) {
      if (dep.status !== 'running') continue;
      discovery.runningDeploymentCount += 1;
      const host = service.getRaw(dep.hostId);
      if (!host || !host.isEnabled) {
        discovery.disabledHostDeploymentCount += 1;
        continue;
      }
      instances.push({
        deploymentId: dep.id,
        serviceKind: 'operator-fallback-deployment',
        capacityRole: 'operator-fallback',
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

    if (shouldIncludeBranchServicesInInstanceDiscovery(project)) {
      const projectSlug = project.slug || project.id;
      const previewRoot = resolvePreviewRootDomain();
      discovery.previewRootConfigured = Boolean(previewRoot);
      const branches = deps.stateService.getBranchesForProject(projectId);
      discovery.branchCount = branches.length;
      for (const branch of branches) {
        if (branch.status !== 'running') continue;
        discovery.runningBranchCount += 1;
        for (const serviceState of Object.values(branch.services || {})) {
          if (serviceState.status !== 'running') continue;
          discovery.runningBranchServiceCount += 1;
          const profile = deps.stateService.getBuildProfile(serviceState.profileId);
          if (!isRuntimeBranchService(serviceState.profileId, profile?.name, serviceState.containerName)) {
            discovery.skippedBranchServiceCount += 1;
            continue;
          }
          discovery.runtimeBranchServiceCount += 1;
          const previewSlug = computePreviewSlug(branch.branch, projectSlug);
          const baseUrl = previewRoot ? `https://${previewSlug}.${previewRoot}` : undefined;
          const officialSdkRuntime = isOfficialSdkRuntimeService('claude-sdk', serviceState, profile);
          instances.push({
            deploymentId: `branch:${branch.id}:${serviceState.profileId}`,
            profileId: serviceState.profileId,
            branchId: branch.id,
            branch: branch.branch,
            serviceKind: 'branch-service',
            capacityRole: officialSdkRuntime ? 'product-runtime' : 'runtime-service',
            runtimeOwnedBy: 'cds-managed-runtime',
            runtimeAdapter: officialSdkRuntime ? 'claude-agent-sdk' : 'unknown',
            loopOwner: officialSdkRuntime ? 'claude-agent-sdk' : 'unknown',
            projectKind: project.kind,
            host: serviceState.containerName,
            port: serviceState.hostPort,
            baseUrl,
            healthy: true,
            version: branch.githubCommitSha,
            deployedAt: branch.lastDeployAt || branch.createdAt,
            tags: ['system', 'default', 'cds-sidecar', `profile:${serviceState.profileId}`, `branch:${branch.branch}`],
            hostName: profile?.name || serviceState.profileId,
            hostId: branch.id,
          });
        }
      }
    }

    const capacity = buildCdsManagedRuntimeCapacity(project, instances, discovery, service.list());
    res.json({ projectId, instances, discovery, capacity });
  });

  router.get('/projects/:id/runtime-capacity', (req, res) => {
    const projectId = req.params.id;
    const token = extractBearerToken(req.headers.authorization);
    const connection = pairing.authenticateLongToken(token);
    if (!connection) {
      res.status(401).json({ error: { code: 'invalid_long_token', message: 'invalid connection token' } });
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

    const instancesResponse = collectProjectRuntimeInstances(deps.stateService, service, project);
    res.json({ projectId, ...instancesResponse });
  });

  router.post('/projects/:id/runtime-capacity/reconcile', async (req, res) => {
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
    if (project.kind !== 'shared-service') {
      res.status(409).json({
        error: {
          code: 'runtime_capacity_requires_shared_service_project',
          message: 'CDS-managed official SDK runtime capacity must be reconciled inside a shared-service project, not an application project.',
        },
      });
      return;
    }

    const hostPort = parseOptionalHostPort(req.body?.hostPort);
    if (hostPort === null) {
      res.status(400).json({
        error: {
          code: 'invalid_host_port',
          message: 'hostPort must be an integer in [1, 65535] when provided',
        },
      });
      return;
    }

    try {
      const result = reconcileCdsManagedRuntimeCapacity(deps.stateService, service, project, {
        apply: req.body?.apply === true,
        liveApply: req.body?.liveApply === true,
        force: req.body?.force === true,
        hostPort,
        now: new Date().toISOString(),
        containerService: deps.containerService,
        portStart: deps.config?.portStart,
      });
      res.json({ projectId: project.id, ...(await result) });
    } catch (err) {
      res.status(409).json({
        error: {
          code: 'runtime_capacity_reconcile_failed',
          message: (err as Error).message,
        },
      });
    }
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
    const modelBaseUrl = typeof req.body?.modelBaseUrl === 'string' ? req.body.modelBaseUrl : null;
    const modelProtocol = typeof req.body?.modelProtocol === 'string' ? req.body.modelProtocol : null;
    const modelApiKey = typeof req.body?.modelApiKey === 'string' && req.body.modelApiKey.length > 0
      ? req.body.modelApiKey
      : null;
    const workspaceRoot = typeof req.body?.workspaceRoot === 'string' ? req.body.workspaceRoot : null;
    const gitRepository = typeof req.body?.gitRepository === 'string' ? req.body.gitRepository : null;
    const gitRef = typeof req.body?.gitRef === 'string' ? req.body.gitRef : null;
    const hasModelApiKey = Boolean(modelApiKey);
    const resourcePolicy = normalizeAgentResourcePolicy(req.body?.resourcePolicy);
    const runtimeSource = runtime === 'fake' ? 'fake-runtime' : `${runtime}-runtime`;
    const workerId = runtime === 'fake'
      ? `fake-worker-${req.params.id}`
      : `${runtime}-worker-${req.params.id}`;
    const containerName = runtime === 'fake'
      ? `cds-agent-fake-${req.params.id}`
      : (process.env.CDS_AGENT_CONTAINER_NAME
        || process.env.CLAUDE_SIDECAR_CONTAINER_NAME
        || `${runtime}-sidecar-${req.params.id}`);
    const session: CdsAgentSession = {
      id: `cds-agent-${crypto.randomUUID().replace(/-/g, '')}`,
      projectId: req.params.id,
      runtime,
      model: typeof req.body?.model === 'string' ? req.body.model : null,
      modelBaseUrl,
      modelProtocol,
      modelApiKey,
      workspaceRoot,
      gitRepository,
      gitRef,
      hasModelApiKey,
      runtimeProfileId: typeof req.body?.runtimeProfileId === 'string' ? req.body.runtimeProfileId : null,
      resourcePolicy,
      status: 'running',
      workerId,
      containerName,
      toolPolicy: typeof req.body?.toolPolicy === 'string' ? req.body.toolPolicy : 'confirm-dangerous',
      createdAt: now,
      updatedAt: now,
      events: [],
      messages: [],
      logs: [],
    };
    pushCdsAgentEvent(session, 'status', {
      status: 'running',
      reason: 'session_created',
      runtime,
      model: session.model,
      modelBaseUrl,
      modelProtocol,
      workspaceRoot,
      gitRepository,
      gitRef,
      runtimeProfileId: session.runtimeProfileId,
      modelCredential: hasModelApiKey ? 'configured' : 'missing',
      resourcePolicy,
    });
    pushCdsAgentEvent(session, 'log', {
      level: 'info',
      message: `session created runtime=${runtime} model=${session.model ?? 'unset'} baseUrl=${modelBaseUrl ?? 'unset'} credential=${hasModelApiKey ? 'configured' : 'missing'} cpu=${resourcePolicy.cpuCores} memory=${resourcePolicy.memoryMb}MB timeout=${resourcePolicy.timeoutSeconds}s network=${resourcePolicy.networkPolicy}`,
      source: runtimeSource,
    });
    session.logs.push(`[${now}] session created runtime=${runtime} worker=${workerId} container=${containerName} model=${session.model ?? 'unset'} baseUrl=${modelBaseUrl ?? 'unset'} credential=${hasModelApiKey ? 'configured' : 'missing'} cpu=${resourcePolicy.cpuCores} memory=${resourcePolicy.memoryMb}MB timeout=${resourcePolicy.timeoutSeconds}s network=${resourcePolicy.networkPolicy} cleanup=${resourcePolicy.autoCleanupMinutes}m`);
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
    const project = deps.stateService.getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: { code: 'project_not_found', message: 'project not found' } });
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
    const project = deps.stateService.getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: { code: 'project_not_found', message: 'project not found' } });
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
      source: session.runtime === 'fake' ? 'fake-runtime' : `${session.runtime}-runtime`,
    });

    if (session.runtime !== 'fake') {
      const transport = resolveCdsManagedRuntimeTransport(deps.stateService, project, session);
      if (transport) {
        startCdsManagedOfficialSdkTransport(session, content, transport);
        session.updatedAt = new Date().toISOString();
        res.status(202).json({
          item: toCdsAgentSessionView(session),
          accepted: true,
          runtimeOwnedBy: 'cds-managed-runtime',
          transport: toCdsManagedRuntimeTransportView(transport),
        });
        return;
      }

      const unavailable = buildCdsManagedRuntimeUnavailable(session);
      session.status = 'failed';
      session.updatedAt = new Date().toISOString();
      pushCdsAgentEvent(session, 'error', unavailable);
      pushCdsAgentEvent(session, 'log', {
        level: 'warn',
        message: unavailable.message,
        source: `${session.runtime}-runtime`,
      });
      session.logs.push(`[${session.updatedAt}] runtime unavailable runtime=${session.runtime} owner=cds-managed-runtime reason=${unavailable.code}`);
      res.status(202).json({
        item: toCdsAgentSessionView(session),
        accepted: false,
        runtimeOwnedBy: 'cds-managed-runtime',
        error: unavailable,
      });
      return;
    }

    const approvalId = `approval-${session.events.length + 1}`;
    const needsApproval = session.toolPolicy === 'confirm-dangerous';
    pushCdsAgentEvent(session, 'tool_call', {
      approvalId,
      toolName: needsApproval ? 'shell.inspect' : 'fake_runtime.inspect',
      status: needsApproval ? 'waiting' : 'auto_allowed',
      riskLevel: needsApproval ? 'dangerous' : 'readonly',
      input: {
        promptLength: content.length,
        commandPreview: needsApproval ? 'inspect prompt in isolated fake runtime' : undefined,
      },
    });
    if (!needsApproval) {
      pushCdsAgentEvent(session, 'tool_result', {
        approvalId,
        toolName: 'fake_runtime.inspect',
        status: 'completed',
        content: 'fake runtime inspected the prompt',
      });
    }

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
    session.status = 'stopping';
    session.updatedAt = new Date().toISOString();
    pushCdsAgentEvent(session, 'status', { status: 'stopping', reason: 'session_stop_requested' });
    session.logs.push(`[${session.updatedAt}] session stopping`);
    session.status = 'stopped';
    session.updatedAt = new Date().toISOString();
    session.stoppedAt = session.updatedAt;
    pushCdsAgentEvent(session, 'status', { status: 'stopped', reason: 'session_stopped' });
    pushCdsAgentEvent(session, 'log', {
      level: 'info',
      message: 'session stopped',
      source: session.runtime === 'fake' ? 'fake-runtime' : `${session.runtime}-runtime`,
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

export function resolvePreviewRootDomain(): string {
  const direct = process.env.CDS_PREVIEW_DOMAIN
    || process.env.PREVIEW_DOMAIN
    || process.env.CDS_MAIN_DOMAIN
    || process.env.MAIN_DOMAIN
    || process.env.CDS_DASHBOARD_DOMAIN
    || process.env.DASHBOARD_DOMAIN;
  if (direct?.trim()) return direct.trim();
  const roots = (process.env.CDS_ROOT_DOMAINS || process.env.ROOT_DOMAINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return roots[0] || '';
}

export function shouldIncludeBranchServicesInInstanceDiscovery(
  project: Pick<Project, 'kind'> | null | undefined,
): boolean {
  // Source-mode shared-service projects, such as the CDS-managed runtime pool,
  // run as normal branch services rather than ServiceDeployment records. Keep
  // regular git/manual projects out of this path so MAP does not mistake
  // business branch services for CDS-managed Agent runtime capacity.
  return project?.kind === 'shared-service';
}

export function isRuntimeBranchService(profileId: string, profileName?: string, containerName?: string): boolean {
  const text = [profileId, profileName, containerName].filter(Boolean).join(' ').toLowerCase();
  if (!text.trim()) return false;
  if (/\b(admin|web|frontend|ui|dashboard)\b/.test(text.replace(/[-_]/g, ' '))) return false;
  return /\b(api|sidecar|runtime|worker|agent)\b/.test(text.replace(/[-_]/g, ' '));
}

interface ProjectRuntimeDiscovery {
  projectKind: string;
  deploymentCount: number;
  runningDeploymentCount: number;
  disabledHostDeploymentCount: number;
  branchCount: number;
  runningBranchCount: number;
  runningBranchServiceCount: number;
  runtimeBranchServiceCount: number;
  skippedBranchServiceCount: number;
  previewRootConfigured: boolean;
}

interface ProjectRuntimeInstancesResponse {
  instances: Array<Record<string, unknown>>;
  discovery: ProjectRuntimeDiscovery;
  capacity: Record<string, unknown>;
}

const CDS_MANAGED_RUNTIME_PROFILE_ID = 'claude-agent-sdk-runtime';
const CDS_MANAGED_RUNTIME_BRANCH_NAME = 'cds-managed-runtime';
const CDS_MANAGED_RUNTIME_CONTAINER_NAME = 'cds-claude-agent-sdk-runtime';

interface CdsManagedRuntimeReconcileOptions {
  apply: boolean;
  liveApply: boolean;
  force?: boolean;
  hostPort?: number;
  now: string;
  containerService?: Pick<ContainerService, 'runService' | 'waitForReadiness'>;
  portStart?: number;
}

function collectProjectRuntimeInstances(
  stateService: StateService,
  service: RemoteHostService,
  project: Project,
): ProjectRuntimeInstancesResponse {
  const latest = stateService.getLatestDeploymentsByProject(project.id);
  const instances: Array<Record<string, unknown>> = [];
  const discovery: ProjectRuntimeDiscovery = {
    projectKind: project.kind || 'unknown',
    deploymentCount: latest.length,
    runningDeploymentCount: 0,
    disabledHostDeploymentCount: 0,
    branchCount: 0,
    runningBranchCount: 0,
    runningBranchServiceCount: 0,
    runtimeBranchServiceCount: 0,
    skippedBranchServiceCount: 0,
    previewRootConfigured: false,
  };

  for (const dep of latest) {
    if (dep.status !== 'running') continue;
    discovery.runningDeploymentCount += 1;
    const host = service.getRaw(dep.hostId);
    if (!host || !host.isEnabled) {
      discovery.disabledHostDeploymentCount += 1;
      continue;
    }
    instances.push({
      deploymentId: dep.id,
      serviceKind: 'operator-fallback-deployment',
      capacityRole: 'operator-fallback',
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

  if (shouldIncludeBranchServicesInInstanceDiscovery(project)) {
    const projectSlug = project.slug || project.id;
    const previewRoot = resolvePreviewRootDomain();
    discovery.previewRootConfigured = Boolean(previewRoot);
    const branches = stateService.getBranchesForProject(project.id);
    discovery.branchCount = branches.length;
    for (const branch of branches) {
      if (branch.status !== 'running') continue;
      discovery.runningBranchCount += 1;
      for (const serviceState of Object.values(branch.services || {})) {
        if (serviceState.status !== 'running') continue;
        discovery.runningBranchServiceCount += 1;
        const profile = stateService.getBuildProfile(serviceState.profileId);
        if (!isRuntimeBranchService(serviceState.profileId, profile?.name, serviceState.containerName)) {
          discovery.skippedBranchServiceCount += 1;
          continue;
        }
        discovery.runtimeBranchServiceCount += 1;
        const previewSlug = computePreviewSlug(branch.branch, projectSlug);
        const baseUrl = previewRoot ? `https://${previewSlug}.${previewRoot}` : undefined;
        const officialSdkRuntime = isOfficialSdkRuntimeService('claude-sdk', serviceState, profile);
        instances.push({
          deploymentId: `branch:${branch.id}:${serviceState.profileId}`,
          profileId: serviceState.profileId,
          branchId: branch.id,
          branch: branch.branch,
          serviceKind: 'branch-service',
          capacityRole: officialSdkRuntime ? 'product-runtime' : 'runtime-service',
          runtimeOwnedBy: 'cds-managed-runtime',
          runtimeAdapter: officialSdkRuntime ? 'claude-agent-sdk' : 'unknown',
          loopOwner: officialSdkRuntime ? 'claude-agent-sdk' : 'unknown',
          projectKind: project.kind,
          host: serviceState.containerName,
          port: serviceState.hostPort,
          baseUrl,
          healthy: true,
          version: branch.githubCommitSha,
          deployedAt: branch.lastDeployAt || branch.createdAt,
          tags: ['system', 'default', 'cds-sidecar', `profile:${serviceState.profileId}`, `branch:${branch.branch}`],
          hostName: profile?.name || serviceState.profileId,
          hostId: branch.id,
        });
      }
    }
  }

  return {
    instances,
    discovery,
    capacity: buildCdsManagedRuntimeCapacity(project, instances, discovery, service.list()),
  };
}

async function reconcileCdsManagedRuntimeCapacity(
  stateService: StateService,
  service: RemoteHostService,
  project: Project,
  options: CdsManagedRuntimeReconcileOptions,
): Promise<Record<string, unknown>> {
  const before = collectProjectRuntimeInstances(stateService, service, project);
  const alreadyAvailable = before.capacity.status === 'available';
  const shouldSkipApply = alreadyAvailable && !options.force;
  const planned = planCdsManagedRuntimeCapacity(stateService, project, {
    hostPort: options.hostPort,
    liveApply: options.liveApply,
    alreadyAvailable: shouldSkipApply,
  });

  if (!options.apply || shouldSkipApply) {
    return {
      requirement: 'CDS_MANAGED_RUNTIME_CAPACITY',
      applied: false,
      status: shouldSkipApply ? 'available' : 'planned',
      runtimeOwnedBy: 'cds-managed-runtime',
      loopOwner: 'claude-agent-sdk',
      productPathOnly: true,
      fallbackScope: 'operator-debug-only',
      plan: planned,
      capacity: before.capacity,
      nextAction: shouldSkipApply
        ? 'CDS-managed official SDK runtime capacity already exists; continue with R1/S1/S2/S3.'
        : 'Apply this CDS-managed runtime reconcile plan with liveApply=true to start the CDS-managed container; do not ask product users for SSH/env/image.',
    };
  }

  const profile = buildCdsManagedRuntimeProfile(project.id);
  const worktreePath = resolveCdsManagedRuntimeWorktreePath();
  const existingProfile = stateService.getBuildProfile(CDS_MANAGED_RUNTIME_PROFILE_ID);
  let profileChange: 'created' | 'updated' | 'unchanged' = 'created';
  if (existingProfile) {
    if (existingProfile.projectId !== project.id) {
      throw new Error(`runtime profile ${CDS_MANAGED_RUNTIME_PROFILE_ID} belongs to project ${existingProfile.projectId}`);
    }
    stateService.updateBuildProfile(CDS_MANAGED_RUNTIME_PROFILE_ID, profile);
    profileChange = 'updated';
  } else {
    stateService.addBuildProfile(profile);
  }

  const branch = stateService.findBranchByProjectAndName(project.id, CDS_MANAGED_RUNTIME_BRANCH_NAME);
  const existingService = branch?.services?.[CDS_MANAGED_RUNTIME_PROFILE_ID];
  const hostPort = options.hostPort
    || existingService?.hostPort
    || (options.liveApply && options.portStart ? stateService.allocatePort(options.portStart) : 0);
  const serviceState: ServiceState = {
    profileId: CDS_MANAGED_RUNTIME_PROFILE_ID,
    containerName: CDS_MANAGED_RUNTIME_CONTAINER_NAME,
    hostPort,
    status: hostPort && !options.liveApply ? 'running' : 'starting',
  };
  let branchChange: 'created' | 'updated' = 'created';
  let serviceChange: 'created' | 'updated' = 'created';
  let managedBranch: BranchEntry;
  if (branch) {
    branch.services = branch.services || {};
    serviceChange = branch.services[CDS_MANAGED_RUNTIME_PROFILE_ID] ? 'updated' : 'created';
    branch.services[CDS_MANAGED_RUNTIME_PROFILE_ID] = serviceState;
    branch.status = hostPort && !options.liveApply ? 'running' : 'idle';
    branch.worktreePath = worktreePath;
    branch.lastAccessedAt = options.now;
    branch.lastDeployAt = options.now;
    branchChange = 'updated';
    managedBranch = branch;
  } else {
    managedBranch = {
      id: `${slugifyRuntimeSegment(project.id)}-${CDS_MANAGED_RUNTIME_BRANCH_NAME}`,
      projectId: project.id,
      branch: CDS_MANAGED_RUNTIME_BRANCH_NAME,
      worktreePath,
      status: hostPort && !options.liveApply ? 'running' : 'idle',
      services: {
        [CDS_MANAGED_RUNTIME_PROFILE_ID]: serviceState,
      },
      createdAt: options.now,
      lastAccessedAt: options.now,
      lastDeployAt: options.now,
      githubCommitSha: 'cds-managed-runtime',
    };
    stateService.addBranch(managedBranch);
  }
  stateService.save();

  let liveApply: Record<string, unknown> = {
    requested: options.liveApply,
    attempted: false,
    status: options.liveApply ? 'not_started' : 'not_requested',
  };
  if (options.liveApply) {
    liveApply = await startCdsManagedRuntimeContainer(
      stateService,
      project,
      managedBranch,
      profile,
      serviceState,
      options,
    );
  }

  const after = collectProjectRuntimeInstances(stateService, service, project);
  return {
    requirement: 'CDS_MANAGED_RUNTIME_CAPACITY',
    applied: true,
    status: after.capacity.status === 'available' ? 'available' : 'starting',
    runtimeOwnedBy: 'cds-managed-runtime',
    loopOwner: 'claude-agent-sdk',
    productPathOnly: true,
    fallbackScope: 'operator-debug-only',
    changes: {
      profile: profileChange,
      branch: branchChange,
      service: serviceChange,
    },
    profileId: CDS_MANAGED_RUNTIME_PROFILE_ID,
    branch: CDS_MANAGED_RUNTIME_BRANCH_NAME,
    containerName: CDS_MANAGED_RUNTIME_CONTAINER_NAME,
    liveApply,
    capacity: after.capacity,
    nextAction: after.capacity.status === 'available'
      ? 'CDS-managed official SDK runtime capacity is available; continue with R1/S1/S2/S3.'
      : 'CDS accepted the managed runtime profile and branch-service record, but live capacity is not available yet; inspect liveApply status and continue CDS container start without SSH/env/image handoff.',
  };
}

function planCdsManagedRuntimeCapacity(
  stateService: StateService,
  project: Project,
  options: { hostPort?: number; liveApply: boolean; alreadyAvailable: boolean },
): Array<Record<string, unknown>> {
  if (options.alreadyAvailable) {
    return [{ step: 'verify-capacity', state: 'already_available' }];
  }
  const profile = stateService.getBuildProfile(CDS_MANAGED_RUNTIME_PROFILE_ID);
  const branch = stateService.findBranchByProjectAndName(project.id, CDS_MANAGED_RUNTIME_BRANCH_NAME);
  const liveApplyState = options.liveApply ? 'start_container' : 'not_requested';
  return [
    {
      step: 'ensure-build-profile',
      profileId: CDS_MANAGED_RUNTIME_PROFILE_ID,
      state: profile ? 'update_existing' : 'create',
      runtimeOwnedBy: 'cds-managed-runtime',
      loopOwner: 'claude-agent-sdk',
    },
    {
      step: 'ensure-branch-service',
      branch: CDS_MANAGED_RUNTIME_BRANCH_NAME,
      state: branch ? 'update_existing' : 'create',
      targetServiceStatus: options.hostPort && !options.liveApply ? 'running' : 'starting',
    },
    {
      step: 'start-cds-managed-container',
      state: liveApplyState,
      runtimeOwnedBy: 'cds-managed-runtime',
      fallbackScope: 'operator-debug-only',
    },
    {
      step: 'verify-product-capacity',
      expectedRequirement: 'CDS_MANAGED_RUNTIME_CAPACITY',
      expectedCapacityRole: 'product-runtime',
      fallbackScope: 'operator-debug-only',
    },
  ];
}

async function startCdsManagedRuntimeContainer(
  stateService: StateService,
  project: Project,
  branch: BranchEntry,
  profile: BuildProfile,
  serviceState: ServiceState,
  options: CdsManagedRuntimeReconcileOptions,
): Promise<Record<string, unknown>> {
  if (!options.containerService) {
    serviceState.status = 'starting';
    branch.status = 'idle';
    stateService.save();
    return {
      requested: true,
      attempted: false,
      status: 'missing_container_service',
      message: 'CDS container service is not injected into the runtime capacity reconciler.',
      fallbackScope: 'operator-debug-only',
    };
  }
  if (!serviceState.hostPort || serviceState.hostPort <= 0) {
    serviceState.status = 'starting';
    branch.status = 'idle';
    stateService.save();
    return {
      requested: true,
      attempted: false,
      status: 'missing_host_port',
      message: 'CDS could not allocate a host port for the managed runtime container.',
      fallbackScope: 'operator-debug-only',
    };
  }

  const logs: string[] = [];
  const startedAt = Date.now();
  serviceState.status = 'building';
  branch.status = 'building';
  branch.lastDeployAt = options.now;
  stateService.save();

  try {
    await options.containerService.runService(
      branch,
      profile,
      serviceState,
      (chunk) => {
        logs.push(...chunk.split('\n').map(line => line.trim()).filter(Boolean).slice(-20));
        if (logs.length > 20) logs.splice(0, logs.length - 20);
      },
      stateService.getCustomEnv(project.id),
    );

    serviceState.status = 'starting';
    branch.status = 'starting';
    stateService.save();

    const ready = await options.containerService.waitForReadiness(
      serviceState.hostPort,
      profile.readinessProbe,
      (info) => {
        logs.push(`readiness ${info.stage} ${info.attempt}/${info.max} ${info.ok ? 'ok' : info.error || 'failed'}`);
        if (logs.length > 20) logs.splice(0, logs.length - 20);
      },
      (chunk) => {
        logs.push(...chunk.split('\n').map(line => line.trim()).filter(Boolean).slice(-20));
        if (logs.length > 20) logs.splice(0, logs.length - 20);
      },
    );

    if (!ready) {
      serviceState.status = 'error';
      serviceState.errorMessage = 'CDS-managed official SDK runtime readiness probe failed';
      branch.status = 'error';
      branch.errorMessage = serviceState.errorMessage;
      stateService.save();
      return {
        requested: true,
        attempted: true,
        status: 'readiness_failed',
        hostPort: serviceState.hostPort,
        durationMs: Date.now() - startedAt,
        logs,
        fallbackScope: 'operator-debug-only',
      };
    }

    serviceState.status = 'running';
    serviceState.errorMessage = undefined;
    branch.status = 'running';
    branch.errorMessage = undefined;
    branch.lastAccessedAt = new Date().toISOString();
    branch.lastDeployAt = branch.lastAccessedAt;
    stateService.save();
    return {
      requested: true,
      attempted: true,
      status: 'running',
      hostPort: serviceState.hostPort,
      durationMs: Date.now() - startedAt,
      logs,
      fallbackScope: 'operator-debug-only',
    };
  } catch (err) {
    const message = (err as Error).message;
    serviceState.status = 'error';
    serviceState.errorMessage = message;
    branch.status = 'error';
    branch.errorMessage = message;
    stateService.save();
    return {
      requested: true,
      attempted: true,
      status: 'start_failed',
      hostPort: serviceState.hostPort,
      durationMs: Date.now() - startedAt,
      error: message,
      logs,
      fallbackScope: 'operator-debug-only',
    };
  }
}

function buildCdsManagedRuntimeProfile(projectId: string): BuildProfile {
  return {
    id: CDS_MANAGED_RUNTIME_PROFILE_ID,
    projectId,
    name: 'Claude Agent SDK Runtime',
    dockerImage: 'python:3.12-slim',
    workDir: 'claude-sdk-sidecar',
    containerWorkDir: '/app',
    command: 'apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* && python -m pip install --no-cache-dir -r requirements.txt && uvicorn app.main:app --host 0.0.0.0 --port 7400 --no-server-header',
    containerPort: 7400,
    env: {
      SIDECAR_AGENT_ADAPTER: 'claude-agent-sdk',
      SIDECAR_RUNTIME_OWNER: 'cds-managed-runtime',
      SIDECAR_LOOP_OWNER: 'claude-agent-sdk',
      SIDECAR_PROVIDER_KEY_MODE: 'runtime-profile-or-env',
      SIDECAR_TOKEN: 'cds-managed',
    },
    readinessProbe: {
      path: '/readyz',
      timeoutSeconds: 30,
      intervalSeconds: 1,
    },
  };
}

function resolveCdsManagedRuntimeWorktreePath(): string {
  const cwd = process.cwd();
  return path.basename(cwd) === 'cds' ? path.dirname(cwd) : cwd;
}

function parseOptionalHostPort(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function slugifyRuntimeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'shared-service';
}

function buildCdsManagedRuntimeCapacity(
  project: Project,
  instances: Array<Record<string, unknown>>,
  discovery: ProjectRuntimeDiscovery,
  remoteHosts: Array<{ isEnabled?: boolean }>,
): Record<string, unknown> {
  const productRuntimeInstances = instances.filter(instance =>
    instance.capacityRole === 'product-runtime'
    && instance.runtimeOwnedBy === 'cds-managed-runtime'
    && instance.runtimeAdapter === 'claude-agent-sdk'
    && instance.loopOwner === 'claude-agent-sdk'
    && instance.healthy !== false);
  const legacyFallbackInstances = instances.filter(instance =>
    instance.capacityRole === 'operator-fallback');
  const enabledFallbackHostCount = remoteHosts.filter(host => host.isEnabled !== false).length;
  const available = project.kind === 'shared-service' && productRuntimeInstances.length > 0;

  return {
    requirement: 'CDS_MANAGED_RUNTIME_CAPACITY',
    status: available ? 'available' : 'missing',
    runtimeOwnedBy: 'cds-managed-runtime',
    loopOwner: 'claude-agent-sdk',
    productPath: {
      projectKind: project.kind,
      runningOfficialSdkRuntimeCount: productRuntimeInstances.length,
      branchRuntimeServiceCount: discovery.runtimeBranchServiceCount,
      runningBranchServiceCount: discovery.runningBranchServiceCount,
      previewRootConfigured: discovery.previewRootConfigured,
    },
    legacyFallback: {
      runningDeploymentCount: discovery.runningDeploymentCount,
      enabledRemoteHostCount: enabledFallbackHostCount,
      runningFallbackInstanceCount: legacyFallbackInstances.length,
      scope: 'operator-debug-only',
    },
    nextAction: available
      ? 'CDS-managed runtime capacity is available; continue with R1/S1/S2/S3.'
      : 'Provision or start a CDS-managed official SDK runtime/container/sandbox inside the shared-service project; do not ask product users for SSH/env/image.',
  };
}

type CdsAgentSessionStatus = 'creating' | 'running' | 'idle' | 'stopping' | 'stopped' | 'failed';
type CdsAgentEventType = 'status' | 'runtime_init' | 'text_delta' | 'tool_call' | 'tool_result' | 'log' | 'error' | 'done' | 'hook' | 'usage';

interface CdsAgentResourcePolicy {
  cpuCores: number;
  memoryMb: number;
  timeoutSeconds: number;
  networkPolicy: 'restricted' | 'egress-only' | 'open';
  autoCleanupMinutes: number;
}

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
  modelBaseUrl: string | null;
  modelProtocol: string | null;
  modelApiKey: string | null;
  workspaceRoot: string | null;
  gitRepository: string | null;
  gitRef: string | null;
  hasModelApiKey: boolean;
  runtimeProfileId: string | null;
  resourcePolicy: CdsAgentResourcePolicy;
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

interface CdsManagedRuntimeTransport {
  source: 'cds-branch-service';
  runtimeOwnedBy: 'cds-managed-runtime';
  baseUrl: string;
  authToken?: string;
  authTokenSource?: 'build-profile-env';
  projectId: string;
  projectKind: string;
  branchId: string;
  branch: string;
  profileId: string;
  profileName: string;
  containerName: string;
  hostPort: number;
  runtimeAdapter: 'claude-agent-sdk';
  loopOwner: 'claude-agent-sdk';
}

interface CdsManagedRuntimeResult {
  accepted: boolean;
  error?: Record<string, unknown>;
}

function authenticateProjectRequest(
  authorization: string | string[] | undefined,
  projectId: string,
  pairing: CdsPairingService,
  requiredScopes: string[],
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const token = extractBearerToken(authorization);
  const connection = pairing.authenticateLongToken(token);
  if (!connection) {
    return { ok: false, status: 401, code: 'invalid_long_token', message: 'invalid connection token' };
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
    modelBaseUrl: session.modelBaseUrl,
    modelProtocol: session.modelProtocol,
    workspaceRoot: session.workspaceRoot,
    gitRepository: session.gitRepository,
    gitRef: session.gitRef,
    hasModelApiKey: session.hasModelApiKey,
    runtimeProfileId: session.runtimeProfileId,
    resourcePolicy: session.resourcePolicy,
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

function resolveCdsManagedRuntimeTransport(
  stateService: StateService,
  project: Project,
  session: CdsAgentSession,
): CdsManagedRuntimeTransport | null {
  if (project.kind !== 'shared-service') return null;
  const branches = stateService.getBranchesForProject(project.id);
  const candidates: CdsManagedRuntimeTransport[] = [];
  for (const branch of branches) {
    if (branch.status !== 'running') continue;
    for (const serviceState of Object.values(branch.services || {})) {
      if (serviceState.status !== 'running') continue;
      const profile = stateService.getBuildProfile(serviceState.profileId);
      if (!isOfficialSdkRuntimeService(session.runtime, serviceState, profile)) continue;
      const baseUrl = resolveCdsManagedRuntimeBaseUrl(project, branch, serviceState);
      if (!baseUrl) continue;
      const token = normalizeOptionalString(profile?.env?.SIDECAR_TOKEN);
      candidates.push({
        source: 'cds-branch-service',
        runtimeOwnedBy: 'cds-managed-runtime',
        baseUrl,
        authToken: token || undefined,
        authTokenSource: token ? 'build-profile-env' : undefined,
        projectId: project.id,
        projectKind: project.kind,
        branchId: branch.id,
        branch: branch.branch,
        profileId: serviceState.profileId,
        profileName: profile?.name || serviceState.profileId,
        containerName: serviceState.containerName,
        hostPort: serviceState.hostPort,
        runtimeAdapter: 'claude-agent-sdk',
        loopOwner: 'claude-agent-sdk',
      });
    }
  }
  candidates.sort((a, b) => scoreCdsManagedRuntimeTransport(b) - scoreCdsManagedRuntimeTransport(a));
  return candidates[0] || null;
}

function scoreCdsManagedRuntimeTransport(transport: CdsManagedRuntimeTransport): number {
  let score = 0;
  if (transport.profileId === CDS_MANAGED_RUNTIME_PROFILE_ID) score += 100;
  if (transport.branch === CDS_MANAGED_RUNTIME_BRANCH_NAME) score += 50;
  if (transport.containerName === CDS_MANAGED_RUNTIME_CONTAINER_NAME) score += 20;
  if (transport.authToken) score += 1;
  return score;
}

function isOfficialSdkRuntimeService(
  runtime: string,
  serviceState: ServiceState,
  profile?: BuildProfile,
): boolean {
  if (runtime !== 'claude-sdk') return false;
  const text = [
    serviceState.profileId,
    serviceState.containerName,
    profile?.name,
    profile?.workDir,
    profile?.dockerImage,
    profile?.command,
    profile?.env?.SIDECAR_AGENT_ADAPTER,
  ].filter(Boolean).join(' ').toLowerCase();
  if (!text.trim()) return false;
  if (profile?.env?.SIDECAR_AGENT_ADAPTER === 'legacy-sidecar') return false;
  if (text.includes('claude-agent-sdk') || text.includes('claude-sdk-sidecar')) return true;
  return text.includes('claude') && (text.includes('agent') || text.includes('sidecar') || text.includes('runtime'));
}

function resolveCdsManagedRuntimeBaseUrl(
  project: Project,
  branch: BranchEntry,
  serviceState: ServiceState,
): string | null {
  if (Number.isInteger(serviceState.hostPort) && serviceState.hostPort > 0) {
    return `http://127.0.0.1:${serviceState.hostPort}`;
  }
  const previewRoot = resolvePreviewRootDomain();
  if (!previewRoot) return null;
  const previewSlug = computePreviewSlug(branch.branch, project.slug || project.id);
  return `https://${previewSlug}.${previewRoot}`;
}

function toCdsManagedRuntimeTransportView(transport: CdsManagedRuntimeTransport): Record<string, unknown> {
  return {
    source: transport.source,
    runtimeOwnedBy: transport.runtimeOwnedBy,
    baseUrl: transport.baseUrl,
    projectId: transport.projectId,
    projectKind: transport.projectKind,
    branchId: transport.branchId,
    branch: transport.branch,
    profileId: transport.profileId,
    profileName: transport.profileName,
    containerName: transport.containerName,
    hostPort: transport.hostPort,
    runtimeAdapter: transport.runtimeAdapter,
    loopOwner: transport.loopOwner,
    auth: transport.authToken ? { configured: true, source: transport.authTokenSource } : { configured: false },
  };
}

function startCdsManagedOfficialSdkTransport(
  session: CdsAgentSession,
  content: string,
  transport: CdsManagedRuntimeTransport,
): void {
  void Promise.resolve()
    .then(() => runCdsManagedOfficialSdkTransport(session, content, transport))
    .catch((err) => {
      const error = {
        code: 'cds_managed_runtime_transport_background_failed',
        message: err instanceof Error ? err.message : String(err),
        runtime: session.runtime,
        runtimeProfileId: session.runtimeProfileId,
        transport: toCdsManagedRuntimeTransportView(transport),
        retryable: true,
      };
      session.status = 'failed';
      session.updatedAt = new Date().toISOString();
      pushCdsAgentEvent(session, 'error', error);
      session.logs.push(`[${session.updatedAt}] runtime transport background failed owner=cds-managed-runtime`);
    });
}

async function runCdsManagedOfficialSdkTransport(
  session: CdsAgentSession,
  content: string,
  transport: CdsManagedRuntimeTransport,
): Promise<CdsManagedRuntimeResult> {
  const runId = `${session.id}-${session.events.length + 1}`;
  const timeoutMs = Math.max(1_000, session.resourcePolicy.timeoutSeconds * 1_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${transport.baseUrl.replace(/\/+$/, '')}/v1/agent/run`;
  const requestBody = {
    runId,
    model: session.model || 'claude-sonnet-4-20250514',
    messages: session.messages.map((message) => ({ role: message.role, content: message.content })),
    runtimeAdapter: 'claude-agent-sdk',
    mapSessionId: session.id,
    traceId: session.id,
    maxTurns: resolveAgentMaxTurns(content),
    timeoutSeconds: session.resourcePolicy.timeoutSeconds,
    baseUrl: session.modelBaseUrl || undefined,
    apiKey: session.modelApiKey || undefined,
    protocol: session.modelProtocol || undefined,
    workspaceRoot: session.workspaceRoot || undefined,
    gitRepository: session.gitRepository || undefined,
    gitRef: session.gitRef || undefined,
    systemPrompt: [
      'You are running as a CDS-managed Claude SDK runtime.',
      'MAP is only the control-plane client; CDS owns runtime/container/sandbox execution.',
    ].join(' '),
  };

  pushCdsAgentEvent(session, 'log', {
    level: 'info',
    message: `dispatching run to CDS-managed official SDK runtime profile=${transport.profileId} branch=${transport.branch}`,
    source: 'cds-managed-runtime-transport',
  });
  session.logs.push(`[${new Date().toISOString()}] dispatch runtime=${session.runtime} owner=cds-managed-runtime transport=${transport.source} profile=${transport.profileId} branch=${transport.branch}`);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    if (transport.authToken) headers.Authorization = `Bearer ${transport.authToken}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      const error = {
        code: 'cds_managed_runtime_transport_http_error',
        message: `CDS-managed runtime returned HTTP ${response.status}`,
        status: response.status,
        runtime: session.runtime,
        runtimeProfileId: session.runtimeProfileId,
        transport: toCdsManagedRuntimeTransportView(transport),
        body: body.slice(0, 800),
        retryable: response.status >= 500,
      };
      session.status = 'failed';
      pushCdsAgentEvent(session, 'error', error);
      session.logs.push(`[${new Date().toISOString()}] runtime transport http error status=${response.status} owner=cds-managed-runtime`);
      return { accepted: false, error };
    }

    const result = response.body
      ? await ingestOfficialSdkSseStream(session, response.body, transport)
      : ingestOfficialSdkSse(session, await response.text(), transport);
    session.updatedAt = new Date().toISOString();
    return result;
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    const error = {
      code: aborted ? 'cds_managed_runtime_transport_timeout' : 'cds_managed_runtime_transport_failed',
      message: aborted
        ? `CDS-managed runtime transport timed out after ${session.resourcePolicy.timeoutSeconds}s`
        : (err as Error).message,
      runtime: session.runtime,
      runtimeProfileId: session.runtimeProfileId,
      transport: toCdsManagedRuntimeTransportView(transport),
      retryable: true,
    };
    session.status = 'failed';
    pushCdsAgentEvent(session, 'error', error);
    session.logs.push(`[${new Date().toISOString()}] runtime transport failed owner=cds-managed-runtime reason=${error.code}`);
    return { accepted: false, error };
  } finally {
    clearTimeout(timer);
  }
}

function ingestOfficialSdkSse(
  session: CdsAgentSession,
  body: string,
  transport: CdsManagedRuntimeTransport,
): CdsManagedRuntimeResult {
  const state: OfficialSdkSseIngestState = { finalText: '', accepted: false };
  for (const frame of parseSseFrames(body)) {
    const terminal = ingestOfficialSdkSseFrame(session, frame, transport, state);
    if (terminal) return terminal;
  }
  return finishOfficialSdkSseIngest(session, transport, state);
}

async function ingestOfficialSdkSseStream(
  session: CdsAgentSession,
  stream: ReadableStream<Uint8Array>,
  transport: CdsManagedRuntimeTransport,
): Promise<CdsManagedRuntimeResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const state: OfficialSdkSseIngestState = { finalText: '', accepted: false };
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (chunk) {
        const terminal = ingestOfficialSdkSseFrame(session, parseSseFrameChunk(chunk), transport, state);
        if (terminal) {
          await reader.cancel();
          return terminal;
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }

  buffer += decoder.decode();
  const finalChunk = buffer.trim();
  if (finalChunk) {
    const terminal = ingestOfficialSdkSseFrame(session, parseSseFrameChunk(finalChunk), transport, state);
    if (terminal) return terminal;
  }

  return finishOfficialSdkSseIngest(session, transport, state);
}

interface OfficialSdkSseIngestState {
  finalText: string;
  accepted: boolean;
}

function ingestOfficialSdkSseFrame(
  session: CdsAgentSession,
  frame: { event?: string; data: string[] },
  transport: CdsManagedRuntimeTransport,
  state: OfficialSdkSseIngestState,
): CdsManagedRuntimeResult | null {
  const rawData = frame.data.join('\n').trim();
  if (!rawData) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawData) as Record<string, unknown>;
  } catch {
    pushCdsAgentEvent(session, 'log', {
      level: 'warn',
      message: `ignored malformed runtime SSE event=${frame.event || 'message'}`,
      source: 'cds-managed-runtime-transport',
    });
    return null;
  }

  const sidecarType = normalizeOptionalString(payload.type) || frame.event || 'log';
  state.accepted = true;
  if (sidecarType === 'runtime_init') {
    pushCdsAgentEvent(session, 'runtime_init', {
      message: payload.message,
      content: payload.content,
      runtimeAdapter: 'claude-agent-sdk',
      loopOwner: 'claude-agent-sdk',
      runtimeOwnedBy: 'cds-managed-runtime',
      transport: toCdsManagedRuntimeTransportView(transport),
    });
    return null;
  }
  if (sidecarType === 'text_delta') {
    const text = normalizeOptionalString(payload.text) || '';
    if (text) state.finalText += text;
    pushCdsAgentEvent(session, 'text_delta', { text });
    return null;
  }
  if (sidecarType === 'tool_call') {
    pushCdsAgentEvent(session, 'tool_call', {
      approvalId: normalizeOptionalString(payload.tool_use_id),
      toolName: normalizeOptionalString(payload.tool_name),
      input: payload.tool_input,
      content: payload.content,
      status: 'waiting',
      source: 'claude-agent-sdk',
    });
    return null;
  }
  if (sidecarType === 'tool_result') {
    pushCdsAgentEvent(session, 'tool_result', {
      approvalId: normalizeOptionalString(payload.tool_use_id),
      toolName: normalizeOptionalString(payload.tool_name),
      content: payload.content,
      status: 'completed',
      source: 'claude-agent-sdk',
    });
    return null;
  }
  if (sidecarType === 'usage') {
    pushCdsAgentEvent(session, 'usage', {
      inputTokens: payload.input_tokens,
      outputTokens: payload.output_tokens,
      content: payload.content,
      source: 'claude-agent-sdk',
    });
    return null;
  }
  if (sidecarType === 'done') {
    const doneText = normalizeOptionalString(payload.final_text) || state.finalText;
    pushCdsAgentEvent(session, 'done', {
      finalText: doneText,
      inputTokens: payload.input_tokens,
      outputTokens: payload.output_tokens,
      content: payload.content,
    });
    session.messages.push({ role: 'assistant', content: doneText, createdAt: new Date().toISOString() });
    session.status = 'idle';
    session.logs.push(`[${new Date().toISOString()}] runtime done owner=cds-managed-runtime loopOwner=claude-agent-sdk`);
    return null;
  }
  if (sidecarType === 'error') {
    const code = normalizeOptionalString(payload.error_code) || 'cds_managed_runtime_error';
    const error = {
      code,
      message: normalizeOptionalString(payload.message) || 'CDS-managed official SDK runtime returned an error',
      content: payload.content,
      runtime: session.runtime,
      runtimeProfileId: session.runtimeProfileId,
      transport: toCdsManagedRuntimeTransportView(transport),
      retryable: code !== 'claude_agent_sdk_result_error',
    };
    session.status = 'failed';
    pushCdsAgentEvent(session, 'error', error);
    return { accepted: false, error };
  }

  pushCdsAgentEvent(session, 'log', {
    level: 'info',
    message: `runtime event ${sidecarType}`,
    source: 'claude-agent-sdk',
    payload,
  });
  return null;
}

function finishOfficialSdkSseIngest(
  session: CdsAgentSession,
  transport: CdsManagedRuntimeTransport,
  state: OfficialSdkSseIngestState,
): CdsManagedRuntimeResult {
  if (!state.accepted) {
    const error = {
      code: 'cds_managed_runtime_empty_stream',
      message: 'CDS-managed official SDK runtime returned no SSE events',
      runtime: session.runtime,
      runtimeProfileId: session.runtimeProfileId,
      transport: toCdsManagedRuntimeTransportView(transport),
      retryable: true,
    };
    session.status = 'failed';
    pushCdsAgentEvent(session, 'error', error);
    return { accepted: false, error };
  }

  if (session.status === 'running') session.status = 'idle';
  return { accepted: true };
}

function parseSseFrames(body: string): Array<{ event?: string; data: string[] }> {
  const normalized = body.replace(/\r\n/g, '\n');
  const chunks = normalized.split(/\n\n+/).map((chunk) => chunk.trim()).filter(Boolean);
  return chunks.map((chunk) => {
    return parseSseFrameChunk(chunk);
  });
}

function parseSseFrameChunk(chunk: string): { event?: string; data: string[] } {
  const frame: { event?: string; data: string[] } = { data: [] };
  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      frame.event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      frame.data.push(line.slice('data:'.length).trimStart());
    }
  }
  return frame;
}

function buildCdsManagedRuntimeUnavailable(session: CdsAgentSession): Record<string, unknown> {
  return {
    code: 'cds_managed_runtime_unavailable',
    message: `${session.runtime} runtime is owned by CDS, but no CDS-managed runtime/container/sandbox execution path is available yet`,
    runtime: session.runtime,
    runtimeProfileId: session.runtimeProfileId,
    mapRole: 'control-plane-client',
    cdsRole: 'runtime-container-sandbox-manager',
    fallbackScope: 'operator-debug-only',
    retryable: true,
    nextActions: [
      'restore or create a CDS-managed runtime project/profile/container',
      'route /agent-sessions execution to the CDS-managed official SDK runtime',
      'keep SSH, image, and env handoff as operator/debug fallback only',
    ],
  };
}

function normalizeRuntime(value: unknown): string {
  return value === 'claude-sdk' || value === 'codex' || value === 'custom' ? value : 'fake';
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeAgentResourcePolicy(value: unknown): CdsAgentResourcePolicy {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    cpuCores: clampNumber(raw.cpuCores, 2, 0.25, 8),
    memoryMb: Math.round(clampNumber(raw.memoryMb, 4096, 512, 32768)),
    timeoutSeconds: Math.round(clampNumber(raw.timeoutSeconds, 900, 30, 7200)),
    networkPolicy: normalizeAgentNetworkPolicy(raw.networkPolicy),
    autoCleanupMinutes: Math.round(clampNumber(raw.autoCleanupMinutes, 30, 5, 1440)),
  };
}

function normalizeAgentNetworkPolicy(value: unknown): CdsAgentResourcePolicy['networkPolicy'] {
  return value === 'egress-only' || value === 'open' || value === 'restricted' ? value : 'restricted';
}

function resolveAgentMaxTurns(content: string): number {
  const text = content || '';
  return (
    text.includes('创建 PR')
    || text.includes('提交 PR')
    || /create pr/i.test(text)
    || /pull request/i.test(text)
    || text.includes('巡检')
    || text.includes('修复')
    || /review/i.test(text)
  ) ? 40 : 18;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
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
