import { Router } from 'express';
import type { StateService } from '../services/state.js';
import type { BranchEntry } from '../types.js';
import type { BranchOperationCoordinator } from '../services/branch-operation-coordinator.js';
import { assertProjectAccess } from './projects.js';
import { resolveActorFromRequest } from '../services/actor-resolver.js';
import { isPreviewInstance } from '../services/preview-instance.js';
import { normalizeProjectProfileDependencies } from '../services/project-profile-dependencies.js';

export function createBranchServiceIsolationRouter(state: StateService, coordinator?: BranchOperationCoordinator,
  observeStopped?: (branch: BranchEntry, excluded: string[]) => Promise<void>): Router {
  const router = Router();
  const view = (branch: BranchEntry) => ({
    branchId: branch.id, projectId: branch.projectId,
    revision: state.getBranchServiceIsolationRevision(branch),
    excludedProjectProfileIds: branch.excludedProjectProfileIds || [],
    effectiveProfiles: normalizeProjectProfileDependencies(state.getEffectiveProfilesForBranch(branch),
      state.getProject(branch.projectId)?.slug ? `-${state.getProject(branch.projectId)!.slug}` : '', branch.profileOverrides).map(p => ({
      id: p.id, dependsOn: p.dependsOn ?? [],
    })),
  });
  router.get('/branches/:id/service-isolation', (req, res) => {
    const branch = state.getBranch(req.params.id);
    if (!branch) { res.status(404).json({ error: '分支不存在' }); return; }
    const denied = assertProjectAccess(req as any, branch.projectId);
    if (denied) { res.status(denied.status).json(denied.body); return; }
    res.json(view(branch));
  });
  router.put('/branches/:id/service-isolation', async (req, res) => {
    const branch = state.getBranch(req.params.id);
    if (!branch) { res.status(404).json({ error: '分支不存在' }); return; }
    const denied = assertProjectAccess(req as any, branch.projectId);
    if (denied) { res.status(denied.status).json(denied.body); return; }
    if (isPreviewInstance() || branch.mirror) { res.status(409).json({ error: '只读实例不能调整分支隔离' }); return; }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(k => !['expectedRevision', 'excludedProjectProfileIds', 'dependsOnOverrides'].includes(k))
      || typeof body.expectedRevision !== 'string' || !Array.isArray(body.excludedProjectProfileIds)) {
      res.status(400).json({ error: '请提交读取到的配置版本、排除清单和必要的依赖覆盖' }); return;
    }
    if (!coordinator || !observeStopped) { res.status(503).json({ error: '分支操作互斥或运行观察不可用' }); return; }
    // Never supersede or cancel a queued/running deployment to change configuration.
    if (coordinator.getActiveOperations(branch.id).length || coordinator.getPendingWebhookDeploy(branch.id)) {
      res.status(409).json({ error: '本分支仍有未完成操作，请先对账' }); return;
    }
    const admission = coordinator.begin({ branchId: branch.id, projectId: branch.projectId,
      kind: 'configure-services', trigger: 'manual', actor: resolveActorFromRequest(req),
      requestId: String((req as any).cdsRequestId || ''), source: 'service-isolation',
    }, { requireImmediate: true });
    if (admission.status !== 'started' || !admission.lease) {
      res.status(409).json({ error: '分支正在处理其他操作，请稍后读取状态' }); return;
    }
    let changed = false;
    try {
      if (branch.executorId || branch.mirror) throw new Error('远端或镜像分支须先按原执行器路径对账');
      await observeStopped(branch, body.excludedProjectProfileIds);
      admission.lease.assertCurrent('service-isolation-observed');
      const updated = state.setBranchServiceIsolation(branch.id, body);
      changed = true;
      await state.flush();
      res.json(view(updated));
      coordinator.completeAll(admission.lease, 'completed');
    } catch (error) {
      coordinator.completeAll(admission.lease, 'failed');
      const unknown = changed || (error instanceof Error && error.message === 'service_isolation_save_unconfirmed');
      res.status(unknown ? 503 : 409).json({ error: unknown
        ? '保存结果尚未确认，请先读取本分支状态，不要直接重试'
        : error instanceof Error ? error.message : '分支隔离校验失败' });
    }
  });
  return router;
}
