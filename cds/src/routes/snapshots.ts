/**
 * 配置快照 / 破坏性操作审计路由
 *
 * 解决的用户痛点："导入配置后项目污染了好几十回，每次都要手工回滚"。
 *
 * 提供三类端点：
 *   1. 配置快照（ConfigSnapshot）—— 导入前自动拍 + 手动拍 + 一键回滚
 *      GET    /api/config-snapshots           列表
 *      GET    /api/config-snapshots/:id       详情
 *      POST   /api/config-snapshots           手动创建当前快照
 *      POST   /api/config-snapshots/:id/rollback  回滚到该快照
 *      DELETE /api/config-snapshots/:id       删除旧快照
 *
 *   2. 破坏性操作日志（DestructiveOperationLog）—— 紧急还原抽屉
 *      GET    /api/destructive-ops            最近 100 条
 *      POST   /api/destructive-ops/:id/undo   撤销（30 分钟内有效）
 */
import { Router } from 'express';
import type { StateService } from '../services/state.js';

export interface SnapshotsRouterDeps {
  stateService: StateService;
}

export function createSnapshotsRouter(deps: SnapshotsRouterDeps): Router {
  const { stateService } = deps;
  const router = Router();

  // ── ConfigSnapshot ──

  router.get('/config-snapshots', (req, res) => {
    const projectId = req.query.projectId as string | undefined;
    // projectId 为空字符串视为"全部"
    const filter = projectId === undefined || projectId === '' ? undefined : projectId;
    const list = stateService.getConfigSnapshots(filter);
    // 倒序 + 去掉 payload（列表不传大字段）
    const stripped = list
      .slice()
      .reverse()
      .map(s => ({
        id: s.id,
        createdAt: s.createdAt,
        projectId: s.projectId ?? null,
        trigger: s.trigger,
        label: s.label,
        triggeredBy: s.triggeredBy,
        sizeBytes: s.sizeBytes ?? 0,
        counts: {
          buildProfiles: s.payload.buildProfiles.length,
          infraServices: s.payload.infraServices.length,
          routingRules: s.payload.routingRules.length,
          envVarScopes: Object.keys(s.payload.customEnv).length,
        },
      }));
    res.json({ snapshots: stripped, total: list.length, limit: 30 });
  });

  router.get('/config-snapshots/:id', (req, res) => {
    const s = stateService.getConfigSnapshot(req.params.id);
    if (!s) {
      res.status(404).json({ error: `快照不存在: ${req.params.id}` });
      return;
    }
    res.json(s);
  });

  router.post('/config-snapshots', (req, res) => {
    const { label, projectId, triggeredBy } = req.body as { label?: string; projectId?: string | null; triggeredBy?: string };
    const snapshot = stateService.createConfigSnapshot({
      trigger: 'manual',
      label: label || `手动保存 · ${new Date().toLocaleString('zh-CN')}`,
      projectId: projectId ?? null,
      triggeredBy,
    });
    res.status(201).json({ snapshot, message: '已保存当前配置为快照' });
  });

  router.post('/config-snapshots/:id/rollback', (req, res) => {
    try {
      const target = stateService.rollbackToConfigSnapshot(
        req.params.id,
        (req.body?.triggeredBy as string) || undefined,
      );
      // 同时记录一条破坏性操作（回滚本身就是破坏性行为）
      stateService.recordDestructiveOp({
        type: 'other',
        projectId: target.projectId ?? null,
        snapshotId: target.id,
        summary: `回滚到快照「${target.label}」（${new Date(target.createdAt).toLocaleString('zh-CN')}）`,
        triggeredBy: (req.body?.triggeredBy as string) || undefined,
      });
      res.json({ rolledBack: true, snapshot: { id: target.id, label: target.label }, message: `已回滚到「${target.label}」` });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete('/config-snapshots/:id', (req, res) => {
    const removed = stateService.deleteConfigSnapshot(req.params.id);
    if (!removed) {
      res.status(404).json({ error: '快照不存在' });
      return;
    }
    res.json({ deleted: true });
  });

  // ── DestructiveOperationLog ──

  router.get('/destructive-ops', (_req, res) => {
    const ops = stateService.getDestructiveOps();
    const enriched = ops
      .slice()
      .reverse()
      .map(op => ({ ...op, canUndo: stateService.isDestructiveOpUndoable(op) }));
    res.json({ ops: enriched, undoWindowMinutes: Math.floor((30 * 60 * 1000) / 60000) });
  });

  router.post('/destructive-ops/:id/undo', (req, res) => {
    const op = stateService.getDestructiveOps().find(o => o.id === req.params.id);
    if (!op) {
      res.status(404).json({ error: '操作记录不存在' });
      return;
    }
    if (!stateService.isDestructiveOpUndoable(op)) {
      res.status(400).json({ error: '操作已超过 30 分钟撤销窗口，或已被撤销过' });
      return;
    }

    // 需要关联的 ConfigSnapshot 才能撤销配置层面的改动
    if (!op.snapshotId) {
      res.status(400).json({ error: '该操作没有关联快照，无法自动撤销。请查看配置历史手动选择版本回滚。' });
      return;
    }

    try {
      stateService.rollbackToConfigSnapshot(op.snapshotId, (req.body?.triggeredBy as string) || undefined);
      stateService.markDestructiveOpUndone(op.id);
      res.json({ undone: true, message: `已通过回滚快照撤销「${op.summary}」` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
