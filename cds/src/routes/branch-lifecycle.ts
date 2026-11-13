import { Router } from 'express';
import type { StateService } from '../services/state.js';
import type { BranchLifecycleService } from '../services/branch-lifecycle.js';
import { assertProjectAccess } from './projects.js';
import { resolveActorFromRequest } from '../services/actor-resolver.js';
import { isPreviewInstance } from '../services/preview-instance.js';

export function createBranchLifecycleRouter(state: StateService, lifecycle: BranchLifecycleService): Router {
  const router = Router();
  router.post('/projects/:projectId/branches/lifecycle-cleanup', async (req, res) => {
    if (isPreviewInstance()) { res.status(409).json({ error: '只读预览实例不能清理分支' }); return; }
    const projectId = req.params.projectId;
    if (!projectId || !state.getProject(projectId)) { res.status(400).json({ error: '请明确选择有效项目' }); return; }
    const mismatch = assertProjectAccess(req as any, projectId);
    if (mismatch) { res.status(mismatch.status).json(mismatch.body); return; }
    const mode = req.body?.mode;
    if (mode !== 'all' && mode !== 'incomplete') { res.status(400).json({ error: '不支持的清理范围' }); return; }
    if (req.body?.dryRun === true) { res.json(lifecycle.preview(projectId, mode)); return; }
    if (req.body?.confirm !== true) { res.status(400).json({ error: '执行前请确认清理范围' }); return; }
    try { res.json(await lifecycle.cleanup(projectId, mode, resolveActorFromRequest(req))); }
    catch { res.status(503).json({ error: '清理未完成，请刷新后查看记录' }); }
  });
  router.post('/projects/:projectId/branches/:id/restore-archive', async (req, res) => {
    if (isPreviewInstance()) { res.status(409).json({ error: '只读预览实例不能恢复归档' }); return; }
    const branch = state.getBranch(req.params.id);
    if (!branch) { res.status(404).json({ error: '分支不存在' }); return; }
    if ((branch.projectId || 'default') !== req.params.projectId) { res.status(404).json({ error: '项目中没有该分支' }); return; }
    const mismatch = assertProjectAccess(req as any, branch.projectId || 'default');
    if (mismatch) { res.status(mismatch.status).json(mismatch.body); return; }
    try { await lifecycle.restore(branch.id, resolveActorFromRequest(req)); res.json({ ok: true }); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : '恢复未完成' }); }
  });
  return router;
}
