import { Router, type Request, type Response } from 'express';
import type { StateService } from '../services/state.js';
import { isReleaseApplicant, ReleaseGovernanceError, type ReleaseGovernanceService } from '../services/release-governance.js';
import { isAuthenticatedHuman } from '../services/human-auth.js';
import { resolveReleaseActorFromRequest } from '../services/release-actor.js';
import { canHumanAccessProject, isScopedHuman } from '../services/human-project-access.js';
import type { ReleaseApprovalDetail, ReleaseApprovalInbox } from '../domain/release-governance.js';
import { assertProjectAccess } from './projects.js';

export function createReleaseGovernanceRouter(state: StateService, governance: ReleaseGovernanceService): Router {
  const router = Router();
  const access = (req: Request, res: Response, projectId?: string, write = false, human = false): boolean => {
    if (!projectId || !state.getProject(projectId)) { res.status(404).json({ error: '项目或发布记录不存在' }); return false; }
    const denied = assertProjectAccess(req as any, projectId);
    if (denied) { res.status(denied.status).json(denied.body); return false; }
    if (human && !isAuthenticatedHuman(req)) { res.status(403).json({ error: '此操作需要真实登录的人类账号' }); return false; }
    if (write && !isAuthenticatedHuman(req) && !(req as any).cdsProjectKey) {
      res.status(403).json({ error: '请使用项目执行凭据或真实账号，不能使用全局凭据修改发布治理' }); return false;
    }
    return true;
  };
  const execute = (handler: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { res.json(await handler(req)); }
    catch (error) {
      const message = error instanceof ReleaseGovernanceError ? error.message : '发布治理服务暂时不可用，尚未放行；请刷新后重试';
      res.status(error instanceof ReleaseGovernanceError ? 409 : 503).json({
        code: error instanceof ReleaseGovernanceError ? 'release_governance_rejected' : 'release_governance_unavailable', error: message, message,
      });
    }
  };
  router.get('/releases/governance', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    if (access(req, res, projectId)) res.json(governance.list(projectId!));
  });
  router.get('/releases/approval-inbox', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const target = typeof req.query.targetId === 'string' ? state.getReleaseTarget(req.query.targetId) : undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    if (!target || target.projectId !== projectId) {
      res.status(404).json({ error: '未找到该环境的审批列表' }); return;
    }
    if (!access(req, res, projectId, false, true)) return;
    if (!canHumanAccessProject(req, state, target.projectId)) {
      res.status(403).json({ error: '无权查看这个环境的审批' }); return;
    }
    const actor = resolveReleaseActorFromRequest(req);
    const detail: ReleaseApprovalInbox = {
      target: { name: target.name, environment: target.environment },
      records: Object.values(state.getReleaseGovernance().authorizations)
        .filter(record => record.projectId === target.projectId && record.targetId === target.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(({ id, branchName, kind, action, candidateSha, requestedBy, createdAt, expiresAt, status, consumedBy, decidedBy, reason }) => {
          const applicant = isReleaseApplicant(actor, requestedBy);
          return { id, branchName, kind, action, candidateSha, requestedBy, createdAt, expiresAt, status, consumedBy, decidedBy,
            purpose: reason.replace(/\s+/g, ' ').trim().slice(0, 120), applicant, mayReview: !applicant && target.governance?.required === true && target.isEnabled };
        }),
    };
    res.json(detail);
  });
  router.get('/releases/authorizations/:id', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const record = state.getReleaseGovernance().authorizations[req.params.id];
    if (!record || !access(req, res, record.projectId, false, true)) {
      if (!record) res.status(404).json({ error: '审批申请不存在' });
      return;
    }
    if (!canHumanAccessProject(req, state, record.projectId)) {
      res.status(403).json({ error: '无权查看这笔申请' }); return;
    }
    const target = state.getReleaseTarget(record.targetId);
    if (!target || target.projectId !== record.projectId) {
      res.status(404).json({ error: '申请对应的环境已不存在' }); return;
    }
    const applicant = isReleaseApplicant(resolveReleaseActorFromRequest(req), record.requestedBy);
    const { id, projectId, targetId, branchId, branchName, kind, action, rollbackReleaseId, deploymentVersionId,
      candidateSha, mainSha, allowedPaths, requestedBy, scheduledJobId, reason, expiresAt, status, decidedBy,
      decidedAt, decisionReason, consumedBy, decisions } = record;
    const detail: ReleaseApprovalDetail = {
      authorization: { id, projectId, targetId, branchId, branchName, kind, action, rollbackReleaseId, deploymentVersionId,
        candidateSha, mainSha, allowedPaths, requestedBy, scheduledJobId, reason, expiresAt, status, decidedBy,
        decidedAt, decisionReason, consumedBy, decisions },
      target: { name: target.name, environment: target.environment },
      viewer: { applicant, mayReview: !applicant && target.governance?.required === true && target.isEnabled,
        mayReapply: applicant && !isScopedHuman(req) && target.governance?.required === true && target.isEnabled },
    };
    res.json(detail);
  });
  router.post('/releases/targets/:id/governance/enable', async (req, res) => {
    if (!access(req, res, state.getReleaseTarget(req.params.id)?.projectId, true, true)) return;
    await execute(async request => { await governance.enable(request.params.id, resolveReleaseActorFromRequest(request)); return { ok: true }; })(req, res);
  });
  router.post('/releases/targets/:id/conflict-check', async (req, res) => {
    if (!access(req, res, state.getReleaseTarget(req.params.id)?.projectId, true)) return;
    await execute(async request => ({ check: await governance.inspect(request.params.id,
      typeof request.body?.branchId === 'string' ? request.body.branchId : undefined) }))(req, res);
  });
  router.post('/releases/targets/:id/authorizations', async (req, res) => {
    if (!access(req, res, state.getReleaseTarget(req.params.id)?.projectId, true)) return;
    const body = req.body || {};
    if (!['single','debug'].includes(body.kind) || !['release','rollback',undefined].includes(body.action)
      || typeof body.branchId !== 'string' || typeof body.expiresAt !== 'string') {
      res.status(400).json({ error: '请选择分支、授权类型、操作和有效期' }); return;
    }
    await execute(async request => ({ authorization: await governance.request({ targetId: request.params.id,
      branchId: body.branchId, kind: body.kind, action: body.action, rollbackReleaseId: body.rollbackReleaseId,deploymentVersionId:body.deploymentVersionId,
      expiresAt: body.expiresAt, allowedPaths: body.allowedPaths, scheduledJobId: body.scheduledJobId,
      reason: body.reason, actor: resolveReleaseActorFromRequest(request) }) }))(req, res);
  });
  for (const [action, decision] of [['approve','approved'],['reject','rejected'],['revoke','revoked']] as const) {
    router.post(`/releases/authorizations/:id/${action}`, async (req, res) => {
      const record = state.getReleaseGovernance().authorizations[req.params.id];
      if (!access(req, res, record?.projectId, true, decision !== 'revoked')) return;
      if (!record || !canHumanAccessProject(req, state, record.projectId)) {
        res.status(403).json({ error: '无权处理这笔申请' }); return;
      }
      await execute(async request => ({ authorization: await governance.decide(request.params.id, decision,
        resolveReleaseActorFromRequest(request), request.body?.reason, () => canHumanAccessProject(request, state, record.projectId)) }))(req, res);
    });
  }
  router.post('/releases/targets/:id/merge-back', async (req, res) => {
    if (!access(req, res, state.getReleaseTarget(req.params.id)?.projectId, true)) return;
    await execute(async request => ({ mergeBack: await governance.linkMergeBack(request.params.id, request.body?.number,
      request.body?.owner, resolveReleaseActorFromRequest(request), request.body?.sourceSha) }))(req, res);
  });
  router.post('/releases/merge-backs/:id/refresh', async (req, res) => {
    const record = state.getReleaseGovernance().mergeBacks[req.params.id];
    if (!access(req, res, record?.projectId, true)) return;
    await execute(async request => ({ mergeBack: await governance.refreshMergeBack(request.params.id, resolveReleaseActorFromRequest(request)) }))(req, res);
  });
  return router;
}
