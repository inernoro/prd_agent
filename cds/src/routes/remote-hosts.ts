/**
 * 远程主机管理路由（系统级，2026-05-06）
 *
 * shared-service 项目部署到的目标 SSH 主机登记表。
 * SSH 凭据通过 sealToken 加密存储，明文不出库。
 *
 * 端点：
 *   GET    /api/cds-system/remote-hosts        列表（不含密文）
 *   GET    /api/cds-system/remote-hosts/:id    详情（不含密文）
 *   POST   /api/cds-system/remote-hosts        创建
 *   PATCH  /api/cds-system/remote-hosts/:id    更新（含可选重置私钥）
 *   DELETE /api/cds-system/remote-hosts/:id    删除
 *   POST   /api/cds-system/remote-hosts/:id/test  连接测试（v1: 占位返回，
 *          真实 SSH 测试在 Phase A.3 SidecarDeployer 中实现）
 *
 * 详见 doc/plan.cds-shared-service-extension.md。
 *
 * 命名规范：路径走 `/api/cds-system/*` 前缀（系统级），符合
 * .claude/rules/scope-naming.md §3。
 */
import { Router } from 'express';
import type { StateService } from '../services/state.js';
import {
  RemoteHostService,
  type RemoteHostInput,
} from '../services/sidecar/remote-host-service.js';

export interface RemoteHostsRouterDeps {
  stateService: StateService;
}

export function createRemoteHostsRouter(deps: RemoteHostsRouterDeps): Router {
  const service = new RemoteHostService(deps.stateService);
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
   * 连接测试（占位）。真实 SSH 测试在 Phase A.3 SidecarDeployer 落地后接入。
   * 当前返回 501 + 提示，避免 UI 误以为连接成功。
   */
  router.post('/cds-system/remote-hosts/:id/test', (req, res) => {
    const host = service.getRaw(req.params.id);
    if (!host) {
      res.status(404).json({ error: 'remote host not found' });
      return;
    }
    res.status(501).json({
      ok: false,
      reason: 'ssh_test_not_implemented',
      message: '连接测试待 SidecarDeployer (Phase A.3) 接入 ssh2 后启用',
      hostFingerprint: host.sshPrivateKeyFingerprint,
    });
  });

  return router;
}
