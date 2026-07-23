/**
 * 复制集模式 REST API（design.cds.replica-set，2026-07-23）。
 *
 * 挂载于 /api，全部路径带 branchId（项目归属经分支反查后走 assertProjectAccess）。
 * 控制面语义见 services/replica-set.ts；流量分配在 forwarder 数据面。
 */
import { Router, type Request } from 'express';
import type { DeploymentVersion } from '../types.js';
import type { StateService } from '../services/state.js';
import { ReplicaSetError, REPLICA_MEMBER_LIMIT, type ReplicaSetService } from '../services/replica-set.js';
import type { VersionDispatchResult } from './deployment-versions.js';
import type { DeploymentVersionService } from '../services/deployment-version.js';

export interface ReplicaSetsRouterDeps {
  stateService: StateService;
  replicaSetService: ReplicaSetService;
  deploymentVersionService: DeploymentVersionService;
  assertProjectAccess: (req: Request, projectId: string) => { status: number; body: unknown } | null;
  dispatchVersion: (version: DeploymentVersion, trigger: 'manual' | 'rollback') => Promise<VersionDispatchResult>;
}

export function createReplicaSetsRouter(deps: ReplicaSetsRouterDeps): Router {
  const router = Router();

  const guard = (req: Request, branchId: string): { status: number; body: unknown } | null => {
    const branch = deps.stateService.getBranch(branchId);
    if (!branch) return { status: 404, body: { error: `分支不存在: ${branchId}` } };
    return deps.assertProjectAccess(req, branch.projectId);
  };

  router.get('/branches/:branchId/replica-sets', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const { replicaSets, candidates, snapshots } = deps.replicaSetService.list(req.params.branchId);
      res.json({ replicaSets, candidates, snapshots, memberLimit: REPLICA_MEMBER_LIMIT });
    } catch (err) {
      respondError(res, err);
    }
  });

  /**
   * 分流探测（强校验性）：CDS 服务端向真实入口（本机 forwarder，带预览 Host）
   * 发 N 个「无粘性」的独立请求，统计响应头 X-CDS-Replica 的真实落点分布。
   * 不是前端动画——每一条都是真实穿过 forwarder 加权选择的 HTTP 请求。
   */
  router.post('/branches/:branchId/replica-sets/:profileId/probe', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const host = typeof req.body?.host === 'string' ? req.body.host.trim().toLowerCase() : '';
    if (!host || !/^[a-z0-9.-]+$/.test(host)) { res.status(400).json({ error: '缺少合法的入口 host' }); return; }
    const path = typeof req.body?.path === 'string' && req.body.path.startsWith('/') ? req.body.path : '/';
    const count = Math.max(1, Math.min(50, Number(req.body?.count) || 20));
    const forwarderPort = Number(process.env.CDS_FORWARDER_PORT) || 9090;
    const hits: Array<{ seq: number; servedBy: string; status: number }> = [];
    const tally: Record<string, number> = {};
    // 必须用原生 http.request：fetch(undici) 会静默忽略自定义 Host 头，
    // 请求匹配不到分支路由 → 全落 unknown-host 兜底被误记成 primary
    // （2026-07-23 用户实测「100% 主版本」抓到的真 bug）。
    const { request: httpRequest } = await import('node:http');
    const probeOnce = (seq: number): Promise<{ servedBy: string; status: number }> =>
      new Promise((resolve) => {
        const req2 = httpRequest({
          host: '127.0.0.1',
          port: forwarderPort,
          method: 'GET',
          path: `${path}${path.includes('?') ? '&' : '?'}__probe=${seq}`,
          headers: { Host: host, 'X-CDS-Probe': '1' },
          timeout: 8000,
        }, (resp) => {
          resp.resume();
          resolve({ servedBy: String(resp.headers['x-cds-replica'] || 'primary'), status: resp.statusCode || 0 });
        });
        req2.on('timeout', () => { req2.destroy(); resolve({ servedBy: 'error', status: 0 }); });
        req2.on('error', () => resolve({ servedBy: 'error', status: 0 }));
        req2.end();
      });
    for (let i = 0; i < count; i += 1) {
      const r = await probeOnce(i);
      hits.push({ seq: i + 1, servedBy: r.servedBy, status: r.status });
      tally[r.servedBy] = (tally[r.servedBy] || 0) + 1;
    }
    res.json({ count, host, path, tally, hits });
  });

  // 隔离库快照删除（保留语义的唯一出口：显式删除才 drop 数据库）
  router.delete('/branches/:branchId/replica-db-snapshots/:snapshotId', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const snapshot = await deps.replicaSetService.deleteDbSnapshot(req.params.branchId, req.params.snapshotId);
      res.json({ dropped: true, dbName: snapshot.dbName });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.post('/branches/:branchId/replica-sets/:profileId', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const rs = deps.replicaSetService.enable(req.params.branchId, req.params.profileId);
      res.status(201).json({ replicaSet: rs });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.delete('/branches/:branchId/replica-sets/:profileId', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      await deps.replicaSetService.dissolve(req.params.branchId, req.params.profileId);
      res.json({ dissolved: true });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.post('/branches/:branchId/replica-sets/:profileId/members', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const versionId = typeof req.body?.versionId === 'string' ? req.body.versionId.trim() : '';
    try {
      const member = deps.replicaSetService.addMember(req.params.branchId, req.params.profileId, {
        versionId: versionId || undefined,
        label: typeof req.body?.label === 'string' ? req.body.label : undefined,
        weight: typeof req.body?.weight === 'number' ? req.body.weight : undefined,
        dbMode: req.body?.dbMode === 'isolated' ? 'isolated' : 'shared',
      });
      res.status(202).json({ member });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.patch('/branches/:branchId/replica-sets/:profileId/members/:memberId', (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      const rs = deps.replicaSetService.updateMember(
        req.params.branchId,
        req.params.profileId,
        req.params.memberId,
        {
          weight: typeof req.body?.weight === 'number' ? req.body.weight : undefined,
          label: typeof req.body?.label === 'string' ? req.body.label : undefined,
          primaryWeight: typeof req.body?.primaryWeight === 'number' ? req.body.primaryWeight : undefined,
        },
      );
      res.json({ replicaSet: rs });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.delete('/branches/:branchId/replica-sets/:profileId/members/:memberId', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    try {
      await deps.replicaSetService.removeMember(
        req.params.branchId,
        req.params.profileId,
        req.params.memberId,
      );
      res.json({ removed: true });
    } catch (err) {
      respondError(res, err);
    }
  });

  /**
   * 提升成员为主版本：走既有 deploy {versionId} 回滚机制重建主容器，
   * 成功派发后解散复制集（成员使命完成，退回普通模式）。
   */
  router.post('/branches/:branchId/replica-sets/:profileId/members/:memberId/promote', async (req, res) => {
    const access = guard(req, req.params.branchId);
    if (access) { res.status(access.status).json(access.body); return; }
    const branch = deps.stateService.getBranch(req.params.branchId)!;
    const rs = branch.replicaSets?.[req.params.profileId];
    const member = rs?.members.find((m) => m.id === req.params.memberId);
    if (!rs || !member) { res.status(404).json({ error: '成员不存在' }); return; }
    const version = deps.deploymentVersionService.get(member.versionId);
    if (!version) { res.status(404).json({ error: `部署版本不存在: ${member.versionId}` }); return; }
    try {
      deps.deploymentVersionService.assertReusable(version);
    } catch (err) {
      res.status(409).json({ error: 'deployment_version_not_reusable', message: (err as Error).message });
      return;
    }
    const result = await deps.dispatchVersion(version, 'rollback');
    if (!result.accepted) {
      res.status(result.status || 500).json({ error: result.error || '版本部署未被接受' });
      return;
    }
    await deps.replicaSetService.dissolve(req.params.branchId, req.params.profileId);
    res.status(202).json({
      accepted: true,
      promotedVersionId: version.id,
      runId: result.runId,
      streamUrl: result.runId ? `/api/deployment-runs/${result.runId}/stream` : undefined,
    });
  });

  return router;
}

function respondError(res: { status: (code: number) => { json: (body: unknown) => void } }, err: unknown): void {
  if (err instanceof ReplicaSetError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: (err as Error).message });
}
