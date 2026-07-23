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
      const { replicaSets, candidates } = deps.replicaSetService.list(req.params.branchId);
      res.json({ replicaSets, candidates, memberLimit: REPLICA_MEMBER_LIMIT });
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
    if (!versionId) { res.status(400).json({ error: '缺少 versionId' }); return; }
    try {
      const member = deps.replicaSetService.addMember(req.params.branchId, req.params.profileId, {
        versionId,
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
