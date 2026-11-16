import { Router } from 'express';
import { isAuthenticatedHuman, isHumanSystemOwner } from '../services/human-auth.js';
import type { OwnedResourceLifecycle } from '../services/owned-resource-task.js';
import type { StateService } from '../services/state.js';
import path from 'node:path';
import fs from 'node:fs/promises';

/** Only fixed, host-configured resource catalogs are reachable here. No creation or shell RPC. */
export function createOwnedResourceRetentionRouter(service?: OwnedResourceLifecycle, state?: StateService, images?: import('../services/image-cache-governance.js').ImageCacheGovernance, worktreeBase?: string): Router {
  const router = Router();
  router.use('/janitor/tasks', (req, res, next) => {
    if (!service) { res.status(503).json({ error: '验收资源清单未接入，占用未知。' });return; }
    if ((req as any).cdsProjectKey || (isAuthenticatedHuman(req) && !isHumanSystemOwner(req)) || (req.method !== 'GET' && !isHumanSystemOwner(req))) {
      res.status(403).json({ error: '全局验收资源退役需要系统所有者操作，Agent不能自批。' });return;
    }
    next();
  });
  router.get('/janitor/tasks', async (req, res) => {
    try { res.json({ ...await service!.inspect(), canExecute: isHumanSystemOwner(req) }); }
    catch { res.status(503).json({ error: '宿主资源或引用核查未完成，相关对象保持保留。' }); }
  });
  router.get('/janitor/tasks/state', (req, res) => res.json({ execution: service!.getSnapshot(), canExecute: isHumanSystemOwner(req) }));
  router.get('/janitor/tasks/images', async (req, res) => {
    if (!images) { res.status(503).json({ error: '镜像ID盘点未接入，占用未知。' });return; }
    try { res.json({ ...await images.inspect(), enabled: images.options.budgetBytes > 0, canAdopt: isHumanSystemOwner(req), canExecute: isHumanSystemOwner(req) && images.options.budgetBytes > 0 }); }
    catch { res.status(503).json({ error: '镜像或引用盘点未完成，未知对象已保留。' }); }
  });
  router.get('/janitor/tasks/images/state', (req, res) => res.json({ execution: images?.getSnapshot(), canAdopt: isHumanSystemOwner(req), canExecute: isHumanSystemOwner(req) && Boolean(images?.options.budgetBytes) }));
  router.get('/janitor/tasks/images/owners', (_req, res) => res.json({ projects: state?.getProjects().map(project => ({ id: project.id, name: project.name })) || [] }));
  router.post('/janitor/tasks/images/adopt', async (req, res) => {
    const { identity, created, aliases, digests, projectId, ownershipEvidence, dataDisposition } = req.body || {};
    if (!images || typeof identity !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(identity) || typeof created !== 'string'
      || ![aliases,digests].every(values=>Array.isArray(values)&&values.length<=100&&values.every(item=>typeof item==='string'&&item.length<=512))
      || typeof projectId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(projectId) || typeof ownershipEvidence !== 'string' || !ownershipEvidence.trim() || ownershipEvidence.length>2000
      || dataDisposition !== 'reproducible-artifact') { res.status(400).json({ error: '需要固定镜像身份、完整别名、项目和不含业务数据的可再生成产物依据。' });return; }
    try { res.json(await images.adopt({ identity, created, aliases, digests, projectId, ownershipEvidence, dataDisposition,
      attestedBy: String((req as any).cdsUser.id || (req as any).cdsUser.username || 'system-owner') })); }
    catch { res.status(409).json({ error: '归属、身份、registry 内容或持久审计未确认，镜像保持保护。' }); }
  });
  router.post('/janitor/tasks/images/reconcile', (_req, res) => {
    if (!images?.options.budgetBytes) { res.status(409).json({ error: '宿主镜像预算尚未启用，需先审查容量与保留需求。' });return; }
    try { res.status(202).json({ execution: images.startReconcile() }); }
    catch { res.status(409).json({ error: '镜像回收正在执行。' }); }
  });
  router.post('/janitor/tasks/images/cancel', async (req, res) => {
    if (!images || typeof req.body?.id !== 'string' || !/^[a-f0-9]{32}$/.test(req.body.id)) { res.status(400).json({ error: '需要当前镜像回收任务身份。' });return; }
    try { res.json(await images.cancel(req.body.id)); }
    catch { res.status(409).json({ error: '停止请求未确认，当前批次仍受时限保护。' }); }
  });
  router.get('/janitor/tasks/data-cases', (_req, res) => res.json({ cases: state?.getLegacyDataCases() || [], notice: '仅记录归属与处置队列，不授予业务数据删除或生产迁移权限。' }));
  router.post('/janitor/tasks/data-cases/:id/confirm', async (req, res) => {
    const { disposition, note } = req.body || {};
    if (!state || !['business-data', 'ephemeral-test', 'unknown'].includes(disposition) || typeof note !== 'string' || !note.trim() || note.length > 2000) { res.status(400).json({ error: '需要明确归属、处置说明及系统所有者身份。' });return; }
    try {
      const entry = state.getLegacyDataCases().find(item => item.id === String(req.params.id));
      if (!entry || !worktreeBase || !entry.birthtimeMs || !Number.isSafeInteger(entry.device) || !Number.isSafeInteger(entry.inode)) throw new Error('identity-unconfirmed');
      const base = path.resolve(worktreeBase), location = path.resolve(base, entry.dataIdentity);
      if (!location.startsWith(base + path.sep) || await fs.realpath(base) !== base || await fs.realpath(location) !== location) throw new Error('identity-unconfirmed');
      const current = await fs.lstat(location);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== entry.device || current.ino !== entry.inode || current.birthtimeMs !== entry.birthtimeMs) throw new Error('identity-changed');
      res.json({ case: state.confirmLegacyDataCase(String(req.params.id), disposition, String((req as any).cdsUser.id || 'system-owner'), note) });
    }
    catch { res.status(409).json({ error: '对象身份未确认，请重新盘点。' }); }
  });
  router.post('/janitor/tasks/reconcile', (_req, res) => {
    try { res.status(202).json({ execution: service!.startReconcile() }); }
    catch { res.status(409).json({ error: '已有回收任务正在执行，请查看进度。' }); }
  });
  router.post('/janitor/tasks/cancel', async (req, res) => {
    if (typeof req.body?.id !== 'string' || !/^[a-f0-9]{32}$/.test(req.body.id)) { res.status(400).json({ error: '需要当前回收任务身份。' });return; }
    try { res.json(await service!.cancel(req.body.id)); }
    catch { res.status(409).json({ error: '停止请求未确认，当前批次仍受时限保护。' }); }
  });
  return router;
}
