import { Router } from 'express';
import { isAuthenticatedHuman, isHumanSystemOwner } from '../services/human-auth.js';
import type { BackupRetentionService } from '../services/backup-retention.js';

export function createBackupRetentionRouter(service?: BackupRetentionService): Router {
  const router = Router();
  router.use('/janitor/backups', (req, res, next) => {
    if (!service) { res.status(503).json({ error: '本实例未接入宿主备份回收；无法判断占用。' }); return; }
    if ((req as any).cdsProjectKey || (isAuthenticatedHuman(req) && !isHumanSystemOwner(req))) {
      res.status(403).json({ error: '全局备份盘点需要系统所有者或全局诊断授权。' }); return;
    }
    if (req.method !== 'GET' && !isHumanSystemOwner(req)) {
      res.status(403).json({ error: '备份退役和归属登记需要系统所有者操作，Agent不能自批。' }); return;
    }
    next();
  });
  router.get('/janitor/backups', async (req, res) => {
    try { res.json({ ...await service!.inspect(true), canExecute: isHumanSystemOwner(req) }); }
    catch { res.status(503).json({ error: '备份盘点未完成，未知对象保持保留。' }); }
  });
  router.get('/janitor/backups/state', (req, res) => res.json({ execution: service!.getSnapshot(), canExecute: isHumanSystemOwner(req) }));
  router.get('/janitor/backups/owners', (_req, res) => res.json(service!.ownershipOptions()));
  router.post('/janitor/backups/reconcile', (req, res) => {
    const maxRemovals = req.body?.maxRemovals ?? 8;
    if (!Number.isInteger(maxRemovals) || maxRemovals < 1 || maxRemovals > 20) { res.status(400).json({ error: '单批数量必须在1至20之间。' }); return; }
    try { res.status(202).json({ execution: service!.startReconcile(maxRemovals) }); }
    catch { res.status(409).json({ error: '已有回收任务正在执行，请查看当前进度。' }); }
  });
  router.post('/janitor/backups/cancel', async (req, res) => {
    const id = req.body?.id;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) { res.status(400).json({ error: '需要当前回收任务的身份。' }); return; }
    try { await service!.cancel(id); res.json({ stopRequested: true }); }
    catch { res.status(409).json({ error: '停止请求未确认，请刷新任务进度；未执行对象保持保护。' }); }
  });
  router.post('/janitor/backups/adopt', async (req, res) => {
    const { path, projectId, serviceId, origin, disposition = 'business-backup', dispositionReason, lineageAttestation } = req.body || {};
    if (![path, projectId, serviceId].every(value => typeof value === 'string' && value.length > 0 && value.length < 4096)
      || !['historical', 'manual', 'pre-restore'].includes(origin)) { res.status(400).json({ error: '请明确文件、项目、资源及备份来源。' }); return; }
    if (!['business-backup','reproducible-artifact'].includes(disposition) || (disposition === 'reproducible-artifact' && (typeof dispositionReason !== 'string' || !dispositionReason.trim() || dispositionReason.length > 2000))) { res.status(400).json({ error: '可再生成测试备份须明确确认不含业务数据，并说明依据。' });return; }
    if (lineageAttestation !== undefined && (typeof lineageAttestation !== 'string' || !lineageAttestation.trim() || lineageAttestation.length > 2000)) { res.status(400).json({ error: '关联当前物理来源须提供原备份记录的核对依据。' });return; }
    try { await service!.register(path, projectId, serviceId, origin, { disposition, dispositionReason, lineageAttestation,
      attestedBy: String((req as any).cdsUser?.id || (req as any).cdsUser?.username || 'system-owner') }); res.json({ registered: true }); }
    catch { res.status(409).json({ error: '归属或完整性未通过核查，文件已保留且未纳入删除候选。' }); }
  });
  return router;
}
